//! Kubernetes client builder for EKS clusters.

use anyhow::{Context, Result};
use tracing::debug;

use crate::eks::client::ClusterInfo;
use crate::error::KupError;

/// Build a Kubernetes client for the given EKS cluster.
///
/// Uses the cluster's API endpoint and CA certificate from `describe_cluster`,
/// and obtains a bearer token via `aws eks get-token`.
pub async fn build_kube_client(
    cluster_info: &ClusterInfo,
    region: &str,
    profile: Option<&str>,
) -> Result<kube::Client> {
    let endpoint = cluster_info
        .endpoint
        .as_deref()
        .ok_or_else(|| KupError::KubernetesApi("Cluster endpoint not available".to_string()))?;

    let ca_data_b64 = cluster_info
        .ca_data
        .as_deref()
        .ok_or_else(|| KupError::KubernetesApi("Cluster CA data not available".to_string()))?;

    // Decode base64 CA certificate (AWS returns PEM encoded in base64)
    let ca_pem = base64_decode(ca_data_b64)
        .context("Failed to decode cluster CA certificate from base64")?;

    // Parse PEM to extract DER cert bytes
    let ca_certs = pem_to_der_certs(&ca_pem)?;
    if ca_certs.is_empty() {
        return Err(KupError::KubernetesApi(
            "No certificates found in cluster CA data".to_string(),
        )
        .into());
    }

    // Get bearer token via AWS CLI
    let token = get_eks_token(&cluster_info.name, region, profile).await?;
    debug!(
        "Obtained EKS bearer token for cluster {}",
        cluster_info.name
    );

    // Build kube config
    let mut config = kube::Config::new(
        endpoint
            .parse()
            .context("Failed to parse cluster endpoint URL")?,
    );
    config.default_namespace = "default".to_string();
    config.root_cert = Some(ca_certs);
    config.auth_info = kube::config::AuthInfo {
        token: Some(secrecy::SecretString::from(token)),
        ..Default::default()
    };

    let client = kube::Client::try_from(config)
        .context("Failed to build Kubernetes client from EKS config")?;

    Ok(client)
}

/// Get an EKS bearer token using `aws eks get-token`.
async fn get_eks_token(cluster_name: &str, region: &str, profile: Option<&str>) -> Result<String> {
    let mut cmd = tokio::process::Command::new("aws");
    cmd.args([
        "eks",
        "get-token",
        "--cluster-name",
        cluster_name,
        "--region",
        region,
        "--output",
        "json",
    ]);

    if let Some(profile) = profile {
        cmd.args(["--profile", profile]);
    }

    debug!(
        "Running: aws eks get-token --cluster-name {} --region {}",
        cluster_name, region
    );

    let output = cmd
        .output()
        .await
        .context("Failed to execute 'aws eks get-token'. Is the AWS CLI installed?")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(KupError::KubernetesApi(format!(
            "aws eks get-token failed: {}",
            stderr.trim()
        ))
        .into());
    }

    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("Failed to parse get-token JSON output")?;

    let token = json
        .get("status")
        .and_then(|s| s.get("token"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| {
            KupError::KubernetesApi("Missing token in get-token response".to_string())
        })?;

    Ok(token.to_string())
}

/// Parse PEM data and extract DER-encoded certificate bytes.
fn pem_to_der_certs(pem_data: &[u8]) -> Result<Vec<Vec<u8>>> {
    // Simple PEM parser: find BEGIN/END CERTIFICATE blocks and decode base64 content
    let text = std::str::from_utf8(pem_data).context("CA data is not valid UTF-8")?;
    let mut certs = Vec::new();

    let mut in_cert = false;
    let mut b64_buf = String::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed == "-----BEGIN CERTIFICATE-----" {
            in_cert = true;
            b64_buf.clear();
        } else if trimmed == "-----END CERTIFICATE-----" {
            if in_cert {
                let der = base64_decode(&b64_buf)
                    .context("Failed to decode certificate base64 content")?;
                certs.push(der);
            }
            in_cert = false;
        } else if in_cert {
            b64_buf.push_str(trimmed);
        }
    }

    Ok(certs)
}

/// Simple base64 decode (standard encoding with padding).
fn base64_decode(input: &str) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut decoder = Base64Decoder::new(input.as_bytes());
    let mut buf = Vec::new();
    decoder.read_to_end(&mut buf)?;
    Ok(buf)
}

struct Base64Decoder<'a> {
    input: &'a [u8],
    pos: usize,
    buf: [u8; 3],
    buf_len: usize,
    buf_pos: usize,
}

impl<'a> Base64Decoder<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self {
            input,
            pos: 0,
            buf: [0u8; 3],
            buf_len: 0,
            buf_pos: 0,
        }
    }
}

fn b64_val(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

impl std::io::Read for Base64Decoder<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let mut written = 0;
        while written < out.len() {
            if self.buf_pos < self.buf_len {
                out[written] = self.buf[self.buf_pos];
                self.buf_pos += 1;
                written += 1;
                continue;
            }
            // Decode next 4-char group
            let mut group = [0u8; 4];
            let mut count = 0;
            let mut padding = 0;
            while count < 4 && self.pos < self.input.len() {
                let c = self.input[self.pos];
                self.pos += 1;
                if c == b'=' {
                    padding += 1;
                    count += 1;
                } else if let Some(v) = b64_val(c) {
                    group[count] = v;
                    count += 1;
                }
                // Skip whitespace/newlines
            }
            if count == 0 {
                break;
            }
            if count < 4 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "truncated base64",
                ));
            }
            let n = match padding {
                0 => {
                    self.buf[0] = (group[0] << 2) | (group[1] >> 4);
                    self.buf[1] = (group[1] << 4) | (group[2] >> 2);
                    self.buf[2] = (group[2] << 6) | group[3];
                    3
                }
                1 => {
                    self.buf[0] = (group[0] << 2) | (group[1] >> 4);
                    self.buf[1] = (group[1] << 4) | (group[2] >> 2);
                    2
                }
                2 => {
                    self.buf[0] = (group[0] << 2) | (group[1] >> 4);
                    1
                }
                _ => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "invalid base64 padding",
                    ));
                }
            };
            self.buf_len = n;
            self.buf_pos = 0;
        }
        Ok(written)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base64_decode_simple() {
        let decoded = base64_decode("SGVsbG8=").unwrap();
        assert_eq!(decoded, b"Hello");
    }

    #[test]
    fn test_base64_decode_no_padding() {
        let decoded = base64_decode("SGVsbG8gV29ybGQ=").unwrap();
        assert_eq!(decoded, b"Hello World");
    }

    #[test]
    fn test_base64_decode_empty() {
        let decoded = base64_decode("").unwrap();
        assert!(decoded.is_empty());
    }

    #[test]
    fn test_pem_to_der_certs() {
        // A minimal self-signed cert PEM (just testing the parsing, not the cert validity)
        let pem = b"-----BEGIN CERTIFICATE-----\n\
                     SGVsbG8=\n\
                     -----END CERTIFICATE-----\n";
        let certs = pem_to_der_certs(pem).unwrap();
        assert_eq!(certs.len(), 1);
        assert_eq!(certs[0], b"Hello");
    }

    #[test]
    fn test_pem_to_der_certs_empty() {
        let pem = b"no certificates here";
        let certs = pem_to_der_certs(pem).unwrap();
        assert!(certs.is_empty());
    }
}
