//! Database CRUD and query operations

use anyhow::Result;
use sqlx::QueryBuilder;
use sqlx::Row;
use sqlx::Sqlite;
use tracing::debug;

use crate::collector::types::ReportPayload;

use super::database::Database;
use super::extractors::{
    extract_components_count_from_str, extract_metadata_from_str, extract_vuln_summary_from_str,
};
use super::models::{
    ClusterInfo, ComponentSearchResult, FullReport, QueryParams, ReportMeta, Stats,
    VulnSearchResult, VulnSummary,
};

impl Database {
    /// Insert or update a report
    pub async fn upsert_report(&self, payload: &ReportPayload) -> Result<()> {
        // Extract metadata from raw JSON string (parsed on-demand)
        let (app, image, registry) = extract_metadata_from_str(&payload.data_json);
        let (critical, high, medium, low, unknown) =
            extract_vuln_summary_from_str(&payload.data_json);
        let components_count = extract_components_count_from_str(&payload.data_json);

        let received_at = payload.received_at.to_rfc3339();
        let updated_at = chrono::Utc::now().to_rfc3339();

        sqlx::query(
            r#"
            INSERT INTO reports (
                cluster, namespace, name, report_type, app, image, registry,
                critical_count, high_count, medium_count, low_count, unknown_count,
                components_count, data, received_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
        )
        .bind(&payload.cluster)
        .bind(&payload.namespace)
        .bind(&payload.name)
        .bind(&payload.report_type)
        .bind(&app)
        .bind(&image)
        .bind(&registry)
        .bind(critical)
        .bind(high)
        .bind(medium)
        .bind(low)
        .bind(unknown)
        .bind(components_count)
        .bind(&payload.data_json)
        .bind(&received_at)
        .bind(&updated_at)
        .execute(&self.pool)
        .await?;

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
    pub async fn delete_report(
        &self,
        cluster: &str,
        namespace: &str,
        name: &str,
        report_type: &str,
    ) -> Result<bool> {
        let result = sqlx::query(
            "DELETE FROM reports WHERE cluster = $1 AND namespace = $2 AND name = $3 AND report_type = $4",
        )
        .bind(cluster)
        .bind(namespace)
        .bind(name)
        .bind(report_type)
        .execute(&self.pool)
        .await?;

        let affected = result.rows_affected();

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
    pub async fn update_notes(
        &self,
        cluster: &str,
        namespace: &str,
        name: &str,
        report_type: &str,
        notes: &str,
    ) -> Result<bool> {
        let now = chrono::Utc::now().to_rfc3339();

        // Check if notes_created_at already exists (to determine if this is create or update)
        let existing_created_at: Option<String> = sqlx::query(
            "SELECT notes_created_at FROM reports WHERE cluster = $1 AND namespace = $2 AND name = $3 AND report_type = $4",
        )
        .bind(cluster)
        .bind(namespace)
        .bind(name)
        .bind(report_type)
        .fetch_optional(&self.pool)
        .await?
        .and_then(|row| row.get::<Option<String>, _>(0));

        let affected = if existing_created_at.is_none() {
            // First time adding notes - set both created_at and updated_at
            sqlx::query(
                "UPDATE reports SET notes = $1, notes_created_at = $2, notes_updated_at = $2 WHERE cluster = $3 AND namespace = $4 AND name = $5 AND report_type = $6",
            )
            .bind(notes)
            .bind(&now)
            .bind(cluster)
            .bind(namespace)
            .bind(name)
            .bind(report_type)
            .execute(&self.pool)
            .await?
            .rows_affected()
        } else {
            // Updating existing notes - only update updated_at
            sqlx::query(
                "UPDATE reports SET notes = $1, notes_updated_at = $2 WHERE cluster = $3 AND namespace = $4 AND name = $5 AND report_type = $6",
            )
            .bind(notes)
            .bind(&now)
            .bind(cluster)
            .bind(namespace)
            .bind(name)
            .bind(report_type)
            .execute(&self.pool)
            .await?
            .rows_affected()
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
    pub async fn query_reports(
        &self,
        report_type: &str,
        params: &QueryParams,
    ) -> Result<(Vec<ReportMeta>, i64)> {
        // COUNT query
        let mut count_builder: QueryBuilder<Sqlite> =
            QueryBuilder::new("SELECT COUNT(*) FROM reports WHERE report_type = ");
        count_builder.push_bind(report_type.to_string());

        if let Some(cluster) = &params.cluster {
            count_builder.push(" AND cluster = ");
            count_builder.push_bind(cluster.clone());
        }
        if let Some(namespace) = &params.namespace {
            count_builder.push(" AND namespace = ");
            count_builder.push_bind(namespace.clone());
        }
        if let Some(app) = &params.app {
            count_builder.push(" AND app LIKE ");
            count_builder.push_bind(format!("%{}%", app));
        }
        if let Some(image) = &params.image {
            count_builder.push(" AND image LIKE ");
            count_builder.push_bind(format!("%{}%", image));
        }
        if report_type == "sbomreport"
            && let Some(component) = &params.component
        {
            count_builder.push(
                " AND EXISTS (SELECT 1 FROM json_each(json_extract(data, '$.report.components.components')) WHERE json_extract(value, '$.name') LIKE ",
            );
            count_builder.push_bind(format!("%{}%", component));
            count_builder.push(")");
        }
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
                count_builder.push(format!(" AND ({})", severity_conditions.join(" OR ")));
            }
        }

        let (total,): (i64,) = count_builder.build_query_as().fetch_one(&self.pool).await?;

        // Data query with the same WHERE conditions
        let mut data_builder: QueryBuilder<Sqlite> = QueryBuilder::new(
            r#"SELECT id, cluster, namespace, name, app, image, report_type,
                   critical_count, high_count, medium_count, low_count, unknown_count,
                   components_count, received_at, updated_at, notes, notes_created_at, notes_updated_at
            FROM reports WHERE report_type = "#,
        );
        data_builder.push_bind(report_type.to_string());

        if let Some(cluster) = &params.cluster {
            data_builder.push(" AND cluster = ");
            data_builder.push_bind(cluster.clone());
        }
        if let Some(namespace) = &params.namespace {
            data_builder.push(" AND namespace = ");
            data_builder.push_bind(namespace.clone());
        }
        if let Some(app) = &params.app {
            data_builder.push(" AND app LIKE ");
            data_builder.push_bind(format!("%{}%", app));
        }
        if let Some(image) = &params.image {
            data_builder.push(" AND image LIKE ");
            data_builder.push_bind(format!("%{}%", image));
        }
        if report_type == "sbomreport"
            && let Some(component) = &params.component
        {
            data_builder.push(
                " AND EXISTS (SELECT 1 FROM json_each(json_extract(data, '$.report.components.components')) WHERE json_extract(value, '$.name') LIKE ",
            );
            data_builder.push_bind(format!("%{}%", component));
            data_builder.push(")");
        }
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
                data_builder.push(format!(" AND ({})", severity_conditions.join(" OR ")));
            }
        }

        data_builder.push(" ORDER BY updated_at DESC");

        let limit = params.limit.unwrap_or(1000);
        data_builder.push(" LIMIT ");
        data_builder.push_bind(limit);

        if let Some(offset) = params.offset {
            data_builder.push(" OFFSET ");
            data_builder.push_bind(offset);
        }

        let rows = data_builder.build().fetch_all(&self.pool).await?;

        let results: Vec<ReportMeta> = rows
            .iter()
            .map(|row| ReportMeta {
                id: row.get::<i64, _>(0),
                cluster: row.get::<String, _>(1),
                namespace: row.get::<String, _>(2),
                name: row.get::<String, _>(3),
                app: row.get::<String, _>(4),
                image: row.get::<String, _>(5),
                report_type: row.get::<String, _>(6),
                summary: Some(VulnSummary {
                    critical: row.get::<i64, _>(7),
                    high: row.get::<i64, _>(8),
                    medium: row.get::<i64, _>(9),
                    low: row.get::<i64, _>(10),
                    unknown: row.get::<i64, _>(11),
                }),
                components_count: row.get::<Option<i64>, _>(12),
                received_at: row.get::<String, _>(13),
                updated_at: row.get::<String, _>(14),
                notes: row.get::<Option<String>, _>(15).unwrap_or_default(),
                notes_created_at: row.get::<Option<String>, _>(16),
                notes_updated_at: row.get::<Option<String>, _>(17),
            })
            .collect();

        Ok((results, total))
    }

    /// Get a specific report with full data
    pub async fn get_report(
        &self,
        cluster: &str,
        namespace: &str,
        name: &str,
        report_type: &str,
    ) -> Result<Option<FullReport>> {
        let row = sqlx::query(
            r#"
            SELECT id, cluster, namespace, name, app, image, report_type,
                   critical_count, high_count, medium_count, low_count, unknown_count,
                   components_count, received_at, updated_at, data, notes, notes_created_at, notes_updated_at
            FROM reports
            WHERE cluster = $1 AND namespace = $2 AND name = $3 AND report_type = $4
            "#,
        )
        .bind(cluster)
        .bind(namespace)
        .bind(name)
        .bind(report_type)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => {
                // Store raw JSON string - parsing deferred to serialization time (lazy loading)
                let data_json: String = row.get::<String, _>(15);

                Ok(Some(FullReport {
                    meta: ReportMeta {
                        id: row.get::<i64, _>(0),
                        cluster: row.get::<String, _>(1),
                        namespace: row.get::<String, _>(2),
                        name: row.get::<String, _>(3),
                        app: row.get::<String, _>(4),
                        image: row.get::<String, _>(5),
                        report_type: row.get::<String, _>(6),
                        summary: Some(VulnSummary {
                            critical: row.get::<i64, _>(7),
                            high: row.get::<i64, _>(8),
                            medium: row.get::<i64, _>(9),
                            low: row.get::<i64, _>(10),
                            unknown: row.get::<i64, _>(11),
                        }),
                        components_count: row.get::<Option<i64>, _>(12),
                        received_at: row.get::<String, _>(13),
                        updated_at: row.get::<String, _>(14),
                        notes: row.get::<Option<String>, _>(16).unwrap_or_default(),
                        notes_created_at: row.get::<Option<String>, _>(17),
                        notes_updated_at: row.get::<Option<String>, _>(18),
                    },
                    data_json,
                }))
            }
            None => Ok(None),
        }
    }

