use std::collections::BTreeSet;
use std::path::PathBuf;

use aws_sdk_ec2::Client as Ec2Client;

pub async fn build_config(profile: &str, region: Option<&str>) -> aws_config::SdkConfig {
    let mut loader =
        aws_config::defaults(aws_config::BehaviorVersion::latest()).profile_name(profile);

    if let Some(r) = region {
        loader = loader.region(aws_config::Region::new(r.to_string()));
    }

    loader.load().await
}

pub async fn get_account_id(config: &aws_config::SdkConfig) -> anyhow::Result<String> {
    let sts = aws_sdk_sts::Client::new(config);
    let identity = sts.get_caller_identity().send().await?;
    Ok(identity.account().unwrap_or_default().to_string())
}

pub fn get_profile_region(config: &aws_config::SdkConfig) -> Option<String> {
    config.region().map(|r| r.to_string())
}

pub async fn get_enabled_regions(config: &aws_config::SdkConfig) -> anyhow::Result<Vec<String>> {
    let ec2 = Ec2Client::new(config);
    let resp = ec2.describe_regions().all_regions(false).send().await?;

    let mut regions: Vec<String> = resp
        .regions()
        .iter()
        .filter_map(|r| r.region_name().map(String::from))
        .collect();

    regions.sort();
    Ok(regions)
}

pub fn list_profiles() -> Vec<String> {
    let mut profiles = BTreeSet::new();

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return vec![],
    };

    // Parse ~/.aws/config: [profile xxx] and [default]
    let config_path = std::env::var("AWS_CONFIG_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".aws/config"));
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        for line in content.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix('[') {
                let rest = rest.trim_end_matches(']').trim();
                if rest == "default" {
                    profiles.insert("default".to_string());
                } else if let Some(name) = rest.strip_prefix("profile ") {
                    profiles.insert(name.trim().to_string());
                }
            }
        }
    }

    // Parse ~/.aws/credentials: [xxx]
    let creds_path = std::env::var("AWS_SHARED_CREDENTIALS_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".aws/credentials"));
    if let Ok(content) = std::fs::read_to_string(&creds_path) {
        for line in content.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix('[') {
                let name = rest.trim_end_matches(']').trim();
                if !name.is_empty() {
                    profiles.insert(name.to_string());
                }
            }
        }
    }

    profiles.into_iter().collect()
}
