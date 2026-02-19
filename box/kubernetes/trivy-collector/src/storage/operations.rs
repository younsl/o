//! Database CRUD and query operations

use anyhow::Result;
use rusqlite::params;
use tracing::debug;

use crate::collector::types::ReportPayload;

use super::database::Database;
use super::extractors::{
    extract_components_count_from_str, extract_metadata_from_str, extract_vuln_summary_from_str,
};
use super::models::{ClusterInfo, FullReport, QueryParams, ReportMeta, Stats, VulnSummary};

impl Database {
    /// Insert or update a report
    pub fn upsert_report(&self, payload: &ReportPayload) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        // Extract metadata from raw JSON string (parsed on-demand)
        let (app, image, registry) = extract_metadata_from_str(&payload.data_json);
        let (critical, high, medium, low, unknown) =
            extract_vuln_summary_from_str(&payload.data_json);
        let components_count = extract_components_count_from_str(&payload.data_json);

        let received_at = payload.received_at.to_rfc3339();
        let updated_at = chrono::Utc::now().to_rfc3339();

        conn.execute(
            r#"
            INSERT INTO reports (
                cluster, namespace, name, report_type, app, image, registry,
                critical_count, high_count, medium_count, low_count, unknown_count,
                components_count, data, received_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
            ON CONFLICT(cluster, namespace, name, report_type) DO UPDATE SET
                app = excluded.app,
                image = excluded.image,
                registry = excluded.registry,
                critical_count = excluded.critical_count,
                high_count = excluded.high_count,
                medium_count = excluded.medium_count,
                low_count = excluded.low_count,
                unknown_count = excluded.unknown_count,
                components_count = excluded.components_count,
                data = excluded.data,
                updated_at = excluded.updated_at
            "#,
            params![
                payload.cluster,
                payload.namespace,
                payload.name,
                payload.report_type,
                app,
                image,
                registry,
                critical,
                high,
                medium,
                low,
                unknown,
                components_count,
                payload.data_json,
                received_at,
                updated_at,
            ],
        )?;

        debug!(
            cluster = %payload.cluster,
            namespace = %payload.namespace,
            name = %payload.name,
            report_type = %payload.report_type,
            "Report upserted"
        );

        Ok(())
    }

    /// Delete a report
    pub fn delete_report(
        &self,
        cluster: &str,
        namespace: &str,
        name: &str,
        report_type: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().unwrap();

        let affected = conn.execute(
            "DELETE FROM reports WHERE cluster = ?1 AND namespace = ?2 AND name = ?3 AND report_type = ?4",
            params![cluster, namespace, name, report_type],
        )?;

        debug!(
            cluster = %cluster,
            namespace = %namespace,
            name = %name,
            report_type = %report_type,
            deleted = affected > 0,
            "Report delete attempted"
        );

        Ok(affected > 0)
    }

    /// Update notes for a report
    pub fn update_notes(
        &self,
        cluster: &str,
        namespace: &str,
        name: &str,
        report_type: &str,
        notes: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();

        // Check if notes_created_at already exists (to determine if this is create or update)
        let existing_created_at: Option<String> = conn
            .query_row(
                "SELECT notes_created_at FROM reports WHERE cluster = ?1 AND namespace = ?2 AND name = ?3 AND report_type = ?4",
                params![cluster, namespace, name, report_type],
                |row| row.get(0),
            )
            .ok()
            .flatten();

        let affected = if existing_created_at.is_none() {
            // First time adding notes - set both created_at and updated_at
            conn.execute(
                "UPDATE reports SET notes = ?1, notes_created_at = ?2, notes_updated_at = ?2 WHERE cluster = ?3 AND namespace = ?4 AND name = ?5 AND report_type = ?6",
                params![notes, now, cluster, namespace, name, report_type],
            )?
        } else {
            // Updating existing notes - only update updated_at
            conn.execute(
                "UPDATE reports SET notes = ?1, notes_updated_at = ?2 WHERE cluster = ?3 AND namespace = ?4 AND name = ?5 AND report_type = ?6",
                params![notes, now, cluster, namespace, name, report_type],
            )?
        };

        debug!(
            cluster = %cluster,
            namespace = %namespace,
            name = %name,
            report_type = %report_type,
            updated = affected > 0,
            "Report notes updated"
        );

        Ok(affected > 0)
    }