    /// List all clusters
    pub async fn list_clusters(&self) -> Result<Vec<ClusterInfo>> {
        let rows = sqlx::query(
            "SELECT cluster, vuln_count, sbom_count, last_seen FROM clusters_view ORDER BY cluster",
        )
        .fetch_all(&self.pool)
        .await?;

        let results: Vec<ClusterInfo> = rows
            .iter()
            .map(|row| ClusterInfo {
                name: row.get::<String, _>(0),
                vuln_report_count: row.get::<i64, _>(1),
                sbom_report_count: row.get::<i64, _>(2),
                last_seen: row.get::<String, _>(3),
            })
            .collect();

        Ok(results)
    }

    /// Get overall statistics
    pub async fn get_stats(&self) -> Result<Stats> {
        let (db_size_bytes, db_size_human) = self.get_db_size();

        let version_row = sqlx::query("SELECT sqlite_version()")
            .fetch_one(&self.pool)
            .await?;
        let sqlite_version: String = version_row.get::<String, _>(0);

        let row = sqlx::query(
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
        )
        .fetch_one(&self.pool)
        .await?;

        let stats = Stats {
            total_clusters: row.get::<i64, _>(0),
            total_vuln_reports: row.get::<i64, _>(1),
            total_sbom_reports: row.get::<i64, _>(2),
            total_critical: row.get::<i64, _>(3),
            total_high: row.get::<i64, _>(4),
            total_medium: row.get::<i64, _>(5),
            total_low: row.get::<i64, _>(6),
            total_unknown: row.get::<i64, _>(7),
            db_size_bytes,
            db_size_human,
            sqlite_version,
        };

        Ok(stats)
    }

