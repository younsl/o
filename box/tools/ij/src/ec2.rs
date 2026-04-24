//! EC2 instance discovery and management.

use aws_config::BehaviorVersion;
use aws_sdk_ec2::types::Filter;
use tabled::Tabled;
use tracing::{debug, warn};

use crate::config::{AWS_REGIONS, Config};
use crate::error::{Error, Result};

/// EC2 instance information.
#[derive(Debug, Clone, Tabled)]
pub struct Instance {
    #[tabled(rename = "NAME")]
    pub name: String,
    #[tabled(rename = "INSTANCE ID")]
    pub instance_id: String,
    #[tabled(rename = "TYPE")]
    pub instance_type: String,
    #[tabled(rename = "STATE")]
    pub state: String,
    #[tabled(rename = "AZ")]
    pub az: String,
    #[tabled(rename = "PRIVATE IP")]
    pub private_ip: String,
    #[tabled(rename = "OS")]
    pub platform: String,
    #[tabled(rename = "AGE")]
    pub age: String,
}

/// Format a duration as a human-readable age string (kubectl-style).
pub fn format_age(secs: u64) -> String {
    const MINUTE: u64 = 60;
    const HOUR: u64 = 3600;
    const DAY: u64 = 86400;

    match secs {
        s if s < MINUTE => format!("{}s", s),
        s if s < HOUR => format!("{}m", s / MINUTE),
        s if s < DAY => format!("{}h", s / HOUR),
        s => format!("{}d", s / DAY),
    }
}

impl Instance {
    /// Extract region from AZ (e.g., "ap-northeast-2a" → "ap-northeast-2").
    pub fn region(&self) -> &str {
        self.az.trim_end_matches(|c: char| c.is_ascii_alphabetic())
    }

    /// Format instance as a row for selection list.
    pub fn to_row(&self, widths: &ColumnWidths) -> String {
        format!(
            "{:<w0$}  {:<w1$}  {:<w2$}  {:<w3$}  {:<w4$}  {:<w5$}  {:<w6$}  {:<w7$}",
            self.name,
            self.instance_id,
            self.instance_type,
            self.state,
            self.az,
            self.private_ip,
            self.platform,
            self.age,
            w0 = widths.name,
            w1 = widths.instance_id,
            w2 = widths.instance_type,
            w3 = widths.state,
            w4 = widths.az,
            w5 = widths.private_ip,
            w6 = widths.platform,
            w7 = widths.age,
        )
    }
}

/// Column widths for table formatting.
#[derive(Debug, Clone)]
pub struct ColumnWidths {
    pub name: usize,
    pub instance_id: usize,
    pub instance_type: usize,
    pub state: usize,
    pub az: usize,
    pub private_ip: usize,
    pub platform: usize,
    pub age: usize,
}

impl ColumnWidths {
    /// Calculate widths from instances in a single pass.
    pub fn from_instances(instances: &[Instance]) -> Self {
        instances.iter().fold(
            Self {
                name: 4,
                instance_id: 11,
                instance_type: 4,
                state: 5,
                az: 2,
                private_ip: 10,
                platform: 5,
                age: 3,
            },
            |mut w, i| {
                w.name = w.name.max(i.name.len());
                w.instance_id = w.instance_id.max(i.instance_id.len());
                w.instance_type = w.instance_type.max(i.instance_type.len());
                w.state = w.state.max(i.state.len());
                w.az = w.az.max(i.az.len());
                w.private_ip = w.private_ip.max(i.private_ip.len());
                w.platform = w.platform.max(i.platform.len());
                w.age = w.age.max(i.age.len());
                w
            },
        )
    }

