use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use chacha20poly1305::{
    ChaCha20Poly1305, Key, Nonce,
    aead::{Aead, KeyInit},
};
use getrandom::fill as os_fill;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::error::{VltError, VltResult};

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;
pub const SALT_LEN: usize = 16;

const ARGON_M_COST: u32 = 64 * 1024;
const ARGON_T_COST: u32 = 3;
const ARGON_P_COST: u32 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KdfParams {
    pub algorithm: String,
    pub salt_b64: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl KdfParams {
    pub fn new_random() -> Self {
        let mut salt = [0u8; SALT_LEN];
        os_fill(&mut salt).expect("os entropy");
        Self {
            algorithm: "argon2id".to_string(),
            salt_b64: B64.encode(salt),
            memory_kib: ARGON_M_COST,
            iterations: ARGON_T_COST,
            parallelism: ARGON_P_COST,
        }
    }

    fn salt(&self) -> VltResult<Vec<u8>> {
        B64.decode(&self.salt_b64)
            .map_err(|e| VltError::Crypto(format!("salt decode: {e}")))
    }
}

pub struct DerivedKey([u8; KEY_LEN]);

impl DerivedKey {
    fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl Drop for DerivedKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

pub fn derive_key(password: &str, params: &KdfParams) -> VltResult<DerivedKey> {
    if params.algorithm != "argon2id" {
        return Err(VltError::Crypto(format!(
            "unsupported KDF: {}",
            params.algorithm
        )));
    }
    let argon_params = Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism,
        Some(KEY_LEN),
    )
    .map_err(|e| VltError::Crypto(format!("argon params: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let salt = params.salt()?;
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut out)
        .map_err(|e| VltError::Crypto(format!("argon hash: {e}")))?;
    Ok(DerivedKey(out))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sealed {
    pub nonce_b64: String,
    pub ciphertext_b64: String,
}

pub fn seal(key: &DerivedKey, plaintext: &[u8]) -> VltResult<Sealed> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key.as_bytes()));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    os_fill(&mut nonce_bytes).expect("os entropy");
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| VltError::Crypto(format!("encrypt: {e}")))?;
    Ok(Sealed {
        nonce_b64: B64.encode(nonce_bytes),
        ciphertext_b64: B64.encode(ct),
    })
}

pub fn open(key: &DerivedKey, sealed: &Sealed) -> VltResult<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key.as_bytes()));
    let nonce_bytes = B64
        .decode(&sealed.nonce_b64)
        .map_err(|e| VltError::Crypto(format!("nonce decode: {e}")))?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(VltError::Crypto("nonce length".into()));
    }
    let ct = B64
        .decode(&sealed.ciphertext_b64)
        .map_err(|e| VltError::Crypto(format!("ciphertext decode: {e}")))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher
        .decrypt(nonce, ct.as_ref())
        .map_err(|_| VltError::InvalidMasterPassword)
}

pub fn generate_password(length: usize, with_symbols: bool, with_numbers: bool) -> String {
    let mut alphabet: Vec<u8> = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".to_vec();
    if with_numbers {
        alphabet.extend_from_slice(b"0123456789");
    }
    if with_symbols {
        alphabet.extend_from_slice(b"!@#$%^&*()-_=+[]{};:,.<>/?");
    }
    let mut buf = Vec::with_capacity(length);
    let mut chunk = [0u8; 4];
    for _ in 0..length {
        os_fill(&mut chunk).expect("os entropy");
        let idx = u32::from_le_bytes(chunk) as usize % alphabet.len();
        buf.push(alphabet[idx]);
    }
    String::from_utf8(buf).expect("ascii")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let params = KdfParams::new_random();
        let key = derive_key("correct horse battery staple", &params).unwrap();
        let sealed = seal(&key, b"secret payload").unwrap();
        let opened = open(&key, &sealed).unwrap();
        assert_eq!(opened, b"secret payload");
    }

    #[test]
    fn wrong_password_fails() {
        let params = KdfParams::new_random();
        let key = derive_key("right", &params).unwrap();
        let sealed = seal(&key, b"x").unwrap();
        let wrong = derive_key("wrong", &params).unwrap();
        assert!(matches!(
            open(&wrong, &sealed),
            Err(VltError::InvalidMasterPassword)
        ));
    }

    #[test]
    fn generated_password_length() {
        assert_eq!(generate_password(24, true, true).len(), 24);
    }
}
