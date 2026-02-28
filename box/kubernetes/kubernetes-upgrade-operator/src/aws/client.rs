//! Region-based AWS client factory with cross-account `AssumeRole` support.

use anyhow::{Context, Result};
use aws_sdk_eks::Client as EksClient;
use aws_sdk_sts::Client as StsClient;
use tracing::{debug, info};

use crate::crd::AwsIdentity;

/// AWS clients for a specific region.
#[derive(Clone)]
pub struct AwsClients {
    pub eks: EksClient,
    pub sts: StsClient,
    pub region: String,
    config: aws_config::SdkConfig,
}

impl AwsClients {
    /// Create AWS clients for a given region.
    ///
    /// Uses default credential chain (IRSA, EKS Pod Identity, instance profile, env vars).
    /// If `assume_role_arn` is provided, performs STS `AssumeRole` for cross-account access.
    pub async fn new(region: &str, assume_role_arn: Option<&str>) -> Result<Self> {
        let config = if let Some(role_arn) = assume_role_arn {
            Self::build_assumed_role_config(region, role_arn).await?
        } else {
            debug!("Creating AWS clients for region: {}", region);
            aws_config::defaults(aws_config::BehaviorVersion::latest())
                .region(aws_config::Region::new(region.to_string()))
                .load()
                .await
        };

        Ok(Self {
            eks: EksClient::new(&config),
            sts: StsClient::new(&config),
            region: region.to_string(),
            config,
        })
    }

    /// Get the underlying SDK config (includes assumed role credentials if applicable).
    pub const fn sdk_config(&self) -> &aws_config::SdkConfig {
        &self.config
    }

    /// Verify credentials by calling STS `GetCallerIdentity` and return the identity.
    pub async fn verify_identity(&self) -> Result<AwsIdentity> {
        let resp = self
            .sts
            .get_caller_identity()
            .send()
            .await
            .context("STS GetCallerIdentity failed")?;

        Ok(AwsIdentity {
            account_id: resp.account().unwrap_or("unknown").to_string(),
            arn: resp.arn().unwrap_or("unknown").to_string(),
        })
    }

    /// Build AWS config by assuming an IAM role in a target account.
    ///
    /// Uses `AssumeRoleProvider` so the SDK automatically refreshes temporary
    /// credentials before they expire. The base credentials come from the default
    /// chain (IRSA or EKS Pod Identity).
    async fn build_assumed_role_config(
        region: &str,
        role_arn: &str,
    ) -> Result<aws_config::SdkConfig> {
        info!(
            "Assuming role {} in region {} for cross-account access",
            role_arn, region
        );

        // Load base config using default credential chain (IRSA / EKS Pod Identity)
        let base_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region.to_string()))
            .load()
            .await;

        let assume_role_provider = aws_config::sts::AssumeRoleProvider::builder(role_arn)
            .configure(&base_config)
            .region(aws_config::Region::new(region.to_string()))
            .session_name("kuo-operator")
            .build()
            .await;

        debug!(
            "Configured AssumeRoleProvider for {}, credentials will be resolved on first API call",
            role_arn
        );

        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region.to_string()))
            .credentials_provider(assume_role_provider)
            .load()
            .await;

        Ok(config)
    }
}