    /// Format header row.
    pub fn header(&self) -> String {
        format!(
            "{:<w0$}  {:<w1$}  {:<w2$}  {:<w3$}  {:<w4$}  {:<w5$}  {:<w6$}  {:<w7$}",
            "NAME",
            "INSTANCE ID",
            "TYPE",
            "STATE",
            "AZ",
            "PRIVATE IP",
            "OS",
            "AGE",
            w0 = self.name,
            w1 = self.instance_id,
            w2 = self.instance_type,
            w3 = self.state,
            w4 = self.az,
            w5 = self.private_ip,
            w6 = self.platform,
            w7 = self.age,
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

        let start = std::time::Instant::now();

        // Load base SDK config once (credential resolution happens only here)
        let mut config_loader = aws_config::defaults(BehaviorVersion::latest());
        if let Some(ref p) = self.config.profile {
            config_loader = config_loader.profile_name(p);
        }
        #[allow(deprecated)]
        if let Some(ref path) = self.config.aws_config_file {
            use aws_config::profile::profile_file::{ProfileFileKind, ProfileFiles};
            let profile_files = ProfileFiles::builder()
                .with_file(ProfileFileKind::Config, path)
                .include_default_credentials_file(true)
                .build();
            config_loader = config_loader.profile_files(profile_files);
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

        instances.sort_by(|a, b| a.az.cmp(&b.az).then_with(|| a.name.cmp(&b.name)));

        let elapsed = start.elapsed();

        if instances.is_empty() {
            return Err(Error::NoInstances);
        }

        Ok((instances, elapsed))
    }

    fn get_regions(&self) -> Vec<&str> {
        if let Some(ref region) = self.config.region {
            // CLI --region flag overrides everything
            vec![region.as_str()]
        } else if !self.config.scan_regions.is_empty() {
            // Use scan_regions from config file
            self.config
                .scan_regions
                .iter()
                .map(|s| s.as_str())
                .collect()
        } else {
            // Default: scan all regions
            AWS_REGIONS.to_vec()
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
            name: extract_name_tag(i).unwrap_or_else(|| "(no name)".to_string()),
            instance_id: i.instance_id().unwrap_or("N/A").to_string(),
            instance_type: i
                .instance_type()
                .map(|t| t.as_str())
                .unwrap_or("N/A")
                .to_string(),
            state: i
                .state()
                .and_then(|s| s.name())
                .map(|n| n.as_str())
                .unwrap_or("unknown")
                .to_string(),
            az: i
                .placement()
                .and_then(|p| p.availability_zone())
                .unwrap_or(region)
                .to_string(),
            private_ip: i.private_ip_address().unwrap_or("N/A").to_string(),
            age: i
                .launch_time()
                .and_then(|lt| {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .ok()?
                        .as_secs();
                    let launched = u64::try_from(lt.secs()).ok()?;
                    Some(format_age(now.saturating_sub(launched)))
                })
                .unwrap_or_else(|| "-".to_string()),
            platform: i
                .platform()
                .map(|p| p.as_str())
                .unwrap_or("Linux")
                .to_string(),
        })
        .collect();

    Ok(instances)
}

/// Start an EC2 instance. Returns the current state reported by the API.
pub async fn start_instance(
    base_config: &aws_config::SdkConfig,
    region: &str,
    instance_id: &str,
) -> Result<String> {
    let region_config = aws_sdk_ec2::config::Builder::from(base_config)
        .region(aws_config::Region::new(region.to_string()))
        .build();
    let client = aws_sdk_ec2::Client::from_conf(region_config);

    let resp = client
        .start_instances()
        .instance_ids(instance_id)
        .send()
        .await
        .map_err(|e| Error::Aws(e.to_string()))?;

    let state = resp
        .starting_instances()
        .iter()
        .find(|s| s.instance_id() == Some(instance_id))
        .and_then(|s| s.current_state())
        .and_then(|s| s.name())
        .map(|n| n.as_str().to_string())
        .unwrap_or_else(|| "pending".to_string());

    Ok(state)
}

/// Stop an EC2 instance. Returns the current state reported by the API.
pub async fn stop_instance(
    base_config: &aws_config::SdkConfig,
    region: &str,
    instance_id: &str,
) -> Result<String> {
    let region_config = aws_sdk_ec2::config::Builder::from(base_config)
        .region(aws_config::Region::new(region.to_string()))
        .build();
    let client = aws_sdk_ec2::Client::from_conf(region_config);

    let resp = client
        .stop_instances()
        .instance_ids(instance_id)
        .send()
        .await
        .map_err(|e| Error::Aws(e.to_string()))?;

    let state = resp
        .stopping_instances()
        .iter()
        .find(|s| s.instance_id() == Some(instance_id))
        .and_then(|s| s.current_state())
        .and_then(|s| s.name())
        .map(|n| n.as_str().to_string())
        .unwrap_or_else(|| "stopping".to_string());

    Ok(state)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(region: Option<&str>, scan_regions: Vec<&str>) -> Config {
        Config {
            profile: None,
            aws_config_file: None,
            region: region.map(|s| s.to_string()),
            scan_regions: scan_regions.iter().map(|s| s.to_string()).collect(),
            tag_filters: Vec::new(),
            running_only: true,
            log_level: "info".into(),
            forward: None,
            shell_commands: Vec::new(),
        }
    }

    // --- get_regions tests ---

    #[test]
    fn get_regions_cli_overrides_everything() {
        let config = test_config(Some("us-west-2"), vec!["eu-west-1", "ap-northeast-2"]);
        let scanner = Scanner::new(config);
        assert_eq!(scanner.get_regions(), vec!["us-west-2"]);
    }

    #[test]
    fn get_regions_uses_scan_regions() {
        let config = test_config(None, vec!["eu-west-1", "ap-northeast-2"]);
        let scanner = Scanner::new(config);
        assert_eq!(scanner.get_regions(), vec!["eu-west-1", "ap-northeast-2"]);
    }

    #[test]
    fn get_regions_defaults_to_all() {
        let config = test_config(None, vec![]);
        let scanner = Scanner::new(config);
        let regions = scanner.get_regions();
        assert_eq!(regions.len(), AWS_REGIONS.len());
        assert_eq!(regions, AWS_REGIONS.to_vec());
    }

    // --- build_filters tests ---

    #[test]
    fn build_filters_running_only() {
        let filters = build_filters(&[], true);
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0].name(), Some("instance-state-name"));
        assert_eq!(filters[0].values(), &["running"]);
    }

