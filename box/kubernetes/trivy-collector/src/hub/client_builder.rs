//! Build a `kube::Client` from a registered cluster Secret.
//!
//! Secret layout (ArgoCD-compatible):
//! ```yaml
//! metadata:
//!   labels:
//!     trivy-collector.io/secret-type: cluster
//! stringData:
//!   name: edge-a
//!   server: https://edge-api:443
//!   config: |
//!     { "bearerToken": "...", "tlsClientConfig": { "caData": "<base64 CA>" } }
//!   namespaces: '["default","prod"]'   # optional
//! ```

use anyhow::{Context, Result, anyhow};
use k8s_openapi::api::core::v1::Secret;
use kube::Client;
use kube::config::{Config as KubeClientConfig, KubeConfigOptions, Kubeconfig};

use super::types::{ClusterCredentials, ClusterSecret};

/// Parse a cluster-registration Secret into a `ClusterSecret` view.
pub fn parse_cluster_secret(secret: &Secret) -> Result<ClusterSecret> {
    let data = read_secret_map(secret);

    let name = data
        .get("name")
        .cloned()
        .or_else(|| secret.metadata.name.clone())
        .ok_or_else(|| anyhow!("cluster Secret missing 'name' field"))?;

    let server = data
        .get("server")
        .cloned()
        .ok_or_else(|| anyhow!("cluster Secret '{}' missing 'server' field", name))?;

    let config_str = data
        .get("config")
        .ok_or_else(|| anyhow!("cluster Secret '{}' missing 'config' field", name))?;

    let credentials: ClusterCredentials = serde_json::from_str(config_str)
        .with_context(|| format!("invalid 'config' JSON in cluster Secret '{}'", name))?;

    let namespaces = match data.get("namespaces") {
        Some(v) if !v.trim().is_empty() => serde_json::from_str::<Vec<String>>(v)
            .with_context(|| format!("invalid 'namespaces' JSON in cluster Secret '{}'", name))?,
        _ => Vec::new(),
    };

    Ok(ClusterSecret {
        name,
        server,
        credentials,
        namespaces,
    })
}

/// Build a `kube::Client` from a parsed cluster Secret.
pub async fn build_client(secret: &ClusterSecret) -> Result<Client> {
    let yaml = synth_kubeconfig_yaml(secret);
    let kubeconfig = Kubeconfig::from_yaml(&yaml)
        .with_context(|| format!("failed to parse synthetic kubeconfig for '{}'", secret.name))?;

    let options = KubeConfigOptions {
        context: Some(secret.name.clone()),
        cluster: Some(secret.name.clone()),
        user: Some(format!("{}-user", secret.name)),
    };
    let cfg = KubeClientConfig::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .with_context(|| format!("failed to build kube::Config for cluster '{}'", secret.name))?;

    Client::try_from(cfg)
        .with_context(|| format!("failed to build kube::Client for cluster '{}'", secret.name))
}

fn synth_kubeconfig_yaml(secret: &ClusterSecret) -> String {
    let cluster_name = &secret.name;
    let user_name = format!("{}-user", secret.name);
    let tls = &secret.credentials.tls_client_config;

    let mut cluster_lines = format!("    server: {}\n", yaml_quote(&secret.server));
    if tls.insecure {
        cluster_lines.push_str("    insecure-skip-tls-verify: true\n");
    }
    if let Some(ca) = &tls.ca_data {
        cluster_lines.push_str(&format!(
            "    certificate-authority-data: {}\n",
            yaml_quote(ca)
        ));
    }
    if let Some(sn) = &tls.server_name {
        cluster_lines.push_str(&format!("    tls-server-name: {}\n", yaml_quote(sn)));
    }

    let mut user_lines = String::new();
    if let Some(tok) = &secret.credentials.bearer_token {
        user_lines.push_str(&format!("    token: {}\n", yaml_quote(tok)));
    }
    if let Some(cert) = &tls.cert_data {
        user_lines.push_str(&format!(
            "    client-certificate-data: {}\n",
            yaml_quote(cert)
        ));
    }
    if let Some(key) = &tls.key_data {
        user_lines.push_str(&format!("    client-key-data: {}\n", yaml_quote(key)));
    }

    let user_block = if user_lines.is_empty() {
        "    {}\n".to_string()
    } else {
        user_lines
    };

    let mut out = String::new();
    out.push_str("apiVersion: v1\n");
    out.push_str("kind: Config\n");
    out.push_str(&format!("current-context: {}\n", cluster_name));
    out.push_str("clusters:\n");
    out.push_str(&format!("- name: {}\n", cluster_name));
    out.push_str("  cluster:\n");
    out.push_str(&cluster_lines);
    out.push_str("users:\n");
    out.push_str(&format!("- name: {}\n", user_name));
    out.push_str("  user:\n");
    out.push_str(&user_block);
    out.push_str("contexts:\n");
    out.push_str(&format!("- name: {}\n", cluster_name));
    out.push_str("  context:\n");
    out.push_str(&format!("    cluster: {}\n", cluster_name));
    out.push_str(&format!("    user: {}\n", user_name));
    out
}

