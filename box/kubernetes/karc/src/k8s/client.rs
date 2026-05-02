//! Kubernetes client builder with kubeconfig context support.

use anyhow::Result;
use tracing::debug;

use crate::error::KarcError;

/// Build a Kubernetes client from kubeconfig.
///
/// Uses the specified context if provided, otherwise uses the default context.
pub async fn build_client(context: Option<&str>) -> Result<kube::Client> {
    let client = match context {
        Some(ctx) => {
            debug!("Using kubeconfig context: {}", ctx);
            let kubeconfig = kube::config::Kubeconfig::read()?;
            let config = kube::Config::from_custom_kubeconfig(
                kubeconfig,
                &kube::config::KubeConfigOptions {
                    context: Some(ctx.to_string()),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| KarcError::Kubeconfig(format!("context '{}': {}", ctx, e)))?;
            kube::Client::try_from(config)
                .map_err(|e| KarcError::Kubeconfig(format!("context '{}': {}", ctx, e)))?
        }
        None => {
            debug!("Using default kubeconfig context");
            kube::Client::try_default()
                .await
                .map_err(|e| KarcError::Kubeconfig(e.to_string()))?
        }
    };

    Ok(client)
}

/// Get the current context name from kubeconfig.
pub fn current_context(context: Option<&str>) -> String {
    if let Some(ctx) = context {
        return ctx.to_string();
    }

    kube::config::Kubeconfig::read()
        .ok()
        .and_then(|kc| kc.current_context)
        .unwrap_or_else(|| "unknown".to_string())
}
