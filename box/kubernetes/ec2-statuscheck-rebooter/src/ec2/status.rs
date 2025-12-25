use anyhow::{Context, Result};
use aws_sdk_ec2::types::Filter;
use std::collections::HashMap;
use tracing::{debug, info, warn};

use super::Ec2Client;
use super::InstanceStatus;

const STATUS_IMPAIRED: &str = "impaired";

impl Ec2Client {
    pub async fn get_instance_statuses(
        &self,
        tag_filters: &[String],
        failure_tracker: &HashMap<String, u32>,
    ) -> Result<(usize, Vec<InstanceStatus>)> {
        let request = self.build_status_request(tag_filters);
        let response = request
            .send()
            .await
            .context("Failed to describe instance status")?;

        let total_instances = response.instance_statuses().len();
        debug!(
            total_instances = total_instances,
            "Received response from DescribeInstanceStatus API"
        );

        let instance_ids = Self::extract_instance_ids(&response);
        let tags_map = self.get_instance_tags(&instance_ids).await?;
        let statuses = Self::process_instance_statuses(&response, &tags_map, failure_tracker);

        if !statuses.is_empty() {
            info!(
                total_checked = total_instances,
                impaired_count = statuses.len(),
                "Status check summary"
            );
        }

        Ok((total_instances, statuses))
    }

    fn build_status_request(
        &self,
        tag_filters: &[String],
    ) -> aws_sdk_ec2::operation::describe_instance_status::builders::DescribeInstanceStatusFluentBuilder
    {
        let mut request = self
            .client
            .describe_instance_status()
            .include_all_instances(false);

        let mut filter_count = 0;
        for tag_filter in tag_filters {
            if let Some(filter) = Self::parse_tag_filter(tag_filter) {
                request = request.filters(filter);
                filter_count += 1;
            }
        }

        debug!(
            applied_filters = filter_count,
            "Sending DescribeInstanceStatus API request"
        );

        request
    }

    fn parse_tag_filter(tag_filter: &str) -> Option<Filter> {
        tag_filter
            .split_once('=')
            .map(|(key, value)| {
                debug!(
                    tag_key = %key,
                    tag_value = %value,
                    "Adding tag filter to EC2 API request"
                );
                Filter::builder()
                    .name(format!("tag:{}", key))
                    .values(value)
                    .build()
            })
            .or_else(|| {
                warn!(
                    invalid_filter = %tag_filter,
                    "Skipping invalid tag filter (expected format: Key=Value)"
                );
                None
            })
    }

    fn extract_instance_ids(
        response: &aws_sdk_ec2::operation::describe_instance_status::DescribeInstanceStatusOutput,
    ) -> Vec<String> {
        response
            .instance_statuses()
            .iter()
            .filter_map(|s| s.instance_id().map(|id| id.to_string()))
            .collect()
    }

    fn process_instance_statuses(
        response: &aws_sdk_ec2::operation::describe_instance_status::DescribeInstanceStatusOutput,
        tags_map: &HashMap<String, String>,
        failure_tracker: &HashMap<String, u32>,
    ) -> Vec<InstanceStatus> {
        response
            .instance_statuses()
            .iter()
            .filter_map(|status| Self::create_instance_status(status, tags_map, failure_tracker))
            .collect()
    }

    fn create_instance_status(
        status: &aws_sdk_ec2::types::InstanceStatus,
        tags_map: &HashMap<String, String>,
        failure_tracker: &HashMap<String, u32>,
    ) -> Option<InstanceStatus> {
        let instance_id = status.instance_id().unwrap_or("unknown").to_string();
        let instance_name = tags_map.get(&instance_id).cloned();
        let availability_zone = status.availability_zone().unwrap_or("unknown").to_string();

        let system_status = Self::extract_status_value(status.system_status());
        let instance_status = Self::extract_status_value(status.instance_status());

        debug!(
            instance_id = %instance_id,
            instance_name = ?instance_name,
            availability_zone = %availability_zone,
            system_status = %system_status,
            instance_status = %instance_status,
            "Checking instance status"
        );

        if Self::has_impaired_status(&system_status, &instance_status) {
            let failure_count = failure_tracker.get(&instance_id).unwrap_or(&0) + 1;

            debug!(
                instance_id = %instance_id,
                instance_name = ?instance_name,
                failure_count = failure_count,
                "Instance has impaired status, incrementing failure count"
            );

            Some(InstanceStatus {
                instance_id,
                instance_name,
                instance_type: String::new(),
                availability_zone,
                system_status,
                instance_status,
                failure_count,
            })
        } else {
            None
        }
    }

    fn extract_status_value(status: Option<&aws_sdk_ec2::types::InstanceStatusSummary>) -> String {
        status
            .and_then(|s| s.status())
            .map(|s| s.as_str())
            .unwrap_or("unknown")
            .to_string()
    }

