//! Kubernetes client builder for EKS clusters.
//!
//! Uses STS presigned URL for token generation instead of subprocess.

use anyhow::{Context, Result};
use aws_sdk_sts::config::ProvideCredentials;
use tracing::debug;

use crate::aws::AwsClients;
use crate::eks::client::ClusterInfo;
use crate::error::KuoError;

/// Build a Kubernetes client for the given EKS cluster.
///
/// Uses the cluster's API endpoint and CA certificate from `describe_cluster`,
/// and obtains a bearer token via STS GetCallerIdentity presigned URL.
pub async fn build_kube_client(
    cluster_info: &ClusterInfo,
    region: &str,
    assume_role_arn: Option<&str>,
) -> Result<kube::Client> {
    let endpoint = cluster_info
        .endpoint
        .as_deref()
        .ok_or_else(|| KuoError::KubernetesApi("Cluster endpoint not available".to_string()))?;

    let ca_data_b64 = cluster_info
        .ca_data
        .as_deref()
        .ok_or_else(|| KuoError::KubernetesApi("Cluster CA data not available".to_string()))?;

    // Decode base64 CA certificate (AWS returns PEM encoded in base64)
    let ca_pem = base64_decode(ca_data_b64)
        .context("Failed to decode cluster CA certificate from base64")?;

    // Parse PEM to extract DER cert bytes
    let ca_certs = pem_to_der_certs(&ca_pem)?;
    if ca_certs.is_empty() {
        return Err(KuoError::KubernetesApi(
            "No certificates found in cluster CA data".to_string(),
        )
        .into());
    }

    // Get bearer token via STS presigned URL
    let token = get_eks_token_via_sts(&cluster_info.name, region, assume_role_arn).await?;
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

/// Get an EKS bearer token using STS GetCallerIdentity presigned URL.
///
/// This replaces the subprocess call to `aws eks get-token` with a programmatic
/// approach that works in-cluster without requiring the AWS CLI.
/// Uses the pre-configured AwsClients to ensure assumed role credentials are used
/// for cross-account scenarios.
async fn get_eks_token_via_sts(
    cluster_name: &str,
    region: &str,
    assume_role_arn: Option<&str>,
) -> Result<String> {
    debug!(
        "Generating EKS token for cluster {} via STS in region {}",
        cluster_name, region
    );

    let clients = AwsClients::new(region, assume_role_arn).await?;

    // Verify credentials work by calling GetCallerIdentity
    let identity = clients
        .sts
        .get_caller_identity()
        .send()
        .await
        .map_err(|e| KuoError::aws("sts::get_caller_identity", e))?;

    debug!(
        "STS identity verified: account={}, arn={}",
        identity.account().unwrap_or("unknown"),
        identity.arn().unwrap_or("unknown"),
    );

    // Reuse the AwsClients config (includes assumed role credentials if applicable)
    let credentials = clients
        .sdk_config()
        .credentials_provider()
        .ok_or_else(|| KuoError::KubernetesApi("No credentials provider available".to_string()))?
        .provide_credentials()
        .await
        .map_err(|e| KuoError::KubernetesApi(format!("Failed to resolve credentials: {}", e)))?;

    // Build the presigned URL manually
    let token = build_presigned_token(
        credentials.access_key_id(),
        credentials.secret_access_key(),
        credentials.session_token(),
        region,
        cluster_name,
    )?;

    Ok(token)
}

/// Build a presigned STS GetCallerIdentity URL and encode it as an EKS token.
///
/// The token format is: `k8s-aws-v1.` + base64url(presigned URL)
fn build_presigned_token(
    access_key: &str,
    secret_key: &str,
    session_token: Option<&str>,
    region: &str,
    cluster_name: &str,
) -> Result<String> {
    use std::time::SystemTime;

    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| anyhow::anyhow!("System time error: {}", e))?;

    let datetime = chrono::DateTime::from_timestamp(now.as_secs() as i64, 0)
        .ok_or_else(|| anyhow::anyhow!("Invalid timestamp"))?;
    let date_stamp = datetime.format("%Y%m%d").to_string();
    let amz_date = datetime.format("%Y%m%dT%H%M%SZ").to_string();

    let host = format!("sts.{}.amazonaws.com", region);
    let credential_scope = format!("{}/{}/sts/aws4_request", date_stamp, region);
    let credential = format!("{}/{}", access_key, credential_scope);

    // Build canonical query string
    let mut params = vec![
        ("Action", "GetCallerIdentity".to_string()),
        ("Version", "2011-06-15".to_string()),
        ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_string()),
        ("X-Amz-Credential", credential),
        ("X-Amz-Date", amz_date.clone()),
        ("X-Amz-Expires", "60".to_string()),
        ("X-Amz-SignedHeaders", "host;x-k8s-aws-id".to_string()),
    ];

    if let Some(token) = session_token {
        params.push(("X-Amz-Security-Token", token.to_string()));
    }

    params.sort_by(|a, b| a.0.cmp(b.0));

    let canonical_querystring: String = params
        .iter()
        .map(|(k, v)| format!("{}={}", url_encode(k), url_encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    // Canonical headers
    let canonical_headers = format!("host:{}\nx-k8s-aws-id:{}\n", host, cluster_name);
    let signed_headers = "host;x-k8s-aws-id";

    // Canonical request
    let canonical_request = format!(
        "GET\n/\n{}\n{}\n{}\n{}",
        canonical_querystring, canonical_headers, signed_headers, "UNSIGNED-PAYLOAD"
    );

    // String to sign
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        hex_sha256(canonical_request.as_bytes()),
    );

    // Signing key
    let k_date = hmac_sha256(
        format!("AWS4{}", secret_key).as_bytes(),
        date_stamp.as_bytes(),
    );
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"sts");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");

    // Signature
    let signature = hex_encode(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    // Build presigned URL
    let presigned_url = format!(
        "https://{}/?{}&X-Amz-Signature={}",
        host, canonical_querystring, signature
    );

    // Encode as EKS token: k8s-aws-v1.<base64url(presigned_url)>
    let encoded = base64url_encode(presigned_url.as_bytes());
    // Remove trailing padding
    let trimmed = encoded.trim_end_matches('=');

    Ok(format!("k8s-aws-v1.{}", trimmed))
}

