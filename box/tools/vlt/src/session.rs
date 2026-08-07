//! Local session cache: store the master password for `TTL` after a
//! successful unlock so the next launch auto-unlocks without prompting.
//!
//! Two storage formats are supported, picked at write time based on what the
//! environment can offer:
//!
//! 1. **Encrypted** — preferred. The cache payload is encrypted with
//!    ChaCha20-Poly1305 using a per-machine wrap key persisted in the OS
//!    keyring (macOS Keychain / Linux Secret Service / Windows Credential
//!    Manager). A stolen cache file alone is useless without keyring access.
//!
//! 2. **Plaintext fallback** — when the keyring is unavailable (headless
//!    Linux without secret service, locked Keychain that refused access,
//!    etc.) the master is written in clear text. The file is still chmod
//!    0600 and bound to the vault path so it cannot be reused on another
//!    machine or against another vault. Same trust model as
//!    `~/.aws/credentials`.
//!
//! Both formats include `expires_at` and a `vault_path` binding. The TTL
//! defaults to one hour and can be overridden with `VLT_SESSION_TTL_SECONDS`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use chacha20poly1305::{ChaCha20Poly1305, Key, KeyInit, Nonce, aead::Aead};
use serde::{Deserialize, Serialize};

pub const TTL: Duration = Duration::from_secs(3600);

const KEYRING_SERVICE: &str = "io.younsl.vlt";
const KEYRING_ACCOUNT: &str = "session-wrap-key";
const NONCE_LEN: usize = 12;
const WRAP_KEY_LEN: usize = 32;

#[derive(Serialize, Deserialize)]
struct CacheFile {
    expires_at: i64,
    vault_path: String,
    #[serde(flatten)]
    payload: Payload,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Payload {
    Wrapped {
        nonce_b64: String,
        ciphertext_b64: String,
    },
    Plain {
        master: String,
    },
}

/// Outcome of a cache lookup on launch.
pub enum LoadResult {
    Hit { master: String, encrypted: bool },
    Miss,
}

/// Outcome of a cache write after a successful unlock.
pub enum SaveOutcome {
    /// Cache written and encrypted via the OS keyring.
    Encrypted,
    /// Cache written but the keyring was unavailable, so the master sits in
    /// a 0600 plaintext file.
    Plaintext,
    /// Cache could not be written at all.
    Failed,
}

fn ttl() -> Duration {
    std::env::var("VLT_SESSION_TTL_SECONDS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .map(Duration::from_secs)
        .unwrap_or(TTL)
}

fn cache_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("VLT_SESSION_PATH").filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let base = std::env::var_os("XDG_CACHE_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|s| !s.is_empty())
                .map(|h| PathBuf::from(h).join(".cache"))
        })?;
    Some(base.join("vlt").join("session.json"))
}

/// Fetch (or create) the per-machine wrap key from the OS keyring. Returns
/// `None` if the keyring is unavailable for any reason.
fn try_wrap_key() -> Option<[u8; WRAP_KEY_LEN]> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).ok()?;
    match entry.get_password() {
        Ok(stored) => {
            let bytes = B64.decode(stored.as_bytes()).ok()?;
            if bytes.len() != WRAP_KEY_LEN {
                return None;
            }
            let mut k = [0u8; WRAP_KEY_LEN];
            k.copy_from_slice(&bytes);
            Some(k)
        }
        Err(keyring::Error::NoEntry) => {
            let mut k = [0u8; WRAP_KEY_LEN];
            getrandom::fill(&mut k).ok()?;
            entry.set_password(&B64.encode(k)).ok()?;
            Some(k)
        }
        Err(_) => None,
    }
}

fn drop_cache(path: &Path) {
    let _ = std::fs::remove_file(path);
}