    /// Get list of unique namespaces
    pub async fn list_namespaces(&self, cluster: Option<&str>) -> Result<Vec<String>> {
        let rows = if let Some(c) = cluster {
            sqlx::query(
                "SELECT DISTINCT namespace FROM reports WHERE cluster = $1 ORDER BY namespace",
            )
            .bind(c)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query("SELECT DISTINCT namespace FROM reports ORDER BY namespace")
                .fetch_all(&self.pool)
                .await?
        };

        let results: Vec<String> = rows.iter().map(|row| row.get::<String, _>(0)).collect();

        Ok(results)
    }

    /// Search SBOM components across all reports
    ///
    /// Returns matching component name + version for each report that contains
    /// the searched component. A single report may produce multiple rows if
    /// it contains several matching components (e.g. log4j-core and log4j-api).
    pub async fn search_sbom_components(
        &self,
        component: &str,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<ComponentSearchResult>, i64)> {
        let pattern = format!("%{}%", component);

        let count_row = sqlx::query(
            r#"
            SELECT COUNT(*)
            FROM reports r,
                 json_each(json_extract(r.data, '$.report.components.components')) j
            WHERE r.report_type = 'sbomreport'
              AND json_extract(j.value, '$.name') LIKE $1
            "#,
        )
        .bind(&pattern)
        .fetch_one(&self.pool)
        .await?;
        let total: i64 = count_row.get::<i64, _>(0);

        let rows = sqlx::query(
            r#"
            SELECT
                r.cluster,
                r.namespace,
                r.name,
                r.app,
                r.image,
                json_extract(j.value, '$.name') AS component_name,
                COALESCE(json_extract(j.value, '$.version'), '') AS component_version,
                COALESCE(json_extract(j.value, '$.type'), '') AS component_type,
                r.updated_at
            FROM reports r,
                 json_each(json_extract(r.data, '$.report.components.components')) j
            WHERE r.report_type = 'sbomreport'
              AND json_extract(j.value, '$.name') LIKE $1
            ORDER BY r.updated_at DESC
            LIMIT $2 OFFSET $3
            "#,
        )
        .bind(&pattern)
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;

        let results: Vec<ComponentSearchResult> = rows
            .iter()
            .map(|row| ComponentSearchResult {
                cluster: row.get::<String, _>(0),
                namespace: row.get::<String, _>(1),
                name: row.get::<String, _>(2),
                app: row.get::<String, _>(3),
                image: row.get::<String, _>(4),
                component_name: row.get::<String, _>(5),
                component_version: row.get::<String, _>(6),
                component_type: row.get::<String, _>(7),
                updated_at: row.get::<String, _>(8),
            })
            .collect();

        Ok((results, total))
    }

