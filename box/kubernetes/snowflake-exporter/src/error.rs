use thiserror::Error;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum Error {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Authentication error: {0}")]
    Auth(String),

    #[error("Snowflake query failed: {query}: {message}")]
    Query { query: String, message: String },

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("YAML parse error: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Prometheus error: {0}")]
    Prometheus(#[from] prometheus::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_error_display() {
        let err = Error::Config("missing account".to_string());
        assert_eq!(err.to_string(), "Configuration error: missing account");
    }

    #[test]
    fn test_query_error_display() {
        let err = Error::Query {
            query: "storage".to_string(),
            message: "timeout".to_string(),
        };
        assert_eq!(err.to_string(), "Snowflake query failed: storage: timeout");
    }
}
