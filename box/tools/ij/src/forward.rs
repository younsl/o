//! Port forwarding spec parser for SSM sessions.

use crate::error::{Error, Result};

/// SSM port forwarding specification.
#[derive(Debug, Clone, PartialEq)]
pub enum PortForward {
    /// Forward local port to the same or different port on the instance.
    Instance { local_port: u16, remote_port: u16 },
    /// Forward local port to a remote host through the instance.
    RemoteHost {
        local_port: u16,
        remote_host: String,
        remote_port: u16,
    },
}

impl PortForward {
    /// Parse a `-L` spec string into a `PortForward`.
    ///
    /// Supported formats:
    /// - `80`                      → Instance { local: 80, remote: 80 }
    /// - `8080:80`                 → Instance { local: 8080, remote: 80 }
    /// - `rds.example.com:3306`    → RemoteHost { local: 3306, host: rds.example.com, remote: 3306 }
    /// - `3306:rds.example.com:3306` → RemoteHost { local: 3306, host: rds.example.com, remote: 3306 }
    pub fn parse(spec: &str) -> Result<Self> {
        let parts: Vec<&str> = spec.splitn(3, ':').collect();

        match parts.len() {
            1 => {
                let port = parse_port(parts[0])?;
                Ok(PortForward::Instance {
                    local_port: port,
                    remote_port: port,
                })
            }
            2 => {
                // Two segments: either "local:remote" or "host:port"
                if parts[0].chars().all(|c| c.is_ascii_digit()) {
                    // Both numeric: local_port:remote_port (Instance)
                    let local = parse_port(parts[0])?;
                    let remote = parse_port(parts[1])?;
                    Ok(PortForward::Instance {
                        local_port: local,
                        remote_port: remote,
                    })
                } else {
                    // First is hostname: host:port (RemoteHost, local = remote)
                    let host = parts[0].to_string();
                    let port = parse_port(parts[1])?;
                    Ok(PortForward::RemoteHost {
                        local_port: port,
                        remote_host: host,
                        remote_port: port,
                    })
                }
            }
            3 => {
                let local = parse_port(parts[0])?;
                let host = parts[1].to_string();
                let remote = parse_port(parts[2])?;
                Ok(PortForward::RemoteHost {
                    local_port: local,
                    remote_host: host,
                    remote_port: remote,
                })
            }
            _ => Err(Error::Session(format!("Invalid forward spec: {}", spec))),
        }
    }

    /// SSM document name for this forwarding type.
    pub fn document_name(&self) -> &str {
        match self {
            PortForward::Instance { .. } => "AWS-StartPortForwardingSession",
            PortForward::RemoteHost { .. } => "AWS-StartPortForwardingSessionToRemoteHost",
        }
    }

    /// Generate `--parameters` JSON for the SSM session.
    pub fn parameters_json(&self) -> String {
        match self {
            PortForward::Instance {
                local_port,
                remote_port,
            } => {
                format!(
                    r#"{{"portNumber":["{}"],"localPortNumber":["{}"]}}"#,
                    remote_port, local_port,
                )
            }
            PortForward::RemoteHost {
                local_port,
                remote_host,
                remote_port,
            } => {
                format!(
                    r#"{{"host":["{}"],"portNumber":["{}"],"localPortNumber":["{}"]}}"#,
                    remote_host, remote_port, local_port,
                )
            }
        }
    }

    /// Human-readable description for display.
    pub fn display_info(&self) -> String {
        match self {
            PortForward::Instance {
                local_port,
                remote_port,
            } => {
                format!("localhost:{} -> instance:{}", local_port, remote_port)
            }
            PortForward::RemoteHost {
                local_port,
                remote_host,
                remote_port,
            } => {
                format!(
                    "localhost:{} -> {}:{}",
                    local_port, remote_host, remote_port,
                )
            }
        }
    }
}

/// Parse a string as a valid port number (1-65535).
fn parse_port(s: &str) -> Result<u16> {
    let port: u16 = s
        .parse()
        .map_err(|_| Error::Session(format!("Invalid port number: {}", s)))?;
    if port == 0 {
        return Err(Error::Session("Port number cannot be 0".to_string()));
    }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_single_port() {
        let pf = PortForward::parse("80").unwrap();
        assert_eq!(
            pf,
            PortForward::Instance {
                local_port: 80,
                remote_port: 80,
            }
        );
    }

    #[test]
    fn parse_local_remote_ports() {
        let pf = PortForward::parse("8080:80").unwrap();
        assert_eq!(
            pf,
            PortForward::Instance {
                local_port: 8080,
                remote_port: 80,
            }
        );
    }

    #[test]
    fn parse_host_port() {
        let pf = PortForward::parse("rds.example.com:3306").unwrap();
        assert_eq!(
            pf,
            PortForward::RemoteHost {
                local_port: 3306,
                remote_host: "rds.example.com".to_string(),
                remote_port: 3306,
            }
        );
    }

    #[test]
    fn parse_full_remote_spec() {
        let pf = PortForward::parse("3306:rds.example.com:3306").unwrap();
        assert_eq!(
            pf,
            PortForward::RemoteHost {
                local_port: 3306,
                remote_host: "rds.example.com".to_string(),
                remote_port: 3306,
            }
        );
    }

    #[test]
    fn parse_different_local_remote_host() {
        let pf = PortForward::parse("5432:my-db.example.com:3306").unwrap();
        assert_eq!(
            pf,
            PortForward::RemoteHost {
                local_port: 5432,
                remote_host: "my-db.example.com".to_string(),
                remote_port: 3306,
            }
        );
    }

    #[test]
    fn parse_invalid_port() {
        assert!(PortForward::parse("abc").is_err());
        assert!(PortForward::parse("0").is_err());
        assert!(PortForward::parse("99999").is_err());
    }

    #[test]
    fn parse_invalid_spec() {
        assert!(PortForward::parse("8080:host:abc").is_err());
    }

    #[test]
    fn document_name_instance() {
        let pf = PortForward::parse("80").unwrap();
        assert_eq!(pf.document_name(), "AWS-StartPortForwardingSession");
    }

    #[test]
    fn document_name_remote_host() {
        let pf = PortForward::parse("rds.example.com:3306").unwrap();
        assert_eq!(
            pf.document_name(),
            "AWS-StartPortForwardingSessionToRemoteHost"
        );
    }

    #[test]
    fn parameters_json_instance() {
        let pf = PortForward::parse("8080:80").unwrap();
        assert_eq!(
            pf.parameters_json(),
            r#"{"portNumber":["80"],"localPortNumber":["8080"]}"#,
        );
    }

    #[test]
    fn parameters_json_remote_host() {
        let pf = PortForward::parse("3306:rds.example.com:3306").unwrap();
        assert_eq!(
            pf.parameters_json(),
            r#"{"host":["rds.example.com"],"portNumber":["3306"],"localPortNumber":["3306"]}"#,
        );
    }

    #[test]
    fn display_info_instance() {
        let pf = PortForward::parse("8080:80").unwrap();
        assert_eq!(pf.display_info(), "localhost:8080 -> instance:80");
    }

    #[test]
    fn display_info_remote_host() {
        let pf = PortForward::parse("3306:rds.example.com:3306").unwrap();
        assert_eq!(pf.display_info(), "localhost:3306 -> rds.example.com:3306");
    }
}
