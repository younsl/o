//! Custom error types for karc.

use thiserror::Error;

/// Errors that can occur during Karpenter NodePool operations.
#[derive(Error, Debug)]
pub enum KarcError {
    #[error("Kubernetes API error: {0}")]
    KubernetesApi(String),

    #[error("NodePool not found: {0}")]
    NodePoolNotFound(String),

    #[error("No NodePools found in cluster")]
    NoNodePoolsFound,

    #[error("Invalid timezone: {0}")]
    InvalidTimezone(String),

    #[error("Kubeconfig error: {0}")]
    Kubeconfig(String),
}
