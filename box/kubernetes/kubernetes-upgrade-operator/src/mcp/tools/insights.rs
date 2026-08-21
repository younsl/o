//! `get_cluster_insights`: live EKS cluster insight readings.

use serde_json::json;

use crate::eks::insights::InsightsSummary;
use crate::mcp::result::{LIST_CAP, ToolResult, Verdict};

/// Shape a fetched summary into the tool result. The severity filter keeps
/// only findings at that severity when given.
pub fn render(cluster: &str, summary: &InsightsSummary, severity: Option<&str>) -> ToolResult {
    let findings: Vec<&crate::eks::insights::InsightFinding> = summary
        .findings
        .iter()
        .filter(|f| severity.is_none_or(|s| f.severity.eq_ignore_ascii_case(s)))
        .collect();
    let truncated = findings.len() > LIST_CAP;

    let rows: Vec<serde_json::Value> = findings
        .iter()
        .take(LIST_CAP)
        .map(|f| {
            json!({
                "category": f.category,
                "severity": f.severity,
                "description": f.description,
                "recommendation": f.recommendation,
                "resources": f.resources.iter().map(|r| {
                    format!("{}:{}", r.resource_type, r.resource_id)
                }).collect::<Vec<_>>(),
            })
        })
        .collect();

    let (summary_line, verdict) = if summary.has_critical_blockers() {
        (
            format!(
                "{cluster} has {} upgrade-blocking insight(s)",
                summary.critical_count
            ),
            Verdict::Blocked,
        )
    } else if summary.warning_count > 0 {
        (
            format!(
                "{cluster} has {} insight warning(s), none blocking",
                summary.warning_count
            ),
            Verdict::Warn,
        )
    } else {
        (format!("{cluster} has no blocking insights"), Verdict::Ok)
    };

    let mut result = ToolResult::new(
        summary_line,
        verdict,
        json!({
            "totals": {
                "all": summary.total_findings,
                "critical": summary.critical_count,
                "warning": summary.warning_count,
                "passing": summary.passing_count,
                "info": summary.info_count,
            },
            "severityFilter": severity,
            "findings": rows,
        }),
    );
    result.cluster = Some(cluster.to_string());
    result.truncated = truncated;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eks::insights::{InsightFinding, InsightResource};

    fn summary() -> InsightsSummary {
        InsightsSummary {
            total_findings: 3,
            critical_count: 1,
            warning_count: 1,
            passing_count: 1,
            info_count: 0,
            findings: vec![
                InsightFinding {
                    category: "UPGRADE_READINESS".to_string(),
                    description: "deprecated API in use".to_string(),
                    severity: "ERROR".to_string(),
                    recommendation: Some("migrate off v1beta1".to_string()),
                    resources: vec![InsightResource {
                        resource_type: "deployment".to_string(),
                        resource_id: "payments/worker".to_string(),
                    }],
                },
                InsightFinding {
                    category: "UPGRADE_READINESS".to_string(),
                    description: "kubelet version skew".to_string(),
                    severity: "WARNING".to_string(),
                    recommendation: None,
                    resources: vec![],
                },
            ],
        }
    }

    #[test]
    fn test_render_blocking() {
        let result = render("prod", &summary(), None);
        assert_eq!(result.verdict, Verdict::Blocked);
        assert_eq!(result.details["findings"].as_array().unwrap().len(), 2);
        assert_eq!(
            result.details["findings"][0]["resources"][0],
            "deployment:payments/worker"
        );
    }

    #[test]
    fn test_render_severity_filter() {
        let result = render("prod", &summary(), Some("warning"));
        let rows = result.details["findings"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["severity"], "WARNING");
    }

    #[test]
    fn test_render_clean() {
        let clean = InsightsSummary {
            total_findings: 1,
            critical_count: 0,
            warning_count: 0,
            passing_count: 1,
            info_count: 0,
            findings: vec![],
        };
        let result = render("prod", &clean, None);
        assert_eq!(result.verdict, Verdict::Ok);
    }
}
