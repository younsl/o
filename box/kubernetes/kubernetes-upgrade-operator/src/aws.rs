//! Region-based AWS client factory with cross-account AssumeRole support.

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
    /// If `assume_role_arn` is provided, performs STS AssumeRole for cross-account access.
    pub async fn new(region: &str, assume_role_arn: Option<&str>) -> Result<Self> {
        let config = match assume_role_arn {
            Some(role_arn) => Self::build_assumed_role_config(region, role_arn).await?,
            None => {
                debug!("Creating AWS clients for region: {}", region);
                aws_config::defaults(aws_config::BehaviorVersion::latest())
                    .region(aws_config::Region::new(region.to_string()))
                    .load()
                    .await
            }
        };

        Ok(Self {
            eks: EksClient::new(&config),
            sts: StsClient::new(&config),
            region: region.to_string(),
            config,
        })
    }

    /// Get the underlying SDK config (includes assumed role credentials if applicable).
    pub fn sdk_config(&self) -> &aws_config::SdkConfig {
        &self.config
    }

    /// Verify credentials by calling STS GetCallerIdentity and return the identity.
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
    /// The base credentials come from the default chain (IRSA or EKS Pod Identity),
    /// then STS AssumeRole is called to obtain temporary credentials for the target account.
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

        let sts = StsClient::new(&base_config);

        let assumed = sts
            .assume_role()
            .role_arn(role_arn)
            .role_session_name("kuo-operator")
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to assume role {}: {}", role_arn, e))?;

        let creds = assumed.credentials().ok_or_else(|| {
            anyhow::anyhow!("AssumeRole returned no credentials for {}", role_arn)
        })?;

        let access_key = creds.access_key_id().to_string();
        let secret_key = creds.secret_access_key().to_string();
        let session_token = creds.session_token().to_string();

        debug!("Successfully assumed role {}", role_arn);

        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region.to_string()))
            .credentials_provider(aws_sdk_sts::config::Credentials::new(
                access_key,
                secret_key,
                Some(session_token),
                None,
                "kuo-assume-role",
            ))
            .load()
            .await;

        Ok(config)
    }
}