    /// Search vulnerabilities across all reports
    pub async fn search_vulnerabilities(
        &self,
        query: &str,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<VulnSearchResult>, i64)> {
        let pattern = format!("%{}%", query);

        let count_row = sqlx::query(
            r#"
            SELECT COUNT(*)
            FROM reports r,
                 json_each(json_extract(r.data, '$.report.vulnerabilities')) j
            WHERE r.report_type = 'vulnerabilityreport'
              AND (
                json_extract(j.value, '$.vulnerabilityID') LIKE $1
                OR json_extract(j.value, '$.resource') LIKE $1
              )
            "#,
        )
        .bind(&pattern)
        .fetch_one(&self.pool)
        .await?;
        let total: i64 = count_row.get::<i64, _>(0);

        let rows = sqlx::query(
            r#"
            SELECT
                r.cluster,
                r.namespace,
                r.name,
                r.app,
                r.image,
                json_extract(j.value, '$.vulnerabilityID') AS vuln_id,
                COALESCE(json_extract(j.value, '$.severity'), '') AS severity,
                json_extract(j.value, '$.score') AS score,
                COALESCE(json_extract(j.value, '$.resource'), '') AS resource,
                COALESCE(json_extract(j.value, '$.installedVersion'), '') AS installed_version,
                COALESCE(json_extract(j.value, '$.fixedVersion'), '') AS fixed_version,
                r.updated_at
            FROM reports r,
                 json_each(json_extract(r.data, '$.report.vulnerabilities')) j
            WHERE r.report_type = 'vulnerabilityreport'
              AND (
                json_extract(j.value, '$.vulnerabilityID') LIKE $1
                OR json_extract(j.value, '$.resource') LIKE $1
              )
            ORDER BY r.updated_at DESC
            LIMIT $2 OFFSET $3
            "#,
        )
        .bind(&pattern)
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;

        let results: Vec<VulnSearchResult> = rows
            .iter()
            .map(|row| VulnSearchResult {
                cluster: row.get::<String, _>(0),
                namespace: row.get::<String, _>(1),
                name: row.get::<String, _>(2),
                app: row.get::<String, _>(3),
                image: row.get::<String, _>(4),
                vulnerability_id: row.get::<String, _>(5),
                severity: row.get::<String, _>(6),
                score: row.get::<Option<f64>, _>(7),
                resource: row.get::<String, _>(8),
                installed_version: row.get::<String, _>(9),
                fixed_version: row.get::<String, _>(10),
                updated_at: row.get::<String, _>(11),
            })
            .collect();

        Ok((results, total))
    }