    pub(super) fn has_impaired_status(system_status: &str, instance_status: &str) -> bool {
        system_status == STATUS_IMPAIRED || instance_status == STATUS_IMPAIRED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_both_ok() {
        assert_eq!(Ec2Client::has_impaired_status("ok", "ok"), false);
    }

    #[test]
    fn test_system_impaired_instance_ok() {
        assert_eq!(Ec2Client::has_impaired_status("impaired", "ok"), true);
    }

    #[test]
    fn test_system_ok_instance_impaired() {
        assert_eq!(Ec2Client::has_impaired_status("ok", "impaired"), true);
    }

    #[test]
    fn test_both_impaired() {
        assert_eq!(Ec2Client::has_impaired_status("impaired", "impaired"), true);
    }

    #[test]
    fn test_system_insufficient_data_instance_ok() {
        assert_eq!(
            Ec2Client::has_impaired_status("insufficient-data", "ok"),
            false
        );
    }

    #[test]
    fn test_system_ok_instance_insufficient_data() {
        assert_eq!(
            Ec2Client::has_impaired_status("ok", "insufficient-data"),
            false
        );
    }

    #[test]
    fn test_both_insufficient_data() {
        assert_eq!(
            Ec2Client::has_impaired_status("insufficient-data", "insufficient-data"),
            false
        );
    }

    #[test]
    fn test_system_impaired_instance_insufficient_data() {
        assert_eq!(
            Ec2Client::has_impaired_status("impaired", "insufficient-data"),
            true
        );
    }

    #[test]
    fn test_system_insufficient_data_instance_impaired() {
        assert_eq!(
            Ec2Client::has_impaired_status("insufficient-data", "impaired"),
            true
        );
    }

    #[test]
    fn test_initializing_status() {
        assert_eq!(
            Ec2Client::has_impaired_status("initializing", "initializing"),
            false
        );
    }

    #[test]
    fn test_system_initializing_instance_ok() {
        assert_eq!(Ec2Client::has_impaired_status("initializing", "ok"), false);
    }

    #[test]
    fn test_system_ok_instance_initializing() {
        assert_eq!(Ec2Client::has_impaired_status("ok", "initializing"), false);
    }

    #[test]
    fn test_system_impaired_instance_initializing() {
        assert_eq!(
            Ec2Client::has_impaired_status("impaired", "initializing"),
            true
        );
    }

    #[test]
    fn test_system_initializing_instance_impaired() {
        assert_eq!(
            Ec2Client::has_impaired_status("initializing", "impaired"),
            true
        );
    }

    #[test]
    fn test_not_applicable_status() {
        assert_eq!(
            Ec2Client::has_impaired_status("not-applicable", "not-applicable"),
            false
        );
    }

    #[test]
    fn test_system_not_applicable_instance_ok() {
        assert_eq!(
            Ec2Client::has_impaired_status("not-applicable", "ok"),
            false
        );
    }

    #[test]
    fn test_system_impaired_instance_not_applicable() {
        assert_eq!(
            Ec2Client::has_impaired_status("impaired", "not-applicable"),
            true
        );
    }

    #[test]
    fn test_unknown_status() {
        assert_eq!(Ec2Client::has_impaired_status("unknown", "unknown"), false);
    }

    #[test]
    fn test_system_unknown_instance_impaired() {
        assert_eq!(Ec2Client::has_impaired_status("unknown", "impaired"), true);
    }

    #[test]
    fn test_system_impaired_instance_unknown() {
        assert_eq!(Ec2Client::has_impaired_status("impaired", "unknown"), true);
    }

    #[test]
    fn test_empty_strings() {
        assert_eq!(Ec2Client::has_impaired_status("", ""), false);
    }

    #[test]
    fn test_system_empty_instance_impaired() {
        assert_eq!(Ec2Client::has_impaired_status("", "impaired"), true);
    }

    #[test]
    fn test_system_impaired_instance_empty() {
        assert_eq!(Ec2Client::has_impaired_status("impaired", ""), true);
    }

    #[test]
    fn test_case_sensitivity() {
        // AWS returns exact lowercase "impaired"
        assert_eq!(Ec2Client::has_impaired_status("Impaired", "ok"), false);
        assert_eq!(Ec2Client::has_impaired_status("ok", "IMPAIRED"), false);
    }

    #[test]
    fn test_whitespace_handling() {
        // AWS returns exact values without whitespace
        assert_eq!(Ec2Client::has_impaired_status(" impaired ", "ok"), false);
        assert_eq!(Ec2Client::has_impaired_status("ok", "impaired "), false);
    }

    #[test]
    fn test_partial_string_match() {
        assert_eq!(Ec2Client::has_impaired_status("impaire", "ok"), false);
        assert_eq!(Ec2Client::has_impaired_status("ok", "mpaired"), false);
    }
}