    #[test]
    fn build_filters_not_running_only() {
        let filters = build_filters(&[], false);
        assert!(filters.is_empty());
    }

    #[test]
    fn build_filters_with_tag() {
        let tags = vec!["Environment=production".to_string()];
        let filters = build_filters(&tags, false);
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0].name(), Some("tag:Environment"));
        assert_eq!(filters[0].values(), &["production"]);
    }

    #[test]
    fn build_filters_multiple_tags_and_running() {
        let tags = vec!["Environment=prod".to_string(), "Team=platform".to_string()];
        let filters = build_filters(&tags, true);
        assert_eq!(filters.len(), 3);
        assert_eq!(filters[0].name(), Some("instance-state-name"));
        assert_eq!(filters[1].name(), Some("tag:Environment"));
        assert_eq!(filters[2].name(), Some("tag:Team"));
    }

    #[test]
    fn build_filters_ignores_invalid_tag() {
        let tags = vec!["invalid-no-equals".to_string()];
        let filters = build_filters(&tags, false);
        assert!(filters.is_empty());
    }

    // --- ColumnWidths tests ---

    #[test]
    fn column_widths_empty_instances() {
        let widths = ColumnWidths::from_instances(&[]);
        assert_eq!(widths.name, 4);
        assert_eq!(widths.instance_id, 11);
        assert_eq!(widths.instance_type, 4);
        assert_eq!(widths.az, 2);
        assert_eq!(widths.private_ip, 10);
        assert_eq!(widths.age, 3);
        assert_eq!(widths.platform, 5);
    }

    #[test]
    fn column_widths_expands_for_long_values() {
        let instances = vec![Instance {
            name: "very-long-instance-name".into(),    // 23 chars > 4
            instance_id: "i-01234567890abcdef".into(), // 19 chars > 11
            instance_type: "m5.24xlarge".into(),       // 11 chars > 4
            state: "running".into(),
            az: "ap-southeast-3a".into(),         // 15 chars > 2
            private_ip: "192.168.100.200".into(), // 15 chars > 10
            age: "365d".into(),                   // 4 chars > 3
            platform: "Windows".into(),           // 7 chars > 5
        }];
        let widths = ColumnWidths::from_instances(&instances);
        assert_eq!(widths.name, 23);
        assert_eq!(widths.instance_id, 19);
        assert_eq!(widths.instance_type, 11);
        assert_eq!(widths.az, 15);
        assert_eq!(widths.private_ip, 15);
        assert_eq!(widths.age, 4);
        assert_eq!(widths.platform, 7); // "Windows" > min(5)
    }

    #[test]
    fn column_widths_header_matches_format() {
        let widths = ColumnWidths::from_instances(&[]);
        let header = widths.header();
        assert!(header.contains("NAME"));
        assert!(header.contains("INSTANCE ID"));
        assert!(header.contains("TYPE"));
        assert!(header.contains("AZ"));
        assert!(header.contains("PRIVATE IP"));
        assert!(header.contains("AGE"));
        assert!(header.contains("OS"));
    }

    #[test]
    fn instance_to_row_format() {
        let instance = Instance {
            name: "web-1".into(),
            instance_id: "i-abc123".into(),
            instance_type: "t3.micro".into(),
            state: "running".into(),
            az: "us-east-1a".into(),
            private_ip: "10.0.0.1".into(),
            platform: "Linux".into(),
            age: "5d".into(),
        };
        let widths = ColumnWidths::from_instances(&[instance.clone()]);
        let row = instance.to_row(&widths);
        assert!(row.contains("web-1"));
        assert!(row.contains("i-abc123"));
        assert!(row.contains("t3.micro"));
        assert!(row.contains("us-east-1a"));
        assert!(row.contains("10.0.0.1"));
        assert!(row.contains("Linux"));
    }

    // --- region() extraction tests ---

    #[test]
    fn region_from_az() {
        let instance = Instance {
            name: "test".into(),
            instance_id: "i-test".into(),
            instance_type: "t3.micro".into(),
            state: "running".into(),
            az: "ap-northeast-2a".into(),
            private_ip: "10.0.0.1".into(),
            platform: "Linux".into(),
            age: "1d".into(),
        };
        assert_eq!(instance.region(), "ap-northeast-2");
    }

    #[test]
    fn region_from_az_multi_letter_suffix() {
        let instance = Instance {
            name: "test".into(),
            instance_id: "i-test".into(),
            instance_type: "t3.micro".into(),
            state: "running".into(),
            az: "us-east-1f".into(),
            private_ip: "10.0.0.1".into(),
            platform: "Linux".into(),
            age: "1d".into(),
        };
        assert_eq!(instance.region(), "us-east-1");
    }

    // --- Additional edge case tests ---

    #[test]
    fn build_filters_tag_with_equals_in_value() {
        let tags = vec!["Key=Val=ue".to_string()];
        let filters = build_filters(&tags, false);
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0].name(), Some("tag:Key"));
        assert_eq!(filters[0].values(), &["Val=ue"]);
    }

    #[test]
    fn build_filters_empty_key() {
        let tags = vec!["=value".to_string()];
        let filters = build_filters(&tags, false);
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0].name(), Some("tag:"));
        assert_eq!(filters[0].values(), &["value"]);
    }

    #[test]
    fn build_filters_empty_value() {
        let tags = vec!["Key=".to_string()];
        let filters = build_filters(&tags, false);
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0].name(), Some("tag:Key"));
        assert_eq!(filters[0].values(), &[""]);
    }

    // --- extract_name_tag tests ---

    #[test]
    fn extract_name_tag_found() {
        let instance = aws_sdk_ec2::types::Instance::builder()
            .tags(
                aws_sdk_ec2::types::Tag::builder()
                    .key("Name")
                    .value("my-instance")
                    .build(),
            )
            .build();
        assert_eq!(extract_name_tag(&instance), Some("my-instance".to_string()));
    }

    #[test]
    fn extract_name_tag_not_found() {
        let instance = aws_sdk_ec2::types::Instance::builder()
            .tags(
                aws_sdk_ec2::types::Tag::builder()
                    .key("Environment")
                    .value("prod")
                    .build(),
            )
            .build();
        assert_eq!(extract_name_tag(&instance), None);
    }

    #[test]
    fn extract_name_tag_no_tags() {
        let instance = aws_sdk_ec2::types::Instance::builder().build();
        assert_eq!(extract_name_tag(&instance), None);
    }

    #[test]
    fn extract_name_tag_multiple_tags() {
        let instance = aws_sdk_ec2::types::Instance::builder()
            .tags(
                aws_sdk_ec2::types::Tag::builder()
                    .key("Environment")
                    .value("prod")
                    .build(),
            )
            .tags(
                aws_sdk_ec2::types::Tag::builder()
                    .key("Name")
                    .value("web-server")
                    .build(),
            )
            .tags(
                aws_sdk_ec2::types::Tag::builder()
                    .key("Team")
                    .value("platform")
                    .build(),
            )
            .build();
        assert_eq!(extract_name_tag(&instance), Some("web-server".to_string()));
    }

    #[test]
    fn column_widths_multiple_instances_takes_max() {
        let instances = vec![
            Instance {
                name: "short".into(),
                instance_id: "i-abc".into(),
                instance_type: "t3.micro".into(),
                state: "running".into(),
                az: "us-east-1a".into(),
                private_ip: "10.0.0.1".into(),
                age: "3d".into(),
                platform: "Linux".into(),
            },
            Instance {
                name: "very-long-instance-name".into(),
                instance_id: "i-01234567890abcdef".into(),
                instance_type: "m5.24xlarge".into(),
                state: "stopped".into(),
                az: "ap-southeast-3a".into(),
                private_ip: "192.168.100.200".into(),
                age: "120d".into(),
                platform: "Windows".into(),
            },
        ];
        let widths = ColumnWidths::from_instances(&instances);
        assert_eq!(widths.name, 23); // "very-long-instance-name"
        assert_eq!(widths.instance_id, 19); // "i-01234567890abcdef"
        assert_eq!(widths.instance_type, 11); // "m5.24xlarge"
        assert_eq!(widths.az, 15); // "ap-southeast-3a"
        assert_eq!(widths.private_ip, 15); // "192.168.100.200"
        assert_eq!(widths.age, 4); // "120d"
        assert_eq!(widths.platform, 7); // "Windows"(7) > min(5)
    }

    // --- format_age tests ---

    #[test]
    fn format_age_seconds() {
        assert_eq!(format_age(0), "0s");
        assert_eq!(format_age(59), "59s");
    }

    #[test]
    fn format_age_minutes() {
        assert_eq!(format_age(60), "1m");
        assert_eq!(format_age(3599), "59m");
    }

    #[test]
    fn format_age_hours() {
        assert_eq!(format_age(3600), "1h");
        assert_eq!(format_age(86399), "23h");
    }

    #[test]
    fn format_age_days() {
        assert_eq!(format_age(86400), "1d");
        assert_eq!(format_age(86400 * 365), "365d");
    }
}
