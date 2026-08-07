//! AWS API layer for ASG operations.

use tracing::{debug, warn};

/// Information about an Auto Scaling Group.
#[derive(Debug, Clone)]
pub struct AsgInfo {
    pub name: String,
    pub min_size: i32,
    pub max_size: i32,
    pub desired_capacity: i32,
    pub instances_count: usize,
    pub region: String,
}

/// List all Auto Scaling Groups in a region.
pub async fn list_asgs(
    config: &aws_config::SdkConfig,
    region: &str,
) -> anyhow::Result<Vec<AsgInfo>> {
    let region_config = aws_sdk_autoscaling::config::Builder::from(config)
        .region(aws_config::Region::new(region.to_string()))
        .build();
    let client = aws_sdk_autoscaling::Client::from_conf(region_config);

    debug!("Listing ASGs in {region}");

    let mut asgs = Vec::new();
    let mut next_token: Option<String> = None;

    loop {
        let mut req = client.describe_auto_scaling_groups();
        if let Some(ref token) = next_token {
            req = req.next_token(token);
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                warn!("Failed to describe ASGs in {region}: {e}");
                return Err(e.into());
            }
        };

        for group in resp.auto_scaling_groups() {
            asgs.push(AsgInfo {
                name: group.auto_scaling_group_name().unwrap_or("N/A").to_string(),
                min_size: group.min_size().unwrap_or(0),
                max_size: group.max_size().unwrap_or(0),
                desired_capacity: group.desired_capacity().unwrap_or(0),
                instances_count: group.instances().len(),
                region: region.to_string(),
            });
        }

        next_token = resp.next_token().map(|s| s.to_string());
        if next_token.is_none() {
            break;
        }
    }

    asgs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(asgs)
}

/// Update an Auto Scaling Group's min, max, and desired capacity.
pub async fn update_asg(
    config: &aws_config::SdkConfig,
    region: &str,
    name: &str,
    min: i32,
    max: i32,
    desired: i32,
) -> anyhow::Result<()> {
    let region_config = aws_sdk_autoscaling::config::Builder::from(config)
        .region(aws_config::Region::new(region.to_string()))
        .build();
    let client = aws_sdk_autoscaling::Client::from_conf(region_config);

    debug!("Updating ASG {name} in {region}: min={min}, max={max}, desired={desired}");

    client
        .update_auto_scaling_group()
        .auto_scaling_group_name(name)
        .min_size(min)
        .max_size(max)
        .desired_capacity(desired)
        .send()
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asg_info_clone() {
        let info = AsgInfo {
            name: "test-asg".into(),
            min_size: 1,
            max_size: 10,
            desired_capacity: 3,
            instances_count: 3,
            region: "us-east-1".into(),
        };
        let cloned = info.clone();
        assert_eq!(cloned.name, "test-asg");
        assert_eq!(cloned.min_size, 1);
        assert_eq!(cloned.max_size, 10);
        assert_eq!(cloned.desired_capacity, 3);
        assert_eq!(cloned.instances_count, 3);
        assert_eq!(cloned.region, "us-east-1");
    }
}