    /// Suggest distinct vulnerability IDs matching a substring
    pub async fn suggest_vulnerability_ids(&self, query: &str, limit: i64) -> Result<Vec<String>> {
        let pattern = format!("%{}%", query);

        let rows = sqlx::query(
            r#"
            SELECT DISTINCT json_extract(j.value, '$.vulnerabilityID') AS vuln_id
            FROM reports r,
                 json_each(json_extract(r.data, '$.report.vulnerabilities')) j
            WHERE r.report_type = 'vulnerabilityreport'
              AND vuln_id LIKE $1
            ORDER BY vuln_id
            LIMIT $2
            "#,
        )
        .bind(&pattern)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let results: Vec<String> = rows.iter().map(|row| row.get::<String, _>(0)).collect();

        Ok(results)
    }

    /// Suggest distinct component names matching a prefix/substring
    pub async fn suggest_component_names(&self, query: &str, limit: i64) -> Result<Vec<String>> {
        let pattern = format!("%{}%", query);

        let rows = sqlx::query(
            r#"
            SELECT DISTINCT json_extract(j.value, '$.name') AS comp_name
            FROM reports r,
                 json_each(json_extract(r.data, '$.report.components.components')) j
            WHERE r.report_type = 'sbomreport'
              AND comp_name LIKE $1
            ORDER BY comp_name
            LIMIT $2
            "#,
        )
        .bind(&pattern)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let results: Vec<String> = rows.iter().map(|row| row.get::<String, _>(0)).collect();

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

    #[tokio::test]
    async fn test_upsert_and_get_report() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");
        let payload = create_test_payload("prod", "default", "nginx-vuln", "vulnerabilityreport");

        db.upsert_report(&payload)
            .await
            .expect("Failed to upsert report");

        let report = db
            .get_report("prod", "default", "nginx-vuln", "vulnerabilityreport")
            .await
            .expect("Failed to get report");

        assert!(report.is_some());
        let report = report.unwrap();
        assert_eq!(report.meta.cluster, "prod");
        assert_eq!(report.meta.namespace, "default");
        assert_eq!(report.meta.name, "nginx-vuln");
        assert_eq!(report.meta.app, "test-app");
        assert_eq!(report.meta.image, "nginx:1.25");
    }

    #[tokio::test]
    async fn test_upsert_update_existing() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");
        let mut payload =
            create_test_payload("prod", "default", "nginx-vuln", "vulnerabilityreport");

        db.upsert_report(&payload).await.expect("Failed to insert");

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

        db.upsert_report(&payload).await.expect("Failed to update");

        let report = db
            .get_report("prod", "default", "nginx-vuln", "vulnerabilityreport")
            .await
            .expect("Failed to get report")
            .unwrap();

