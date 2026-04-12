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

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn with_aws_files(config_content: &str, creds_content: &str) -> Vec<String> {
        let mut config_file = NamedTempFile::new().unwrap();
        write!(config_file, "{}", config_content).unwrap();
        let mut creds_file = NamedTempFile::new().unwrap();
        write!(creds_file, "{}", creds_content).unwrap();

        // SAFETY: Tests using this helper run serially via #[serial], so no
        // concurrent access to environment variables occurs.
        unsafe {
            std::env::set_var("AWS_CONFIG_FILE", config_file.path());
            std::env::set_var("AWS_SHARED_CREDENTIALS_FILE", creds_file.path());
        }

        let result = list_profiles();

        // SAFETY: Tests using this helper run serially via #[serial].
        unsafe {
            std::env::remove_var("AWS_CONFIG_FILE");
            std::env::remove_var("AWS_SHARED_CREDENTIALS_FILE");
        }

        result
    }

    #[test]
    #[serial]
    fn test_list_profiles_config_file() {
        let profiles = with_aws_files(
            "[default]\nregion=us-east-1\n\n[profile dev]\nregion=ap-northeast-2\n\n[profile prod]\nregion=eu-west-1\n",
            "",
        );
        assert!(profiles.contains(&"default".to_string()));
        assert!(profiles.contains(&"dev".to_string()));
        assert!(profiles.contains(&"prod".to_string()));
    }

    #[test]
    #[serial]
    fn test_list_profiles_credentials_file() {
        let profiles = with_aws_files(
            "",
            "[default]\naws_access_key_id=xxx\n\n[staging]\naws_access_key_id=yyy\n",
        );
        assert!(profiles.contains(&"default".to_string()));
        assert!(profiles.contains(&"staging".to_string()));
    }

    #[test]
    #[serial]
    fn test_list_profiles_combined_dedup() {
        let profiles = with_aws_files(
            "[default]\nregion=us-east-1\n[profile dev]\n",
            "[default]\naws_access_key_id=xxx\n[dev]\naws_access_key_id=yyy\n",
        );
        assert_eq!(profiles.iter().filter(|p| *p == "default").count(), 1);
        assert_eq!(profiles.iter().filter(|p| *p == "dev").count(), 1);
    }

    #[test]
    #[serial]
    fn test_list_profiles_sorted() {
        let profiles = with_aws_files("[profile z-profile]\n[profile a-profile]\n[default]\n", "");
        assert_eq!(profiles, vec!["a-profile", "default", "z-profile"]);
    }

    #[test]
    #[serial]
    fn test_list_profiles_missing_files() {
        // SAFETY: Tests using this helper run serially via #[serial].
        unsafe {
            std::env::set_var("AWS_CONFIG_FILE", "/nonexistent/config");
            std::env::set_var("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent/credentials");
        }
        let profiles = list_profiles();
        unsafe {
            std::env::remove_var("AWS_CONFIG_FILE");
            std::env::remove_var("AWS_SHARED_CREDENTIALS_FILE");
        }
        assert!(profiles.is_empty());
    }

    #[test]
    #[serial]
    fn test_list_profiles_empty_files() {
        let profiles = with_aws_files("", "");
        assert!(profiles.is_empty());
    }

    #[test]
    #[serial]
    fn test_list_profiles_ignores_empty_section() {
        let profiles = with_aws_files("", "[]\n");
        assert!(profiles.is_empty());
    }
}
