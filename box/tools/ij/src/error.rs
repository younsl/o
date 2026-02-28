//! Custom error types for better error handling.

use std::fmt;

/// Application-specific errors.
#[derive(Debug)]
#[allow(dead_code)]
pub enum Error {
    /// AWS SDK error.
    Aws(String),
    /// PTY operation failed.
    Pty(String),
    /// Session connection failed.
    Session(String),
    /// User cancelled operation.
    Cancelled,
    /// No instances found.
    NoInstances,
    /// IO error.
    Io(std::io::Error),
    /// Other errors.
    Other(anyhow::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Aws(msg) => write!(f, "AWS error: {}", msg),
            Error::Pty(msg) => write!(f, "PTY error: {}", msg),
            Error::Session(msg) => write!(f, "Session error: {}", msg),
            Error::Cancelled => write!(f, "Operation cancelled"),
            Error::NoInstances => write!(f, "No instances found"),
            Error::Io(e) => write!(f, "IO error: {}", e),
            Error::Other(e) => write!(f, "{}", e),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            Error::Other(e) => e.source(),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        Error::Other(e)
    }
}

/// Result type alias for this crate.
pub type Result<T> = std::result::Result<T, Error>;