        assert_eq!(report.meta.app, "updated-app");
        assert_eq!(report.meta.image, "nginx:1.26");
        assert_eq!(report.meta.summary.unwrap().critical, 0);
    }

    #[tokio::test]
    async fn test_delete_report() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");
        let payload = create_test_payload("prod", "default", "nginx-vuln", "vulnerabilityreport");

        db.upsert_report(&payload).await.expect("Failed to insert");

        let deleted = db
            .delete_report("prod", "default", "nginx-vuln", "vulnerabilityreport")
            .await
            .expect("Failed to delete");
        assert!(deleted);

        let report = db
            .get_report("prod", "default", "nginx-vuln", "vulnerabilityreport")
            .await
            .expect("Failed to query");
        assert!(report.is_none());
    }

    #[tokio::test]
    async fn test_delete_report_not_found() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        let deleted = db
            .delete_report("prod", "default", "nonexistent", "vulnerabilityreport")
            .await
            .expect("Failed to delete");
        assert!(!deleted);
    }

    #[tokio::test]
    async fn test_query_reports_by_cluster() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "staging",
            "default",
            "app2",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "kube-system",
            "app3",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();

        let params = QueryParams {
            cluster: Some("prod".to_string()),
            ..Default::default()
        };

        let (results, _total) = db
            .query_reports("vulnerabilityreport", &params)
            .await
            .expect("Failed to query");
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_query_reports_by_namespace() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "kube-system",
            "app2",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();

        let params = QueryParams {
            namespace: Some("default".to_string()),
            ..Default::default()
        };

        let (results, _total) = db
            .query_reports("vulnerabilityreport", &params)
            .await
            .expect("Failed to query");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].namespace, "default");
    }

    #[tokio::test]
    async fn test_update_notes() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");
        let payload = create_test_payload("prod", "default", "app1", "vulnerabilityreport");

        db.upsert_report(&payload).await.expect("Failed to insert");

        let updated = db
            .update_notes(
                "prod",
                "default",
                "app1",
                "vulnerabilityreport",
                "This is a test note",
            )
            .await
            .expect("Failed to update notes");
        assert!(updated);

        let report = db
            .get_report("prod", "default", "app1", "vulnerabilityreport")
            .await
            .expect("Failed to get report")
            .unwrap();

        assert_eq!(report.meta.notes, "This is a test note");
        assert!(report.meta.notes_created_at.is_some());
        assert!(report.meta.notes_updated_at.is_some());
    }

    #[tokio::test]
    async fn test_list_namespaces_all() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "kube-system",
            "app2",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "staging",
            "monitoring",
            "app3",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();

        let namespaces = db
            .list_namespaces(None)
            .await
            .expect("Failed to list namespaces");
        assert_eq!(namespaces.len(), 3);
        assert!(namespaces.contains(&"default".to_string()));
        assert!(namespaces.contains(&"kube-system".to_string()));
        assert!(namespaces.contains(&"monitoring".to_string()));
    }

    #[tokio::test]
    async fn test_list_namespaces_by_cluster() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "kube-system",
            "app2",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "staging",
            "monitoring",
            "app3",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();

        let namespaces = db
            .list_namespaces(Some("prod"))
            .await
            .expect("Failed to list namespaces");
        assert_eq!(namespaces.len(), 2);
        assert!(namespaces.contains(&"default".to_string()));
        assert!(namespaces.contains(&"kube-system".to_string()));
        assert!(!namespaces.contains(&"monitoring".to_string()));
    }

    #[tokio::test]
    async fn test_query_reports_with_severity_filter() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        // Insert report with critical=2, high=5
        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .await
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
        db.upsert_report(&low_sev_payload).await.unwrap();

        // Filter by critical severity
        let params = QueryParams {
            severity: Some(vec!["critical".to_string()]),
            ..Default::default()
        };
        let (results, _total) = db
            .query_reports("vulnerabilityreport", &params)
            .await
            .expect("Failed to query");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "app1");
    }

    #[tokio::test]
    async fn test_query_reports_with_app_filter() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "nginx-vuln",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "redis-vuln",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();

        // Both reports have app="test-app" from create_test_payload
        let params = QueryParams {
            app: Some("test".to_string()),
            ..Default::default()
        };
        let (results, _total) = db
            .query_reports("vulnerabilityreport", &params)
            .await
            .expect("Failed to query");
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_query_reports_with_image_filter() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();

        let params = QueryParams {
            image: Some("nginx".to_string()),
            ..Default::default()
        };
        let (results, _total) = db
            .query_reports("vulnerabilityreport", &params)
            .await
            .expect("Failed to query");
        assert_eq!(results.len(), 1);

        let params = QueryParams {
            image: Some("nonexistent".to_string()),
            ..Default::default()
        };
        let (results, _total) = db
            .query_reports("vulnerabilityreport", &params)
            .await
            .expect("Failed to query");
        assert_eq!(results.len(), 0);
    }

    #[tokio::test]
    async fn test_query_reports_with_limit_offset() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        for i in 0..5 {
            db.upsert_report(&create_test_payload(
                "prod",
                "default",
                &format!("app{}", i),
                "vulnerabilityreport",
            ))
            .await
            .unwrap();
        }

        let params = QueryParams {
            limit: Some(2),
            ..Default::default()
        };
        let (results, _total) = db
            .query_reports("vulnerabilityreport", &params)
            .await
            .expect("Failed to query");
        assert_eq!(results.len(), 2);

        let params = QueryParams {
            limit: Some(2),
            offset: Some(3),
            ..Default::default()
        };
        let (results, _total) = db
            .query_reports("vulnerabilityreport", &params)
            .await
            .expect("Failed to query");
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_list_clusters_with_data() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app2",
            "sbomreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "staging",
            "default",
            "app3",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();

        let clusters = db.list_clusters().await.expect("Failed to list clusters");
        assert_eq!(clusters.len(), 2);

        let prod = clusters.iter().find(|c| c.name == "prod").unwrap();
        assert_eq!(prod.vuln_report_count, 1);
        assert_eq!(prod.sbom_report_count, 1);

        let staging = clusters.iter().find(|c| c.name == "staging").unwrap();
        assert_eq!(staging.vuln_report_count, 1);
        assert_eq!(staging.sbom_report_count, 0);
    }

    #[tokio::test]
    async fn test_update_notes_creates_then_updates() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");
        let payload = create_test_payload("prod", "default", "app1", "vulnerabilityreport");
        db.upsert_report(&payload).await.expect("Failed to insert");

        // First update: creates notes
        db.update_notes(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
            "first note",
        )
        .await
        .expect("Failed to update notes");

        let report = db
            .get_report("prod", "default", "app1", "vulnerabilityreport")
            .await
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
        .await
        .expect("Failed to update notes");

        let report = db
            .get_report("prod", "default", "app1", "vulnerabilityreport")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(report.meta.notes, "updated note");
        assert_eq!(report.meta.notes_created_at, created_at);
    }

    #[tokio::test]
    async fn test_update_notes_nonexistent_report() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        let updated = db
            .update_notes(
                "prod",
                "default",
                "nonexistent",
                "vulnerabilityreport",
                "note",
            )
            .await
            .expect("Failed to update notes");
        assert!(!updated);
    }

    #[tokio::test]
    async fn test_get_stats_with_data() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app2",
            "sbomreport",
        ))
        .await
        .unwrap();

        let stats = db.get_stats().await.expect("Failed to get stats");
        assert_eq!(stats.total_clusters, 1);
        assert_eq!(stats.total_vuln_reports, 1);
        assert_eq!(stats.total_sbom_reports, 1);
        assert_eq!(stats.total_critical, 2);
        assert_eq!(stats.total_high, 5);
    }

    #[tokio::test]
    async fn test_query_sbom_reports() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app2",
            "sbomreport",
        ))
        .await
        .unwrap();
        db.upsert_report(&create_test_payload(
            "prod",
            "kube-system",
            "app3",
            "sbomreport",
        ))
        .await
        .unwrap();

        let params = QueryParams::default();
        let (results, _total) = db
            .query_reports("sbomreport", &params)
            .await
            .expect("Failed to query");
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.report_type == "sbomreport"));
    }

    #[tokio::test]
    async fn test_severity_filter_ignored_for_sbom() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "sbom1",
            "sbomreport",
        ))
        .await
        .unwrap();

        // Severity filter should be ignored for SBOM reports
        let params = QueryParams {
            severity: Some(vec!["critical".to_string()]),
            ..Default::default()
        };
        let (results, _total) = db
            .query_reports("sbomreport", &params)
            .await
            .expect("Failed to query");
        assert_eq!(results.len(), 1);
    }

    #[tokio::test]
    async fn test_get_report_not_found_directly() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        let report = db
            .get_report("prod", "default", "nonexistent", "vulnerabilityreport")
            .await
            .expect("Failed to query");
        assert!(report.is_none());
    }
}
