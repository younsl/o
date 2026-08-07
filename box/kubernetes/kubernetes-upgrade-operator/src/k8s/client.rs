//! Kubernetes client builder for EKS clusters.
//!
//! Uses STS presigned URL for token generation instead of subprocess.

use anyhow::{Context, Result};
use tracing::{debug, info};

use crate::aws::sts;
use crate::eks::client::{ClusterInfo, EksClient};
use crate::error::KuoError;

/// Resolve the Kubernetes client for a target cluster.
///
/// When `assume_role_arn` is `None`, kuo is operating on its own (in-cluster)
/// cluster, so the in-cluster client (its `ServiceAccount`, already RBAC-bound by
/// the chart) is reused and talks to the local API server directly. No EKS
/// access entry is required. When `assume_role_arn` is set, a remote client is
/// built for the cross-account spoke via an STS-signed EKS token, which does
/// require an access entry mapping on that cluster.
pub async fn resolve_client(
    in_cluster: &kube::Client,
    eks: &EksClient,
    cluster_name: &str,
    assume_role_arn: Option<&str>,
) -> Result<kube::Client> {
    if assume_role_arn.is_none() {
        info!(
            "Using in cluster Kubernetes client for cluster {cluster_name} because no assume role is set, so kuo talks to its own API server with its ServiceAccount and no EKS access entry is needed"
        );
        return Ok(in_cluster.clone());
    }
    info!(
        "Using out of cluster Kubernetes client for cluster {cluster_name} via STS assume role {}, which requires an EKS access entry on that cluster",
        assume_role_arn.unwrap_or("")
    );
    let cluster = eks
        .describe_cluster(cluster_name)
        .await?
        .ok_or_else(|| KuoError::ClusterNotFound(cluster_name.to_string()))?;
    build_kube_client(&cluster, eks.region(), assume_role_arn).await
}

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
