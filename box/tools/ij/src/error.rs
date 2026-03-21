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
    /// Configuration error.
    Config(String),
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
            Error::Config(msg) => write!(f, "Config error: {}", msg),
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

impl From<serde_yaml::Error> for Error {
    fn from(e: serde_yaml::Error) -> Self {
        Error::Config(e.to_string())
    }
}

/// Result type alias for this crate.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error as StdError;

    // --- Display tests ---

    #[test]
    fn display_aws_error() {
        let e = Error::Aws("timeout".into());
        assert_eq!(e.to_string(), "AWS error: timeout");
    }

    #[test]
    fn display_pty_error() {
        let e = Error::Pty("alloc failed".into());
        assert_eq!(e.to_string(), "PTY error: alloc failed");
    }

    #[test]
    fn display_session_error() {
        let e = Error::Session("refused".into());
        assert_eq!(e.to_string(), "Session error: refused");
    }

    #[test]
    fn display_config_error() {
        let e = Error::Config("missing field".into());
        assert_eq!(e.to_string(), "Config error: missing field");
    }

    #[test]
    fn display_cancelled() {
        assert_eq!(Error::Cancelled.to_string(), "Operation cancelled");
    }

    #[test]
    fn display_no_instances() {
        assert_eq!(Error::NoInstances.to_string(), "No instances found");
    }

    #[test]
    fn display_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file missing");
        let e = Error::Io(io_err);
        assert_eq!(e.to_string(), "IO error: file missing");
    }

    #[test]
    fn display_other_error() {
        let e = Error::Other(anyhow::anyhow!("boom"));
        assert_eq!(e.to_string(), "boom");
    }

    // --- From conversion tests ---

    #[test]
    fn from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let e: Error = io_err.into();
        assert!(matches!(e, Error::Io(_)));
        assert_eq!(e.to_string(), "IO error: denied");
    }

    #[test]
    fn from_anyhow_error() {
        let anyhow_err = anyhow::anyhow!("something went wrong");
        let e: Error = anyhow_err.into();
        assert!(matches!(e, Error::Other(_)));
        assert_eq!(e.to_string(), "something went wrong");
    }

    #[test]
    fn from_serde_yaml_error() {
        let yaml_err = serde_yaml::from_str::<serde_yaml::Value>("{{invalid").unwrap_err();
        let msg = yaml_err.to_string();
        let e: Error = yaml_err.into();
        assert!(matches!(e, Error::Config(_)));
        assert!(e
            .to_string()
            .contains(&msg.split('\n').next().unwrap()[..20]));
    }

    // --- source() tests ---

    #[test]
    fn source_returns_some_for_io() {
        let io_err = std::io::Error::new(std::io::ErrorKind::Other, "inner");
        let e = Error::Io(io_err);
        assert!(e.source().is_some());
    }

    #[test]
    fn source_other_delegates() {
        let anyhow_err = anyhow::anyhow!("no source");
        let e = Error::Other(anyhow_err);
        // anyhow::Error from anyhow!() has no source
        let _ = e.source(); // exercises the Error::Other(e) => e.source() branch
    }

    #[test]
    fn source_returns_none_for_simple_variants() {
        assert!(Error::Aws("x".into()).source().is_none());
        assert!(Error::Pty("x".into()).source().is_none());
        assert!(Error::Session("x".into()).source().is_none());
        assert!(Error::Config("x".into()).source().is_none());
        assert!(Error::Cancelled.source().is_none());
        assert!(Error::NoInstances.source().is_none());
    }
}
