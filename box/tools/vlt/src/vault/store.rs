use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::crypto::{KdfParams, Sealed, derive_key, open, seal};
use crate::error::{VltError, VltResult};
use crate::vault::item::Item;

const VAULT_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
pub struct VaultFile {
    pub version: u32,
    pub kdf: KdfParams,
    #[serde(flatten)]
    pub sealed: Sealed,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct VaultPayload {
    #[serde(default)]
    pub items: Vec<Item>,
}

pub struct Vault {
    path: PathBuf,
    file: VaultFile,
    payload: VaultPayload,
    password: String,
}

impl Vault {
    pub fn create(path: &Path, master_password: &str) -> VltResult<Self> {
        if path.exists() {
            return Err(VltError::AlreadyInitialized);
        }
        if master_password.len() < 8 {
            return Err(VltError::InvalidInput(
                "master password must be at least 8 characters".into(),
            ));
        }
        let kdf = KdfParams::new_random();
        let key = derive_key(master_password, &kdf)?;
        let payload = VaultPayload::default();
        let sealed = seal(&key, &serde_json::to_vec(&payload)?)?;
        let file = VaultFile {
            version: VAULT_VERSION,
            kdf,
            sealed,
        };
        write_atomic(path, &file)?;
        Ok(Self {
            path: path.to_path_buf(),
            file,
            payload,
            password: master_password.to_string(),
        })
    }

    pub fn open_vault(path: &Path, master_password: &str) -> VltResult<Self> {
        if !path.exists() {
            return Err(VltError::NotInitialized);
        }
        let raw = fs::read(path)?;
        let file: VaultFile = serde_json::from_slice(&raw)?;
        if file.version != VAULT_VERSION {
            return Err(VltError::InvalidInput(format!(
                "unsupported vault version: {}",
                file.version
            )));
        }
        let key = derive_key(master_password, &file.kdf)?;
        let plain = open(&key, &file.sealed)?;
        let payload: VaultPayload = serde_json::from_slice(&plain)?;
        Ok(Self {
            path: path.to_path_buf(),
            file,
            payload,
            password: master_password.to_string(),
        })
    }

    pub fn items(&self) -> &[Item] {
        &self.payload.items
    }

    pub fn find_item(&self, id: &str) -> VltResult<&Item> {
        self.payload
            .items
            .iter()
            .find(|i| i.id == id)
            .ok_or_else(|| VltError::ItemNotFound(id.to_string()))
    }

    pub fn add_item(&mut self, item: Item) {
        self.payload.items.push(item);
    }

    pub fn update_item<F>(&mut self, id: &str, f: F) -> VltResult<&Item>
    where
        F: FnOnce(&mut Item),
    {
        let it = self
            .payload
            .items
            .iter_mut()
            .find(|i| i.id == id)
            .ok_or_else(|| VltError::ItemNotFound(id.to_string()))?;
        f(it);
        Ok(it)
    }

    pub fn delete_item(&mut self, id: &str) -> VltResult<()> {
        let len_before = self.payload.items.len();
        self.payload.items.retain(|i| i.id != id);
        if self.payload.items.len() == len_before {
            return Err(VltError::ItemNotFound(id.to_string()));
        }
        Ok(())
    }

    pub fn persist(&mut self) -> VltResult<()> {
        let key = derive_key(&self.password, &self.file.kdf)?;
        let plain = serde_json::to_vec(&self.payload)?;
        let sealed = seal(&key, &plain)?;
        self.file.sealed = sealed;
        write_atomic(&self.path, &self.file)
    }
}

fn write_atomic(path: &Path, file: &VaultFile) -> VltResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(file)?;
    fs::write(&tmp, &bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}