// ============================================================================
// Crypto helpers (pure Rust, no external deps)
// ============================================================================

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    // HMAC-SHA256 implementation using the block size of 64
    let block_size = 64;
    let mut key_block = vec![0u8; block_size];

    if key.len() > block_size {
        let hash = sha256(key);
        key_block[..32].copy_from_slice(&hash);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut i_pad = vec![0x36u8; block_size];
    let mut o_pad = vec![0x5cu8; block_size];
    for i in 0..block_size {
        i_pad[i] ^= key_block[i];
        o_pad[i] ^= key_block[i];
    }

    i_pad.extend_from_slice(data);
    let inner_hash = sha256(&i_pad);

    o_pad.extend_from_slice(&inner_hash);
    sha256(&o_pad)
}

fn sha256(data: &[u8]) -> Vec<u8> {
    // Minimal SHA-256 implementation
    let k: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    // Padding
    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    // Process blocks
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(k[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    h.iter().flat_map(|v| v.to_be_bytes()).collect()
}

fn hex_sha256(data: &[u8]) -> String {
    hex_encode(&sha256(data))
}

fn hex_encode(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

fn url_encode(s: &str) -> String {
    let mut result = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", b));
            }
        }
    }
    result
}

fn base64url_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut result = String::new();
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i + 1 < data.len() {
            data[i + 1] as u32
        } else {
            0
        };
        let b2 = if i + 2 < data.len() {
            data[i + 2] as u32
        } else {
            0
        };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if i + 1 < data.len() {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if i + 2 < data.len() {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        i += 3;
    }
    result
}

// ============================================================================
// Base64 decode (standard) - kept for CA certificate parsing
// ============================================================================

/// Parse PEM data and extract DER-encoded certificate bytes.
fn pem_to_der_certs(pem_data: &[u8]) -> Result<Vec<Vec<u8>>> {
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

    #[test]
    fn test_pem_to_der_certs_multiple() {
        let pem = b"-----BEGIN CERTIFICATE-----\n\
                     SGVsbG8=\n\
                     -----END CERTIFICATE-----\n\
                     -----BEGIN CERTIFICATE-----\n\
                     V29ybGQ=\n\
                     -----END CERTIFICATE-----\n";
        let certs = pem_to_der_certs(pem).unwrap();
        assert_eq!(certs.len(), 2);
        assert_eq!(certs[0], b"Hello");
        assert_eq!(certs[1], b"World");
    }

    #[test]
    fn test_sha256_empty() {
        let hash = hex_sha256(b"");
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_sha256_hello() {
        let hash = hex_sha256(b"hello");
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn test_url_encode() {
        assert_eq!(url_encode("hello"), "hello");
        assert_eq!(url_encode("hello world"), "hello%20world");
        assert_eq!(url_encode("a/b"), "a%2Fb");
    }

    #[test]
    fn test_b64_val() {
        assert_eq!(b64_val(b'A'), Some(0));
        assert_eq!(b64_val(b'Z'), Some(25));
        assert_eq!(b64_val(b'a'), Some(26));
        assert_eq!(b64_val(b'z'), Some(51));
        assert_eq!(b64_val(b'0'), Some(52));
        assert_eq!(b64_val(b'9'), Some(61));
        assert_eq!(b64_val(b'+'), Some(62));
        assert_eq!(b64_val(b'/'), Some(63));
        assert_eq!(b64_val(b'='), None);
    }

    #[test]
    fn test_hmac_sha256() {
        let result = hmac_sha256(b"key", b"data");
        let hex = hex_encode(&result);
        assert_eq!(
            hex,
            "5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0"
        );
    }
}
