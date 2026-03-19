//! AWS EC2 and STS operations.

use anyhow::Result;
use aws_sdk_ec2::Client as Ec2Client;
use aws_sdk_ec2::types::Filter;
use aws_sdk_sts::Client as StsClient;
use tracing::{debug, info};

use crate::crd::ManagedInstance;
use crate::error::SchedulerError;

/// AWS clients for a specific region.
#[derive(Clone)]
pub struct AwsClients {
    ec2: Ec2Client,
    _sts: StsClient,
    _region: String,
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
            ec2: Ec2Client::new(&config),
            _sts: StsClient::new(&config),
            _region: region.to_string(),
        })
    }

    /// Start EC2 instances.
    pub async fn start_instances(&self, instance_ids: &[String]) -> Result<()> {
        if instance_ids.is_empty() {
            return Ok(());
        }
        info!(
            "Starting {} instance(s): {:?}",
            instance_ids.len(),
            instance_ids
        );
        self.ec2
            .start_instances()
            .set_instance_ids(Some(instance_ids.to_vec()))
            .send()
            .await
            .map_err(|e| SchedulerError::aws("ec2::start_instances", e))?;
        Ok(())
    }

    /// Stop EC2 instances.
    pub async fn stop_instances(&self, instance_ids: &[String]) -> Result<()> {
        if instance_ids.is_empty() {
            return Ok(());
        }
        info!(
            "Stopping {} instance(s): {:?}",
            instance_ids.len(),
            instance_ids
        );
        self.ec2
            .stop_instances()
            .set_instance_ids(Some(instance_ids.to_vec()))
            .send()
            .await
            .map_err(|e| SchedulerError::aws("ec2::stop_instances", e))?;
        Ok(())
    }

    /// Describe instances by IDs and return their states.
    pub async fn describe_instances(&self, instance_ids: &[String]) -> Result<Vec<ManagedInstance>> {
        if instance_ids.is_empty() {
            return Ok(vec![]);
        }
        let resp = self
            .ec2
            .describe_instances()
            .set_instance_ids(Some(instance_ids.to_vec()))
            .send()
            .await
            .map_err(|e| SchedulerError::aws("ec2::describe_instances", e))?;

        let mut instances = Vec::new();
        for reservation in resp.reservations() {
            for instance in reservation.instances() {
                let id = instance.instance_id().unwrap_or("unknown").to_string();
                let name = instance
                    .tags()
                    .iter()
                    .find(|t| t.key() == Some("Name"))
                    .and_then(|t| t.value().map(String::from));
                let state = instance
                    .state()
                    .and_then(|s| s.name())
                    .map_or_else(|| "unknown".to_string(), |s| s.as_str().to_string());
                instances.push(ManagedInstance {
                    instance_id: id,
                    name,
                    state,
                    last_transition_time: None,
                });
            }
        }
        Ok(instances)
    }

    /// Resolve instances matching tag filters.
    pub async fn resolve_instances_by_tags(
        &self,
        tags: &std::collections::HashMap<String, String>,
    ) -> Result<Vec<String>> {
        let mut filters: Vec<Filter> = tags
            .iter()
            .map(|(k, v)| {
                Filter::builder()
                    .name(format!("tag:{k}"))
                    .values(v.clone())
                    .build()
            })
            .collect();

        // Only match running or stopped instances
        filters.push(
            Filter::builder()
                .name("instance-state-name")
                .values("running")
                .values("stopped")
                .build(),
        );

        let resp = self
            .ec2
            .describe_instances()
            .set_filters(Some(filters))
            .send()
            .await
            .map_err(|e| SchedulerError::aws("ec2::describe_instances", e))?;

        let mut ids = Vec::new();
        for reservation in resp.reservations() {
            for instance in reservation.instances() {
                if let Some(id) = instance.instance_id() {
                    ids.push(id.to_string());
                }
            }
        }
        Ok(ids)
    }

    /// Build AWS config by assuming an IAM role in a target account.
    async fn build_assumed_role_config(
        region: &str,
        role_arn: &str,
    ) -> Result<aws_config::SdkConfig> {
        info!(
            "Assuming role {} in region {} for cross-account access",
            role_arn, region
        );

        let base_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region.to_string()))
            .load()
            .await;

        let assume_role_provider = aws_config::sts::AssumeRoleProvider::builder(role_arn)
            .configure(&base_config)
            .region(aws_config::Region::new(region.to_string()))
            .session_name("ec2-scheduler")
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
