//! Kubernetes client builder for EKS clusters.
//!
//! Uses STS presigned URL for token generation instead of subprocess.

use anyhow::{Context, Result};
use tracing::debug;

use crate::aws::sts;
use crate::eks::client::ClusterInfo;
use crate::error::KuoError;

/// Build a Kubernetes client for the given EKS cluster.
///
/// Uses the cluster's API endpoint and CA certificate from `describe_cluster`,
/// and obtains a bearer token via STS `GetCallerIdentity` presigned URL.
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
    let ca_pem = sts::base64_decode(ca_data_b64)
        .context("Failed to decode cluster CA certificate from base64")?;

    // Parse PEM to extract DER cert bytes
    let ca_certs = sts::pem_to_der_certs(&ca_pem)?;
    if ca_certs.is_empty() {
        return Err(KuoError::KubernetesApi(
            "No certificates found in cluster CA data".to_string(),
        )
        .into());
    }

    // Get bearer token via STS presigned URL
    let token = sts::get_eks_token(&cluster_info.name, region, assume_role_arn).await?;
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
