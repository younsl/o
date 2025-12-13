use anyhow::{Context, Result};
use aws_config::BehaviorVersion;
use aws_sdk_ec2::Client;
use tracing::{debug, info};

pub struct Ec2Client {
    pub(super) client: Client,
    pub(super) region: String,
}

impl Ec2Client {
    /// Creates a new EC2 client with AWS SDK configuration
    ///
    /// Region resolution priority:
    /// 1. Explicit region from Config (--region CLI arg or AWS_REGION env var)
    /// 2. AWS SDK defaults (environment variables, ~/.aws/config, IMDS)
    pub async fn new(region: Option<&str>) -> Result<Self> {
        info!("Initializing AWS SDK configuration");

        let config = Self::load_aws_config(region).await;
        let region_name = Self::extract_region_name(&config);
        let client = Client::new(&config);

        info!(
            region = %region_name,
            "AWS EC2 client initialized successfully"
        );

        Ok(Self {
            client,
            region: region_name,
        })
    }

    /// Loads AWS SDK configuration with optional explicit region
    ///
    /// This function is responsible for AWS SDK initialization only.
    /// Region configuration should come from the Config struct to avoid duplication.
    async fn load_aws_config(region: Option<&str>) -> aws_config::SdkConfig {
        match region {
            Some(r) => {
                info!(region = %r, "Using explicit AWS region from configuration");
                aws_config::defaults(BehaviorVersion::latest())
                    .region(aws_config::Region::new(r.to_string()))
                    .load()
                    .await
            }
            None => {
                debug!("Using default AWS region from AWS SDK (environment/credentials file/IMDS)");
                aws_config::load_defaults(BehaviorVersion::latest()).await
            }
        }
    }

    fn extract_region_name(config: &aws_config::SdkConfig) -> String {
        config
            .region()
            .map(|r| r.as_ref())
            .unwrap_or("unknown")
            .to_string()
    }

    pub fn region(&self) -> &str {
        &self.region
    }

    /// Test EC2 API connectivity by making a simple DescribeRegions call
    pub async fn test_connectivity(&self) -> Result<()> {
        let endpoint = format!("https://ec2.{}.amazonaws.com", self.region);
        debug!(
            endpoint = %endpoint,
            "Testing EC2 API connectivity"
        );

        let start_time = std::time::Instant::now();

        self.client
            .describe_regions()
            .send()
            .await
            .context("Failed to connect to EC2 API endpoint")?;

        let response_time_ms = start_time.elapsed().as_millis();

        info!(
            region = %self.region,
            endpoint = %endpoint,
            response_time_ms = response_time_ms,
            "EC2 API connectivity test successful"
        );

        Ok(())
    }

    pub async fn reboot_instance(&self, instance_id: &str) -> Result<()> {
        info!(
            instance_id = %instance_id,
            region = %self.region,
            api_action = "RebootInstances",
            "Sending reboot request to AWS EC2 API"
        );

        self.client
            .reboot_instances()
            .instance_ids(instance_id)
            .send()
            .await
            .context(format!("Failed to reboot instance {}", instance_id))?;

        Ok(())
    }
}
