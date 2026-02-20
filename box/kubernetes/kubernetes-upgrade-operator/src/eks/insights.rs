//! EKS Cluster Insights operations.

use anyhow::Result;
use aws_sdk_eks::Client;
use tracing::{debug, info};

use crate::error::KuoError;

/// Insight finding information.
#[derive(Debug, Clone)]
pub struct InsightFinding {
    pub category: String,
    pub description: String,
    pub severity: String,
    pub recommendation: Option<String>,
    pub resources: Vec<InsightResource>,
}

/// Resource affected by an insight finding.
#[derive(Debug, Clone)]
pub struct InsightResource {
    /// Resource type (e.g., "deployment", "pod", "addon")
    pub resource_type: String,
    /// Resource identifier (e.g., "kube-system/coredns", "vpc-cni")
    pub resource_id: String,
}

/// Cluster insights summary.
#[derive(Debug, Clone)]
pub struct InsightsSummary {
    pub total_findings: usize,
    pub critical_count: usize,
    pub warning_count: usize,
    pub passing_count: usize,
    pub info_count: usize,
    pub findings: Vec<InsightFinding>,
}

impl InsightsSummary {
    /// Check if there are any critical blockers.
    pub fn has_critical_blockers(&self) -> bool {
        self.critical_count > 0
    }
}

/// List insights for a cluster.
pub async fn list_insights(client: &Client, cluster_name: &str) -> Result<InsightsSummary> {
    info!("Fetching cluster insights for: {}", cluster_name);

    let response = client
        .list_insights()
        .cluster_name(cluster_name)
        .send()
        .await
        .map_err(|e| KuoError::aws(module_path!(), e))?;

    let mut findings = Vec::new();
    let mut critical_count = 0;
    let mut warning_count = 0;
    let mut passing_count = 0;
    let mut info_count = 0;

    for insight in response.insights() {
        let status = insight
            .insight_status()
            .and_then(|s| s.status())
            .map(|s| s.as_str().to_string())
            .unwrap_or_else(|| "UNKNOWN".to_string());

        match status.as_str() {
            "ERROR" | "CRITICAL" => critical_count += 1,
            "WARNING" => warning_count += 1,
            "PASSING" => passing_count += 1,
            _ => info_count += 1,
        }

        // Get insight details
        if let Some(insight_id) = insight.id()
            && let Ok(Some(finding)) = describe_insight(client, cluster_name, insight_id).await
        {
            findings.push(finding);
        }
    }

    let summary = InsightsSummary {
        total_findings: findings.len(),
        critical_count,
        warning_count,
        passing_count,
        info_count,
        findings,
    };

    debug!(
        "Found {} insights ({} critical, {} warnings)",
        summary.total_findings, summary.critical_count, summary.warning_count
    );

    Ok(summary)
}

/// Describe a specific insight.
pub async fn describe_insight(
    client: &Client,
    cluster_name: &str,
    insight_id: &str,
) -> Result<Option<InsightFinding>> {
    debug!("Describing insight: {}", insight_id);

    let response = client
        .describe_insight()
        .cluster_name(cluster_name)
        .id(insight_id)
        .send()
        .await
        .map_err(|e| KuoError::aws(module_path!(), e))?;

    if let Some(insight) = response.insight() {
        let resources: Vec<InsightResource> = insight
            .resources()
            .iter()
            .filter_map(|r| {
                // Try to get resource identifier from various fields
                // 1. Check ARN first (for AWS resources like add-ons)
                if let Some(arn) = r.arn() {
                    // ARN format: arn:aws:eks:region:account:addon/cluster-name/addon-name/id
                    // Split by '/' gives: [arn:aws:eks:...:addon, cluster-name, addon-name, id]
                    let parts: Vec<&str> = arn.split('/').collect();
                    if parts.len() >= 3 {
                        // parts[2] is the addon name (e.g., "vpc-cni", "coredns", "kube-proxy")
                        return Some(InsightResource {
                            resource_type: "addon".to_string(),
                            resource_id: parts[2].to_string(),
                        });
                    }
                    return Some(InsightResource {
                        resource_type: "resource".to_string(),
                        resource_id: arn.to_string(),
                    });
                }

                // 2. Check kubernetes_resource_uri (for K8s resources)
                if let Some(uri) = r.kubernetes_resource_uri()
                    && !uri.is_empty()
                {
                    let parts: Vec<&str> = uri.split('/').collect();
                    let (resource_type, resource_id) = if parts.len() >= 4 {
                        (parts[2].to_string(), format!("{}/{}", parts[1], parts[3]))
                    } else if parts.len() >= 2 {
                        (parts[0].to_string(), parts[1].to_string())
                    } else {
                        ("resource".to_string(), uri.to_string())
                    };
                    return Some(InsightResource {
                        resource_type,
                        resource_id,
                    });
                }

                None
            })
            .collect();

        let finding = InsightFinding {
            category: insight
                .category()
                .map(|c| c.as_str().to_string())
                .unwrap_or_default(),
            description: insight.description().unwrap_or_default().to_string(),
            severity: insight
                .insight_status()
                .and_then(|s| s.status())
                .map(|s| s.as_str().to_string())
                .unwrap_or_default(),
            recommendation: insight.recommendation().map(|s| s.to_string()),
            resources,
        };

        return Ok(Some(finding));
    }

    Ok(None)
}