/// Minimal YAML scalar quoting: wrap in double quotes and escape backslash/quote.
fn yaml_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

fn read_secret_map(secret: &Secret) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();

    if let Some(string_data) = &secret.string_data {
        for (k, v) in string_data {
            out.insert(k.clone(), v.clone());
        }
    }

    if let Some(data) = &secret.data {
        for (k, v) in data {
            if out.contains_key(k) {
                continue;
            }
            if let Ok(s) = std::str::from_utf8(&v.0) {
                out.insert(k.clone(), s.to_string());
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::ByteString;
    use std::collections::BTreeMap;

    fn secret_with_string_data(pairs: &[(&str, &str)]) -> Secret {
        let mut string_data = BTreeMap::new();
        for (k, v) in pairs {
            string_data.insert((*k).to_string(), (*v).to_string());
        }
        Secret {
            string_data: Some(string_data),
            ..Default::default()
        }
    }

    #[test]
    fn test_parse_minimal_secret() {
        let s = secret_with_string_data(&[
            ("name", "edge-a"),
            ("server", "https://edge:443"),
            ("config", r#"{"bearerToken":"abc"}"#),
        ]);
        let parsed = parse_cluster_secret(&s).unwrap();
        assert_eq!(parsed.name, "edge-a");
        assert_eq!(parsed.server, "https://edge:443");
        assert_eq!(parsed.credentials.bearer_token.as_deref(), Some("abc"));
        assert!(parsed.namespaces.is_empty());
    }

    #[test]
    fn test_parse_with_tls_and_namespaces() {
        let s = secret_with_string_data(&[
            ("name", "edge-b"),
            ("server", "https://edge-b:443"),
            (
                "config",
                r#"{"bearerToken":"t","tlsClientConfig":{"caData":"Y2E="}}"#,
            ),
            ("namespaces", r#"["ns1","ns2"]"#),
        ]);
        let parsed = parse_cluster_secret(&s).unwrap();
        assert_eq!(parsed.namespaces, vec!["ns1", "ns2"]);
        assert_eq!(
            parsed.credentials.tls_client_config.ca_data.as_deref(),
            Some("Y2E=")
        );
    }

    #[test]
    fn test_parse_missing_server() {
        let s = secret_with_string_data(&[("name", "x"), ("config", "{}")]);
        assert!(parse_cluster_secret(&s).is_err());
    }

    #[test]
    fn test_parse_invalid_config_json() {
        let s = secret_with_string_data(&[
            ("name", "x"),
            ("server", "https://x"),
            ("config", "not-json"),
        ]);
        assert!(parse_cluster_secret(&s).is_err());
    }

    #[test]
    fn test_read_data_field_fallback() {
        let mut data = BTreeMap::new();
        data.insert("name".to_string(), ByteString("edge-c".as_bytes().to_vec()));
        data.insert(
            "server".to_string(),
            ByteString("https://c".as_bytes().to_vec()),
        );
        data.insert(
            "config".to_string(),
            ByteString(br#"{"bearerToken":"t"}"#.to_vec()),
        );
        let s = Secret {
            data: Some(data),
            ..Default::default()
        };
        let parsed = parse_cluster_secret(&s).unwrap();
        assert_eq!(parsed.name, "edge-c");
        assert_eq!(parsed.server, "https://c");
    }

    #[test]
    fn test_synth_kubeconfig_parses() {
        let secret = ClusterSecret {
            name: "edge-a".to_string(),
            server: "https://edge-a:443".to_string(),
            credentials: ClusterCredentials {
                bearer_token: Some("tok".to_string()),
                ..Default::default()
            },
            namespaces: vec![],
        };
        let yaml = synth_kubeconfig_yaml(&secret);
        eprintln!("YAML:\n{}", yaml);
        let kubeconfig = Kubeconfig::from_yaml(&yaml).expect("synth kubeconfig should parse");
        assert_eq!(kubeconfig.current_context.as_deref(), Some("edge-a"));
        assert_eq!(kubeconfig.clusters.len(), 1);
        assert_eq!(kubeconfig.auth_infos.len(), 1);
    }

    #[test]
    fn test_yaml_quote() {
        assert_eq!(yaml_quote("hello"), "\"hello\"");
        assert_eq!(yaml_quote(r#"a"b"#), "\"a\\\"b\"");
        assert_eq!(yaml_quote(r"a\b"), "\"a\\\\b\"");
    }
}
