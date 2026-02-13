//! EC2 instance discovery and management.

use aws_config::BehaviorVersion;
use aws_sdk_ec2::types::Filter;
use colored::Colorize;
use tabled::Tabled;
use tracing::{debug, warn};

use crate::config::{AWS_REGIONS, Config};
use crate::error::{Error, Result};

/// EC2 instance information.
#[derive(Debug, Clone, Tabled)]
pub struct Instance {
    #[tabled(rename = "REGION")]
    pub region: String,
    #[tabled(rename = "NAME")]
    pub name: String,
    #[tabled(rename = "INSTANCE ID")]
    pub instance_id: String,
    #[tabled(rename = "TYPE")]
    pub instance_type: String,
    #[tabled(rename = "PRIVATE IP")]
    pub private_ip: String,
    #[tabled(rename = "PLATFORM")]
    pub platform: String,
}

impl Instance {
    /// Format instance as a row for selection list.
    pub fn to_row(&self, widths: &ColumnWidths) -> String {
        format!(
            "{:<w0$}  {:<w1$}  {:<w2$}  {:<w3$}  {:<w4$}  {:<w5$}",
            self.region,
            self.name,
            self.instance_id,
            self.instance_type,
            self.private_ip,
            self.platform,
            w0 = widths.region,
            w1 = widths.name,
            w2 = widths.instance_id,
            w3 = widths.instance_type,
            w4 = widths.private_ip,
            w5 = widths.platform,
        )
    }
}

/// Column widths for table formatting.
#[derive(Debug, Clone)]
pub struct ColumnWidths {
    pub region: usize,
    pub name: usize,
    pub instance_id: usize,
    pub instance_type: usize,
    pub private_ip: usize,
    pub platform: usize,
}

impl ColumnWidths {
    /// Calculate widths from instances in a single pass.
    pub fn from_instances(instances: &[Instance]) -> Self {
        instances.iter().fold(
            Self {
                region: 6,
                name: 4,
                instance_id: 11,
                instance_type: 4,
                private_ip: 10,
                platform: 8,
            },
            |mut w, i| {
                w.region = w.region.max(i.region.len());
                w.name = w.name.max(i.name.len());
                w.instance_id = w.instance_id.max(i.instance_id.len());
                w.instance_type = w.instance_type.max(i.instance_type.len());
                w.private_ip = w.private_ip.max(i.private_ip.len());
                w.platform = w.platform.max(i.platform.len());
                w
            },
        )
    }

    /// Format header row.
    pub fn header(&self) -> String {
        format!(
            "{:<w0$}  {:<w1$}  {:<w2$}  {:<w3$}  {:<w4$}  {:<w5$}",
            "REGION",
            "NAME",
            "INSTANCE ID",
            "TYPE",
            "PRIVATE IP",
            "PLATFORM",
            w0 = self.region,
            w1 = self.name,
            w2 = self.instance_id,
            w3 = self.instance_type,
            w4 = self.private_ip,
            w5 = self.platform,
        )
    }
}

/// EC2 instance scanner.
pub struct Scanner {
    config: Config,
}

impl Scanner {
    /// Create a new scanner with the given config.
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    /// Fetch all instances matching the configuration.
    ///
    /// Returns the instances and the elapsed time for scanning.
    pub async fn fetch_instances(&self) -> Result<(Vec<Instance>, std::time::Duration)> {
        let regions = self.get_regions();

        println!(
            "{} {} region(s)...",
            "Scanning".bright_blue().bold(),
            regions.len().to_string().bright_yellow()
        );

        let start = std::time::Instant::now();

        // Load base SDK config once (credential resolution happens only here)
        let mut config_loader = aws_config::defaults(BehaviorVersion::latest());
        if let Some(ref p) = self.config.profile {
            config_loader = config_loader.profile_name(p);
        }
        let base_sdk_config = config_loader.load().await;

        let num_regions = regions.len();
        let tasks: Vec<_> = regions
            .into_iter()
            .map(|region| {
                let region = region.to_string();
                let tag_filters = self.config.tag_filters.clone();
                let running_only = self.config.running_only;
                let base_config = base_sdk_config.clone();

                tokio::spawn(async move {
                    fetch_region_instances_with_config(
                        &base_config,
                        &region,
                        &tag_filters,
                        running_only,
                    )
                    .await
                })
            })
            .collect();

        let mut instances = Vec::with_capacity(num_regions * 10);
        for task in tasks {
            match task.await {
                Ok(Ok(region_instances)) => instances.extend(region_instances),
                Ok(Err(e)) => warn!("Error fetching instances: {}", e),
                Err(e) => warn!("Task failed: {}", e),
            }
        }

        instances.sort_by(|a, b| a.region.cmp(&b.region).then_with(|| a.name.cmp(&b.name)));

        let elapsed = start.elapsed();

        if instances.is_empty() {
            return Err(Error::NoInstances);
        }

        Ok((instances, elapsed))
    }

    fn get_regions(&self) -> Vec<&str> {
        match &self.config.region {
            Some(region) => vec![region.as_str()],
            None => AWS_REGIONS.to_vec(),
        }
    }
}

async fn fetch_region_instances_with_config(
    base_config: &aws_config::SdkConfig,
    region: &str,
    tag_filters: &[String],
    running_only: bool,
) -> Result<Vec<Instance>> {
    debug!("Scanning region: {}", region);

    let region_config = aws_sdk_ec2::config::Builder::from(base_config)
        .region(aws_config::Region::new(region.to_string()))
        .build();
    let client = aws_sdk_ec2::Client::from_conf(region_config);

    let filters = build_filters(tag_filters, running_only);
    let mut request = client.describe_instances();
    if !filters.is_empty() {
        request = request.set_filters(Some(filters));
    }

    let resp = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            debug!("Failed to describe instances in {}: {}", region, e);
            return Ok(Vec::new());
        }
    };

    let instances = resp
        .reservations()
        .iter()
        .flat_map(|r| r.instances())
        .map(|i| Instance {
            region: region.to_string(),
            name: extract_name_tag(i).unwrap_or_else(|| "(no name)".to_string()),
            instance_id: i.instance_id().unwrap_or("N/A").to_string(),
            instance_type: i
                .instance_type()
                .map(|t| t.as_str())
                .unwrap_or("N/A")
                .to_string(),
            private_ip: i.private_ip_address().unwrap_or("N/A").to_string(),
            platform: i
                .platform()
                .map(|p| p.as_str())
                .unwrap_or("Linux")
                .to_string(),
        })
        .collect();

    Ok(instances)
}

fn build_filters(tag_filters: &[String], running_only: bool) -> Vec<Filter> {
    let mut filters = Vec::new();

    if running_only {
        filters.push(
            Filter::builder()
                .name("instance-state-name")
                .values("running")
                .build(),
        );
    }

    for tag_filter in tag_filters {
        if let Some((key, value)) = tag_filter.split_once('=') {
            filters.push(
                Filter::builder()
                    .name(format!("tag:{}", key))
                    .values(value)
                    .build(),
            );
        } else {
            warn!(
                "Invalid tag filter format '{}', expected Key=Value",
                tag_filter
            );
        }
    }

    filters
}

fn extract_name_tag(instance: &aws_sdk_ec2::types::Instance) -> Option<String> {
    instance
        .tags()
        .iter()
        .find(|tag| tag.key() == Some("Name"))
        .and_then(|tag| tag.value())
        .map(|s| s.to_string())
}
