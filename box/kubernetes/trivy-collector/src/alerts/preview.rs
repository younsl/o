//! Run a rule's matchers against already-stored SBOM reports without firing
//! receivers. Used by the rule editor to show what current data would match.
//!
//! Matching is delegated to SQL (`Database::list_sbom_component_matches`),
//! so every stored SBOM contributes — earlier revisions of this code only
//! scanned the 200 most-recently-updated reports, which silently hid
//! components in older SBOMs from rule authors.

use serde::Serialize;
use utoipa::ToSchema;

use super::expr::VersionExpr;
use super::types::Matchers;
use crate::storage::Database;

const MAX_MATCHES: usize = 50;

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PreviewMatch {
    pub cluster: String,
    pub namespace: String,
    pub name: String,
    pub package: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PreviewResult {
    pub items: Vec<PreviewMatch>,
    pub total: usize,
    pub truncated: bool,
    /// Number of distinct workloads (cluster+namespace+name) contributing
    /// at least one matching component. Field name kept as `scanned_reports`
    /// for frontend compatibility — the prior implementation populated this
    /// with the size of a 200-row sample window, which no longer exists.
    #[serde(rename = "scanned_reports")]
    pub matched_workloads: usize,
}

pub async fn run(db: &Database, matchers: &Matchers) -> Result<PreviewResult, String> {
    let expr = match matchers.version_expr.as_deref() {
        Some(s) => Some(VersionExpr::parse(s).map_err(|e| format!("version_expr: {}", e))?),
        None => None,
    };

    let rows = db
        .list_sbom_component_matches(
            &matchers.clusters,
            matchers.namespace.as_deref(),
            matchers.package_name.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    let mut total = 0usize;
    let mut workloads = std::collections::HashSet::new();

    for row in rows {
        if let Some(ref e) = expr
            && !e.matches(&row.version)
        {
            continue;
        }
        total += 1;
        workloads.insert((
            row.cluster.clone(),
            row.namespace.clone(),
            row.workload_name.clone(),
        ));
        if items.len() < MAX_MATCHES {
            items.push(PreviewMatch {
                cluster: row.cluster,
                namespace: row.namespace,
                name: row.workload_name,
                package: row.package_name,
                version: row.version,
            });
        }
    }

    Ok(PreviewResult {
        truncated: total > items.len(),
        matched_workloads: workloads.len(),
        items,
        total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::types::ReportPayload;
    use serde_json::json;

    fn sbom_payload(
        cluster: &str,
        namespace: &str,
        name: &str,
        components: serde_json::Value,
    ) -> ReportPayload {
        ReportPayload {
            cluster: cluster.to_string(),
            namespace: namespace.to_string(),
            name: name.to_string(),
            report_type: "sbomreport".to_string(),
            data_json: json!({
                "metadata": {"labels": {}},
                "report": {
                    "artifact": {"repository": "app", "tag": "v1"},
                    "registry": {"server": "ghcr.io"},
                    "summary": {"componentsCount": 1},
                    "components": {
                        "bomFormat": "CycloneDX",
                        "specVersion": "1.5",
                        "components": components,
                    }
                }
            })
            .to_string(),
            received_at: chrono::Utc::now(),
        }
    }

    async fn seed_db() -> Database {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");
        db.upsert_report(&sbom_payload(
            "prod",
            "default",
            "node-app",
            json!([
                {"type": "library", "name": "axios", "version": "1.6.0"},
                {"type": "library", "name": "axios", "version": "0.27.2"},
            ]),
        ))
        .await
        .unwrap();
        db.upsert_report(&sbom_payload(
            "prod",
            "team-a",
            "other-app",
            json!([{"type": "library", "name": "axios", "version": "1.6.0"}]),
        ))
        .await
        .unwrap();
        db.upsert_report(&sbom_payload(
            "prod",
            "default",
            "no-axios",
            json!([{"type": "library", "name": "lodash", "version": "4.17.21"}]),
        ))
        .await
        .unwrap();
        db
    }

    #[tokio::test]
    async fn preview_matches_axios_across_workloads() {
        let db = seed_db().await;
        let matchers = Matchers {
            package_name: Some("axios".to_string()),
            version_expr: None,
            clusters: vec![],
            namespace: None,
        };
        let result = run(&db, &matchers).await.unwrap();
        // 2 versions in node-app + 1 in other-app
        assert_eq!(result.total, 3);
        assert_eq!(result.items.len(), 3);
        assert!(!result.truncated);
        // Two distinct workloads contribute matches.
        assert_eq!(result.matched_workloads, 2);
    }

    #[tokio::test]
    async fn preview_applies_version_expr_in_app_layer() {
        let db = seed_db().await;
        let matchers = Matchers {
            package_name: Some("axios".to_string()),
            version_expr: Some(">=1.0.0".to_string()),
            clusters: vec![],
            namespace: None,
        };
        let result = run(&db, &matchers).await.unwrap();
        // Only the 1.6.0 entries survive; 0.27.2 is filtered.
        assert_eq!(result.total, 2);
        assert!(result.items.iter().all(|m| m.version == "1.6.0"));
    }

    #[tokio::test]
    async fn preview_namespace_filter_narrows_rows() {
        let db = seed_db().await;
        let matchers = Matchers {
            package_name: Some("axios".to_string()),
            version_expr: None,
            clusters: vec![],
            namespace: Some("team-a".to_string()),
        };
        let result = run(&db, &matchers).await.unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].namespace, "team-a");
    }

    #[tokio::test]
    async fn preview_invalid_version_expr_returns_error() {
        let db = seed_db().await;
        let matchers = Matchers {
            package_name: Some("axios".to_string()),
            version_expr: Some(">=".to_string()),
            clusters: vec![],
            namespace: None,
        };
        let err = run(&db, &matchers).await.unwrap_err();
        assert!(err.starts_with("version_expr:"));
    }

    #[tokio::test]
    async fn preview_truncates_when_total_exceeds_max() {
        let db = Database::new(":memory:").await.unwrap();
        // Build a single SBOM with MAX_MATCHES + 5 distinct axios versions
        // so we exercise the truncated=true branch without seeding 50
        // separate workloads.
        let components: Vec<serde_json::Value> = (0..(MAX_MATCHES + 5))
            .map(|i| json!({"type": "library", "name": "axios", "version": format!("1.{}.0", i)}))
            .collect();
        db.upsert_report(&sbom_payload(
            "prod",
            "default",
            "fat-app",
            json!(components),
        ))
        .await
        .unwrap();
        let matchers = Matchers {
            package_name: Some("axios".to_string()),
            version_expr: None,
            clusters: vec![],
            namespace: None,
        };
        let result = run(&db, &matchers).await.unwrap();
        assert_eq!(result.total, MAX_MATCHES + 5);
        assert_eq!(result.items.len(), MAX_MATCHES);
        assert!(result.truncated);
        assert_eq!(result.matched_workloads, 1);
    }
}