/// Check upgrade readiness based on insights.
pub async fn check_upgrade_readiness(
    client: &Client,
    cluster_name: &str,
) -> Result<(bool, InsightsSummary)> {
    let summary = list_insights(client, cluster_name).await?;

    let is_ready = !summary.has_critical_blockers();

    if is_ready {
        info!("Cluster {} is ready for upgrade", cluster_name);
    } else {
        info!(
            "Cluster {} has {} critical issues that may block upgrade",
            cluster_name, summary.critical_count
        );
    }

    Ok((is_ready, summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_summary(critical: usize, warning: usize, info: usize) -> InsightsSummary {
        InsightsSummary {
            total_findings: critical + warning + info,
            critical_count: critical,
            warning_count: warning,
            passing_count: 0,
            info_count: info,
            findings: vec![],
        }
    }

    #[test]
    fn test_has_critical_blockers_with_critical() {
        let summary = create_test_summary(1, 2, 3);
        assert!(summary.has_critical_blockers());
    }

    #[test]
    fn test_has_critical_blockers_without_critical() {
        let summary = create_test_summary(0, 5, 10);
        assert!(!summary.has_critical_blockers());
    }

    #[test]
    fn test_has_critical_blockers_empty() {
        let summary = create_test_summary(0, 0, 0);
        assert!(!summary.has_critical_blockers());
    }

    #[test]
    fn test_insight_resource_creation() {
        let resource = InsightResource {
            resource_type: "addon".to_string(),
            resource_id: "vpc-cni".to_string(),
        };
        assert_eq!(resource.resource_type, "addon");
        assert_eq!(resource.resource_id, "vpc-cni");
    }

    #[test]
    fn test_insight_finding_creation() {
        let finding = InsightFinding {
            category: "UPGRADE_READINESS".to_string(),
            description: "Test description".to_string(),
            severity: "WARNING".to_string(),
            recommendation: Some("Fix it".to_string()),
            resources: vec![],
        };
        assert_eq!(finding.category, "UPGRADE_READINESS");
        assert_eq!(finding.severity, "WARNING");
        assert!(finding.recommendation.is_some());
    }

    #[test]
    fn test_insights_summary_counts() {
        let summary = InsightsSummary {
            total_findings: 6,
            critical_count: 1,
            warning_count: 2,
            passing_count: 2,
            info_count: 1,
            findings: vec![],
        };
        assert_eq!(
            summary.total_findings,
            summary.critical_count
                + summary.warning_count
                + summary.passing_count
                + summary.info_count
        );
    }

    #[test]
    fn test_insights_summary_with_findings() {
        let finding = InsightFinding {
            category: "UPGRADE_READINESS".to_string(),
            description: "Deprecated API usage".to_string(),
            severity: "WARNING".to_string(),
            recommendation: Some("Migrate to new API".to_string()),
            resources: vec![],
        };
        let summary = InsightsSummary {
            total_findings: 1,
            critical_count: 0,
            warning_count: 1,
            passing_count: 0,
            info_count: 0,
            findings: vec![finding],
        };
        assert_eq!(summary.findings.len(), 1);
        assert_eq!(summary.findings[0].description, "Deprecated API usage");
    }

    #[test]
    fn test_insight_finding_with_resources() {
        let finding = InsightFinding {
            category: "UPGRADE_READINESS".to_string(),
            description: "Addon needs update".to_string(),
            severity: "WARNING".to_string(),
            recommendation: None,
            resources: vec![
                InsightResource {
                    resource_type: "addon".to_string(),
                    resource_id: "vpc-cni".to_string(),
                },
                InsightResource {
                    resource_type: "addon".to_string(),
                    resource_id: "coredns".to_string(),
                },
            ],
        };
        assert_eq!(finding.resources.len(), 2);
        assert_eq!(finding.resources[0].resource_id, "vpc-cni");
        assert_eq!(finding.resources[1].resource_id, "coredns");
    }
}