    /// Query reports with filters
    pub fn query_reports(
        &self,
        report_type: &str,
        params: &QueryParams,
    ) -> Result<Vec<ReportMeta>> {
        let conn = self.conn.lock().unwrap();

        let mut sql = String::from(
            r#"
            SELECT id, cluster, namespace, name, app, image, report_type,
                   critical_count, high_count, medium_count, low_count, unknown_count,
                   components_count, received_at, updated_at, notes, notes_created_at, notes_updated_at
            FROM reports
            WHERE report_type = ?1
            "#,
        );

        let mut sql_params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(report_type.to_string())];

        if let Some(cluster) = &params.cluster {
            sql.push_str(" AND cluster = ?");
            sql_params.push(Box::new(cluster.clone()));
        }

        if let Some(namespace) = &params.namespace {
            sql.push_str(" AND namespace = ?");
            sql_params.push(Box::new(namespace.clone()));
        }

        if let Some(app) = &params.app {
            sql.push_str(" AND app LIKE ?");
            sql_params.push(Box::new(format!("%{}%", app)));
        }

        if let Some(image) = &params.image {
            sql.push_str(" AND image LIKE ?");
            sql_params.push(Box::new(format!("%{}%", image)));
        }

        // Severity filter (only for vulnerability reports)
        if report_type == "vulnerabilityreport"
            && let Some(severities) = &params.severity
        {
            let mut severity_conditions = Vec::new();
            for severity in severities {
                match severity.to_lowercase().as_str() {
                    "critical" => severity_conditions.push("critical_count > 0"),
                    "high" => severity_conditions.push("high_count > 0"),
                    "medium" => severity_conditions.push("medium_count > 0"),
                    "low" => severity_conditions.push("low_count > 0"),
                    _ => {}
                }
            }
            if !severity_conditions.is_empty() {
                sql.push_str(&format!(" AND ({})", severity_conditions.join(" OR ")));
            }
        }

        sql.push_str(" ORDER BY updated_at DESC");

        if let Some(limit) = params.limit {
            sql.push_str(&format!(" LIMIT {}", limit));
        } else {
            sql.push_str(" LIMIT 1000");
        }

