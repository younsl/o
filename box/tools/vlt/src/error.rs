use thiserror::Error;

#[derive(Debug, Error)]
pub enum VltError {
    #[error("vault is already initialized")]
    AlreadyInitialized,

    #[error("vault is not initialized")]
    NotInitialized,

    #[error("invalid master password")]
    InvalidMasterPassword,

    #[error("item not found: {0}")]
    ItemNotFound(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("crypto error: {0}")]
    Crypto(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("config dir not found")]
    NoConfigDir,
}

pub type VltResult<T> = Result<T, VltError>;