pub fn load(vault_path: &Path) -> LoadResult {
    let Some(path) = cache_path() else {
        return LoadResult::Miss;
    };
    let Ok(raw) = std::fs::read(&path) else {
        return LoadResult::Miss;
    };
    let cache: CacheFile = match serde_json::from_slice(&raw) {
        Ok(c) => c,
        Err(_) => {
            // Old/unknown layout — toss it.
            drop_cache(&path);
            return LoadResult::Miss;
        }
    };

    let now = chrono::Utc::now().timestamp();
    if cache.expires_at <= now {
        drop_cache(&path);
        return LoadResult::Miss;
    }
    if cache.vault_path != vault_path.display().to_string() {
        drop_cache(&path);
        return LoadResult::Miss;
    }

    match cache.payload {
        Payload::Plain { master } => LoadResult::Hit {
            master,
            encrypted: false,
        },
        Payload::Wrapped {
            nonce_b64,
            ciphertext_b64,
        } => {
            // We need the wrap key from the keyring. If unavailable now (e.g.
            // user denied a Keychain prompt this session), the wrapped cache
            // is unusable — drop it and treat as a miss so the user is
            // prompted again and a fresh cache is written, possibly using the
            // plaintext fallback.
            let Some(key) = try_wrap_key() else {
                return LoadResult::Miss;
            };
            let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
            let Ok(nonce_bytes) = B64.decode(nonce_b64.as_bytes()) else {
                drop_cache(&path);
                return LoadResult::Miss;
            };
            if nonce_bytes.len() != NONCE_LEN {
                drop_cache(&path);
                return LoadResult::Miss;
            }
            let nonce = Nonce::from_slice(&nonce_bytes);
            let Ok(ct) = B64.decode(ciphertext_b64.as_bytes()) else {
                drop_cache(&path);
                return LoadResult::Miss;
            };
            let Ok(plain) = cipher.decrypt(nonce, ct.as_ref()) else {
                drop_cache(&path);
                return LoadResult::Miss;
            };
            match String::from_utf8(plain) {
                Ok(master) => LoadResult::Hit {
                    master,
                    encrypted: true,
                },
                Err(_) => {
                    drop_cache(&path);
                    LoadResult::Miss
                }
            }
        }
    }
}

pub fn save(master: &str, vault_path: &Path) -> SaveOutcome {
    let Some(path) = cache_path() else {
        return SaveOutcome::Failed;
    };
    if let Some(parent) = path.parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        return SaveOutcome::Failed;
    }

    let (payload, encrypted) = match try_wrap_key() {
        Some(key) => {
            let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
            let mut nonce_bytes = [0u8; NONCE_LEN];
            if getrandom::fill(&mut nonce_bytes).is_err() {
                return SaveOutcome::Failed;
            }
            let nonce = Nonce::from_slice(&nonce_bytes);
            let Ok(ct) = cipher.encrypt(nonce, master.as_bytes()) else {
                return SaveOutcome::Failed;
            };
            (
                Payload::Wrapped {
                    nonce_b64: B64.encode(nonce_bytes),
                    ciphertext_b64: B64.encode(ct),
                },
                true,
            )
        }
        None => (
            Payload::Plain {
                master: master.to_string(),
            },
            false,
        ),
    };

    let cache = CacheFile {
        expires_at: chrono::Utc::now().timestamp() + ttl().as_secs() as i64,
        vault_path: vault_path.display().to_string(),
        payload,
    };
    let Ok(bytes) = serde_json::to_vec(&cache) else {
        return SaveOutcome::Failed;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &bytes).is_err() {
        return SaveOutcome::Failed;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    if std::fs::rename(&tmp, &path).is_err() {
        return SaveOutcome::Failed;
    }
    if encrypted {
        SaveOutcome::Encrypted
    } else {
        SaveOutcome::Plaintext
    }
}

/// Removes the cache file. The keyring wrap key is left in place — it is
/// per-machine infrastructure, not per-session.
pub fn clear() {
    if let Some(path) = cache_path() {
        let _ = std::fs::remove_file(path);
    }
}