        if let Some(offset) = params.offset {
            sql.push_str(&format!(" OFFSET {}", offset));
        }

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            sql_params.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok(ReportMeta {
                id: row.get(0)?,
                cluster: row.get(1)?,
                namespace: row.get(2)?,
                name: row.get(3)?,
                app: row.get(4)?,
                image: row.get(5)?,
                report_type: row.get(6)?,
                summary: Some(VulnSummary {
                    critical: row.get(7)?,
                    high: row.get(8)?,
                    medium: row.get(9)?,
                    low: row.get(10)?,
                    unknown: row.get(11)?,
                }),
                components_count: row.get(12)?,
                received_at: row.get(13)?,
                updated_at: row.get(14)?,
                notes: row.get::<_, Option<String>>(15)?.unwrap_or_default(),
                notes_created_at: row.get(16)?,
                notes_updated_at: row.get(17)?,
            })
        })?;

        let results: Result<Vec<_>, _> = rows.collect();
        Ok(results?)
    }

    /// Get a specific report with full data
    pub fn get_report(
        &self,
        cluster: &str,
        namespace: &str,
        name: &str,
        report_type: &str,
    ) -> Result<Option<FullReport>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            r#"
            SELECT id, cluster, namespace, name, app, image, report_type,
                   critical_count, high_count, medium_count, low_count, unknown_count,
                   components_count, received_at, updated_at, data, notes, notes_created_at, notes_updated_at
            FROM reports
            WHERE cluster = ?1 AND namespace = ?2 AND name = ?3 AND report_type = ?4
            "#,
        )?;

        let result = stmt.query_row(params![cluster, namespace, name, report_type], |row| {
            // Store raw JSON string - parsing deferred to serialization time (lazy loading)
            let data_json: String = row.get(15)?;

            Ok(FullReport {
                meta: ReportMeta {
                    id: row.get(0)?,
                    cluster: row.get(1)?,
                    namespace: row.get(2)?,
                    name: row.get(3)?,
                    app: row.get(4)?,
                    image: row.get(5)?,
                    report_type: row.get(6)?,
                    summary: Some(VulnSummary {
                        critical: row.get(7)?,
                        high: row.get(8)?,
                        medium: row.get(9)?,
                        low: row.get(10)?,
                        unknown: row.get(11)?,
                    }),
                    components_count: row.get(12)?,
                    received_at: row.get(13)?,
                    updated_at: row.get(14)?,
                    notes: row.get::<_, Option<String>>(16)?.unwrap_or_default(),
                    notes_created_at: row.get(17)?,
                    notes_updated_at: row.get(18)?,
                },
                data_json,
            })
        });

        match result {
            Ok(report) => Ok(Some(report)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// List all clusters
    pub fn list_clusters(&self) -> Result<Vec<ClusterInfo>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT cluster, vuln_count, sbom_count, last_seen FROM clusters_view ORDER BY cluster",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(ClusterInfo {
                name: row.get(0)?,
                vuln_report_count: row.get(1)?,
                sbom_report_count: row.get(2)?,
                last_seen: row.get(3)?,
            })
        })?;

        let results: Result<Vec<_>, _> = rows.collect();
        Ok(results?)
    }

    /// Get overall statistics
    pub fn get_stats(&self) -> Result<Stats> {
        let conn = self.conn.lock().unwrap();

        let (db_size_bytes, db_size_human) = self.get_db_size();

        let sqlite_version: String = conn
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))
            .unwrap_or_else(|_| "unknown".to_string());

        let stats = conn.query_row(
            r#"
            SELECT
                COUNT(DISTINCT cluster) as total_clusters,
                COALESCE(SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN 1 ELSE 0 END), 0) as total_vuln,
                COALESCE(SUM(CASE WHEN report_type = 'sbomreport' THEN 1 ELSE 0 END), 0) as total_sbom,
                COALESCE(SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN critical_count ELSE 0 END), 0) as total_critical,
                COALESCE(SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN high_count ELSE 0 END), 0) as total_high,
                COALESCE(SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN medium_count ELSE 0 END), 0) as total_medium,
                COALESCE(SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN low_count ELSE 0 END), 0) as total_low,
                COALESCE(SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN unknown_count ELSE 0 END), 0) as total_unknown
            FROM reports
            "#,
            [],
            |row| {
                Ok(Stats {
                    total_clusters: row.get(0)?,
                    total_vuln_reports: row.get(1)?,
                    total_sbom_reports: row.get(2)?,
                    total_critical: row.get(3)?,
                    total_high: row.get(4)?,
                    total_medium: row.get(5)?,
                    total_low: row.get(6)?,
                    total_unknown: row.get(7)?,
                    db_size_bytes,
                    db_size_human,
                    sqlite_version: sqlite_version.clone(),
                })
            },
        )?;

        Ok(stats)
    }

    /// Get list of unique namespaces
    pub fn list_namespaces(&self, cluster: Option<&str>) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();

        let mut results = Vec::new();

        if let Some(c) = cluster {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT namespace FROM reports WHERE cluster = ?1 ORDER BY namespace",
            )?;
            let rows = stmt.query_map([c], |row| row.get::<_, String>(0))?;
            for row in rows {
                results.push(row?);
            }
        } else {
            let mut stmt =
                conn.prepare("SELECT DISTINCT namespace FROM reports ORDER BY namespace")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for row in rows {
                results.push(row?);
            }
        }

        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn create_test_payload(
        cluster: &str,
        namespace: &str,
        name: &str,
        report_type: &str,
    ) -> ReportPayload {
        ReportPayload {
            cluster: cluster.to_string(),
            namespace: namespace.to_string(),
            name: name.to_string(),
            report_type: report_type.to_string(),
            data_json: json!({
                "metadata": {
                    "labels": {
                        "trivy-operator.resource.name": "test-app"
                    }
                },
                "report": {
                    "artifact": {
                        "repository": "nginx",
                        "tag": "1.25"
                    },
                    "registry": {
                        "server": "docker.io"
                    },
                    "summary": {
                        "criticalCount": 2,
                        "highCount": 5,
                        "mediumCount": 10,
                        "lowCount": 3,
                        "unknownCount": 1,
                        "componentsCount": 50
                    }
                }
            })
            .to_string(),
            received_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn test_upsert_and_get_report() {
        let db = Database::new(":memory:").expect("Failed to create database");
        let payload = create_test_payload("prod", "default", "nginx-vuln", "vulnerabilityreport");

        db.upsert_report(&payload).expect("Failed to upsert report");

        let report = db
            .get_report("prod", "default", "nginx-vuln", "vulnerabilityreport")
            .expect("Failed to get report");

        assert!(report.is_some());
        let report = report.unwrap();
        assert_eq!(report.meta.cluster, "prod");
        assert_eq!(report.meta.namespace, "default");
        assert_eq!(report.meta.name, "nginx-vuln");
        assert_eq!(report.meta.app, "test-app");
        assert_eq!(report.meta.image, "nginx:1.25");
    }

    #[test]
    fn test_upsert_update_existing() {
        let db = Database::new(":memory:").expect("Failed to create database");
        let mut payload =
            create_test_payload("prod", "default", "nginx-vuln", "vulnerabilityreport");

        db.upsert_report(&payload).expect("Failed to insert");

        // Update with new data
        payload.data_json = json!({
            "metadata": {
                "labels": {
                    "trivy-operator.resource.name": "updated-app"
                }
            },
            "report": {
                "artifact": {
                    "repository": "nginx",
                    "tag": "1.26"
                },
                "registry": {
                    "server": "docker.io"
                },
                "summary": {
                    "criticalCount": 0,
                    "highCount": 2
                }
            }
        })
        .to_string();

        db.upsert_report(&payload).expect("Failed to update");

        let report = db
            .get_report("prod", "default", "nginx-vuln", "vulnerabilityreport")
            .expect("Failed to get report")
            .unwrap();

        assert_eq!(report.meta.app, "updated-app");
        assert_eq!(report.meta.image, "nginx:1.26");
        assert_eq!(report.meta.summary.unwrap().critical, 0);
    }

    #[test]
    fn test_delete_report() {
        let db = Database::new(":memory:").expect("Failed to create database");
        let payload = create_test_payload("prod", "default", "nginx-vuln", "vulnerabilityreport");

        db.upsert_report(&payload).expect("Failed to insert");

        let deleted = db
            .delete_report("prod", "default", "nginx-vuln", "vulnerabilityreport")
            .expect("Failed to delete");
        assert!(deleted);

        let report = db
            .get_report("prod", "default", "nginx-vuln", "vulnerabilityreport")
            .expect("Failed to query");
        assert!(report.is_none());
    }

    #[test]
    fn test_delete_report_not_found() {
        let db = Database::new(":memory:").expect("Failed to create database");

        let deleted = db
            .delete_report("prod", "default", "nonexistent", "vulnerabilityreport")
            .expect("Failed to delete");
        assert!(!deleted);
    }

    #[test]
    fn test_query_reports_by_cluster() {
        let db = Database::new(":memory:").expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .unwrap();
        db.upsert_report(&create_test_payload(
            "staging",
            "default",
            "app2",
            "vulnerabilityreport",
        ))
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "kube-system",
            "app3",
            "vulnerabilityreport",
        ))
        .unwrap();

        let params = QueryParams {
            cluster: Some("prod".to_string()),
            ..Default::default()
        };

        let results = db
            .query_reports("vulnerabilityreport", &params)
            .expect("Failed to query");
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_query_reports_by_namespace() {
        let db = Database::new(":memory:").expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "kube-system",
            "app2",
            "vulnerabilityreport",
        ))
        .unwrap();

        let params = QueryParams {
            namespace: Some("default".to_string()),
            ..Default::default()
        };

        let results = db
            .query_reports("vulnerabilityreport", &params)
            .expect("Failed to query");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].namespace, "default");
    }

    #[test]
    fn test_update_notes() {
        let db = Database::new(":memory:").expect("Failed to create database");
        let payload = create_test_payload("prod", "default", "app1", "vulnerabilityreport");

        db.upsert_report(&payload).expect("Failed to insert");

        let updated = db
            .update_notes(
                "prod",
                "default",
                "app1",
                "vulnerabilityreport",
                "This is a test note",
            )
            .expect("Failed to update notes");
        assert!(updated);

        let report = db
            .get_report("prod", "default", "app1", "vulnerabilityreport")
            .expect("Failed to get report")
            .unwrap();

        assert_eq!(report.meta.notes, "This is a test note");
        assert!(report.meta.notes_created_at.is_some());
        assert!(report.meta.notes_updated_at.is_some());
    }

    #[test]
    fn test_list_namespaces_all() {
        let db = Database::new(":memory:").expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "kube-system",
            "app2",
            "vulnerabilityreport",
        ))
        .unwrap();
        db.upsert_report(&create_test_payload(
            "staging",
            "monitoring",
            "app3",
            "vulnerabilityreport",
        ))
        .unwrap();

        let namespaces = db.list_namespaces(None).expect("Failed to list namespaces");
        assert_eq!(namespaces.len(), 3);
        assert!(namespaces.contains(&"default".to_string()));
        assert!(namespaces.contains(&"kube-system".to_string()));
        assert!(namespaces.contains(&"monitoring".to_string()));
    }

    #[test]
    fn test_list_namespaces_by_cluster() {
        let db = Database::new(":memory:").expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "kube-system",
            "app2",
            "vulnerabilityreport",
        ))
        .unwrap();
        db.upsert_report(&create_test_payload(
            "staging",
            "monitoring",
            "app3",
            "vulnerabilityreport",
        ))
        .unwrap();

        let namespaces = db
            .list_namespaces(Some("prod"))
            .expect("Failed to list namespaces");
        assert_eq!(namespaces.len(), 2);
        assert!(namespaces.contains(&"default".to_string()));
        assert!(namespaces.contains(&"kube-system".to_string()));
        assert!(!namespaces.contains(&"monitoring".to_string()));
    }

    #[test]
    fn test_query_reports_with_severity_filter() {
        let db = Database::new(":memory:").expect("Failed to create database");

        // Insert report with critical=2, high=5
        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .unwrap();

        // Insert report with critical=0, high=0
        let mut low_sev_payload =
            create_test_payload("prod", "default", "app2", "vulnerabilityreport");
        low_sev_payload.data_json = json!({
            "metadata": { "labels": {} },
            "report": {
                "artifact": { "repository": "alpine", "tag": "3.19" },
                "registry": { "server": "docker.io" },
                "summary": {
                    "criticalCount": 0,
                    "highCount": 0,
                    "mediumCount": 1,
                    "lowCount": 2,
                    "unknownCount": 0
                }
            }
        })
        .to_string();
        db.upsert_report(&low_sev_payload).unwrap();

        // Filter by critical severity
        let params = QueryParams {
            severity: Some(vec!["critical".to_string()]),
            ..Default::default()
        };
        let results = db
            .query_reports("vulnerabilityreport", &params)
            .expect("Failed to query");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "app1");
    }

    #[test]
    fn test_query_reports_with_app_filter() {
        let db = Database::new(":memory:").expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "nginx-vuln",
            "vulnerabilityreport",
        ))
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "redis-vuln",
            "vulnerabilityreport",
        ))
        .unwrap();

        // Both reports have app="test-app" from create_test_payload
        let params = QueryParams {
            app: Some("test".to_string()),
            ..Default::default()
        };
        let results = db
            .query_reports("vulnerabilityreport", &params)
            .expect("Failed to query");
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_query_reports_with_image_filter() {
        let db = Database::new(":memory:").expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .unwrap();

        let params = QueryParams {
            image: Some("nginx".to_string()),
            ..Default::default()
        };
        let results = db
            .query_reports("vulnerabilityreport", &params)
            .expect("Failed to query");
        assert_eq!(results.len(), 1);

        let params = QueryParams {
            image: Some("nonexistent".to_string()),
            ..Default::default()
        };
        let results = db
            .query_reports("vulnerabilityreport", &params)
            .expect("Failed to query");
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_query_reports_with_limit_offset() {
        let db = Database::new(":memory:").expect("Failed to create database");

        for i in 0..5 {
            db.upsert_report(&create_test_payload(
                "prod",
                "default",
                &format!("app{}", i),
                "vulnerabilityreport",
            ))
            .unwrap();
        }

        let params = QueryParams {
            limit: Some(2),
            ..Default::default()
        };
        let results = db
            .query_reports("vulnerabilityreport", &params)
            .expect("Failed to query");
        assert_eq!(results.len(), 2);

        let params = QueryParams {
            limit: Some(2),
            offset: Some(3),
            ..Default::default()
        };
        let results = db
            .query_reports("vulnerabilityreport", &params)
            .expect("Failed to query");
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_list_clusters_with_data() {
        let db = Database::new(":memory:").expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app2",
            "sbomreport",
        ))
        .unwrap();
        db.upsert_report(&create_test_payload(
            "staging",
            "default",
            "app3",
            "vulnerabilityreport",
        ))
        .unwrap();

        let clusters = db.list_clusters().expect("Failed to list clusters");
        assert_eq!(clusters.len(), 2);

        let prod = clusters.iter().find(|c| c.name == "prod").unwrap();
        assert_eq!(prod.vuln_report_count, 1);
        assert_eq!(prod.sbom_report_count, 1);

        let staging = clusters.iter().find(|c| c.name == "staging").unwrap();
        assert_eq!(staging.vuln_report_count, 1);
        assert_eq!(staging.sbom_report_count, 0);
    }

    #[test]
    fn test_update_notes_creates_then_updates() {
        let db = Database::new(":memory:").expect("Failed to create database");
        let payload = create_test_payload("prod", "default", "app1", "vulnerabilityreport");
        db.upsert_report(&payload).expect("Failed to insert");

        // First update: creates notes
        db.update_notes("prod", "default", "app1", "vulnerabilityreport", "first note")
            .expect("Failed to update notes");

        let report = db
            .get_report("prod", "default", "app1", "vulnerabilityreport")
            .unwrap()
            .unwrap();
        let created_at = report.meta.notes_created_at.clone();
        assert_eq!(report.meta.notes, "first note");
        assert!(created_at.is_some());

        // Second update: updates notes, created_at should remain
        db.update_notes(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
            "updated note",
        )
        .expect("Failed to update notes");

        let report = db
            .get_report("prod", "default", "app1", "vulnerabilityreport")
            .unwrap()
            .unwrap();
        assert_eq!(report.meta.notes, "updated note");
        assert_eq!(report.meta.notes_created_at, created_at);
    }

    #[test]
    fn test_update_notes_nonexistent_report() {
        let db = Database::new(":memory:").expect("Failed to create database");

        let updated = db
            .update_notes(
                "prod",
                "default",
                "nonexistent",
                "vulnerabilityreport",
                "note",
            )
            .expect("Failed to update notes");
        assert!(!updated);
    }

    #[test]
    fn test_get_stats_with_data() {
        let db = Database::new(":memory:").expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app2",
            "sbomreport",
        ))
        .unwrap();

        let stats = db.get_stats().expect("Failed to get stats");
        assert_eq!(stats.total_clusters, 1);
        assert_eq!(stats.total_vuln_reports, 1);
        assert_eq!(stats.total_sbom_reports, 1);
        assert_eq!(stats.total_critical, 2);
        assert_eq!(stats.total_high, 5);
    }
}
