use thiserror::Error;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum Error {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("RDS discovery failed: {0}")]
    Discovery(String),

    #[error("PI API call failed for instance {instance}: {message}")]
    PiApi { instance: String, message: String },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("YAML parse error: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("Regex error: {0}")]
    Regex(#[from] regex::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_error_display() {
        let err = Error::Config("missing region".to_string());
        assert_eq!(err.to_string(), "Configuration error: missing region");
    }

    #[test]
    fn test_discovery_error_display() {
        let err = Error::Discovery("timeout".to_string());
        assert_eq!(err.to_string(), "RDS discovery failed: timeout");
    }

    #[test]
    fn test_pi_api_error_display() {
        let err = Error::PiApi {
            instance: "prod-writer".to_string(),
            message: "ThrottlingException".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "PI API call failed for instance prod-writer: ThrottlingException"
        );
    }

    #[test]
    fn test_yaml_error_from() {
        let yaml_err: std::result::Result<String, serde_yaml::Error> =
            serde_yaml::from_str("invalid: [");
        let err = Error::from(yaml_err.unwrap_err());
        assert!(err.to_string().contains("YAML parse error"));
    }

    #[test]
    fn test_regex_error_from() {
        let regex_err = regex::Regex::new("[invalid").unwrap_err();
        let err = Error::from(regex_err);
        assert!(err.to_string().contains("Regex error"));
    }
}
