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
    /// Create `AwsClients` from pre-built SDK config (for testing).
    #[cfg(test)]
    pub fn from_conf(config: &aws_config::SdkConfig) -> Self {
        Self {
            ec2: Ec2Client::new(config),
            _sts: StsClient::new(config),
            _region: "test-region".to_string(),
        }
    }

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
    pub async fn describe_instances(
        &self,
        instance_ids: &[String],
    ) -> Result<Vec<ManagedInstance>> {
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

    /// Build AWS config by assuming an IAM role in a target account (cross-account).
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

#[cfg(test)]
mod tests {
    use super::*;
    use aws_smithy_runtime::client::http::test_util::StaticReplayClient;
    use aws_smithy_types::body::SdkBody;

    /// Build an `AwsClients` with a mock HTTP client that returns canned responses.
    fn mock_clients(events: Vec<(http::StatusCode, &str)>) -> AwsClients {
        let replay_events: Vec<_> = events
            .into_iter()
            .map(|(status, body)| {
                aws_smithy_runtime::client::http::test_util::ReplayEvent::new(
                    http::Request::builder().body(SdkBody::empty()).unwrap(),
                    http::Response::builder()
                        .status(status)
                        .body(SdkBody::from(body))
                        .unwrap(),
                )
            })
            .collect();

        let http_client = StaticReplayClient::new(replay_events);
        let creds = aws_sdk_ec2::config::Credentials::new("test", "test", None, None, "test");
        let sdk_config = aws_config::SdkConfig::builder()
            .http_client(http_client)
            .credentials_provider(aws_sdk_ec2::config::SharedCredentialsProvider::new(creds))
            .behavior_version(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new("us-east-1"))
            .build();

        AwsClients {
            ec2: Ec2Client::new(&sdk_config),
            _sts: StsClient::new(&sdk_config),
            _region: "us-east-1".to_string(),
        }
    }

    // --- start_instances tests ---

    #[tokio::test]
    async fn start_instances_empty_is_noop() {
        let clients = mock_clients(vec![]);
        let result = clients.start_instances(&[]).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn start_instances_sends_request() {
        let body = r#"<StartInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
            <instancesSet>
                <item><instanceId>i-123</instanceId><currentState><code>0</code><name>pending</name></currentState></item>
            </instancesSet>
        </StartInstancesResponse>"#;
        let clients = mock_clients(vec![(http::StatusCode::OK, body)]);
        let result = clients.start_instances(&["i-123".into()]).await;
        assert!(result.is_ok());
    }

    // --- stop_instances tests ---

    #[tokio::test]
    async fn stop_instances_empty_is_noop() {
        let clients = mock_clients(vec![]);
        let result = clients.stop_instances(&[]).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn stop_instances_sends_request() {
        let body = r#"<StopInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
            <instancesSet>
                <item><instanceId>i-123</instanceId><currentState><code>64</code><name>stopping</name></currentState></item>
            </instancesSet>
        </StopInstancesResponse>"#;
        let clients = mock_clients(vec![(http::StatusCode::OK, body)]);
        let result = clients.stop_instances(&["i-123".into()]).await;
        assert!(result.is_ok());
    }

    // --- describe_instances tests ---

    #[tokio::test]
    async fn describe_instances_empty_is_noop() {
        let clients = mock_clients(vec![]);
        let result = clients.describe_instances(&[]).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn describe_instances_parses_response() {
        let body = r#"<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
            <reservationSet>
                <item>
                    <instancesSet>
                        <item>
                            <instanceId>i-abc</instanceId>
                            <instanceState><code>16</code><name>running</name></instanceState>
                            <tagSet>
                                <item><key>Name</key><value>web-server</value></item>
                            </tagSet>
                        </item>
                    </instancesSet>
                </item>
            </reservationSet>
        </DescribeInstancesResponse>"#;
        let clients = mock_clients(vec![(http::StatusCode::OK, body)]);
        let result = clients.describe_instances(&["i-abc".into()]).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].instance_id, "i-abc");
        assert_eq!(result[0].name, Some("web-server".to_string()));
        assert_eq!(result[0].state, "running");
    }

    #[tokio::test]
    async fn describe_instances_no_name_tag() {
        let body = r#"<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
            <reservationSet>
                <item>
                    <instancesSet>
                        <item>
                            <instanceId>i-noname</instanceId>
                            <instanceState><code>80</code><name>stopped</name></instanceState>
                            <tagSet></tagSet>
                        </item>
                    </instancesSet>
                </item>
            </reservationSet>
        </DescribeInstancesResponse>"#;
        let clients = mock_clients(vec![(http::StatusCode::OK, body)]);
        let result = clients
            .describe_instances(&["i-noname".into()])
            .await
            .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].instance_id, "i-noname");
        assert_eq!(result[0].name, None);
        assert_eq!(result[0].state, "stopped");
    }

    #[tokio::test]
    async fn describe_instances_multiple_reservations() {
        let body = r#"<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
            <reservationSet>
                <item>
                    <instancesSet>
                        <item>
                            <instanceId>i-001</instanceId>
                            <instanceState><code>16</code><name>running</name></instanceState>
                        </item>
                    </instancesSet>
                </item>
                <item>
                    <instancesSet>
                        <item>
                            <instanceId>i-002</instanceId>
                            <instanceState><code>16</code><name>running</name></instanceState>
                        </item>
                    </instancesSet>
                </item>
            </reservationSet>
        </DescribeInstancesResponse>"#;
        let clients = mock_clients(vec![(http::StatusCode::OK, body)]);
        let result = clients
            .describe_instances(&["i-001".into(), "i-002".into()])
            .await
            .unwrap();
        assert_eq!(result.len(), 2);
    }

    // --- resolve_instances_by_tags tests ---

    #[tokio::test]
    async fn resolve_instances_by_tags_returns_ids() {
        let body = r#"<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
            <reservationSet>
                <item>
                    <instancesSet>
                        <item><instanceId>i-111</instanceId></item>
                        <item><instanceId>i-222</instanceId></item>
                    </instancesSet>
                </item>
            </reservationSet>
        </DescribeInstancesResponse>"#;
        let clients = mock_clients(vec![(http::StatusCode::OK, body)]);
        let mut tags = std::collections::HashMap::new();
        tags.insert("Environment".to_string(), "production".to_string());
        let result = clients.resolve_instances_by_tags(&tags).await.unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.contains(&"i-111".to_string()));
        assert!(result.contains(&"i-222".to_string()));
    }
}
