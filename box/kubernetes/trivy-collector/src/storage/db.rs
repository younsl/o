use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tracing::{debug, error, info};

use crate::collector::types::ReportPayload;

/// Query parameters for filtering reports
#[derive(Debug, Default, Clone)]
pub struct QueryParams {
    pub cluster: Option<String>,
    pub namespace: Option<String>,
    pub app: Option<String>,
    pub severity: Option<Vec<String>>,
    pub image: Option<String>,
    pub cve: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Summary of vulnerability counts
#[derive(Debug, Clone, serde::Serialize)]
pub struct VulnSummary {
    pub critical: i64,
    pub high: i64,
    pub medium: i64,
    pub low: i64,
    pub unknown: i64,
}

/// Report metadata for listing
#[derive(Debug, Clone, serde::Serialize)]
pub struct ReportMeta {
    pub id: i64,
    pub cluster: String,
    pub namespace: String,
    pub name: String,
    pub app: String,
    pub image: String,
    pub report_type: String,
    pub summary: Option<VulnSummary>,
    pub components_count: Option<i64>,
    pub received_at: String,
    pub updated_at: String,
    pub notes: String,
    pub notes_created_at: Option<String>,
    pub notes_updated_at: Option<String>,
}

/// Full report with data
#[derive(Debug, Clone, serde::Serialize)]
pub struct FullReport {
    pub meta: ReportMeta,
    pub data: serde_json::Value,
}

/// Cluster info
#[derive(Debug, Clone, serde::Serialize)]
pub struct ClusterInfo {
    pub name: String,
    pub vuln_report_count: i64,
    pub sbom_report_count: i64,
    pub last_seen: String,
}

/// Overall statistics
#[derive(Debug, Clone, serde::Serialize)]
pub struct Stats {
    pub total_clusters: i64,
    pub total_vuln_reports: i64,
    pub total_sbom_reports: i64,
    pub total_critical: i64,
    pub total_high: i64,
    pub total_medium: i64,
    pub total_low: i64,
    pub db_size_bytes: u64,
    pub db_size_human: String,
}

pub struct Database {
    conn: Arc<Mutex<Connection>>,
    db_path: String,
}

impl Database {
    pub fn new(db_path: &str) -> Result<Self> {
        info!(path = %db_path, "Initializing database");

        // Check if database file already exists
        let db_exists = Path::new(db_path).exists();
        if db_exists {
            let metadata = std::fs::metadata(db_path).ok();
            let size = metadata.map(|m| Self::format_bytes(m.len())).unwrap_or_else(|| "unknown".to_string());
            info!(path = %db_path, size = %size, "Found existing database file");
        } else {
            info!(path = %db_path, "Creating new database file");
        }

        // Create parent directory if it doesn't exist
        if let Some(parent) = Path::new(db_path).parent() {
            if !parent.exists() {
                info!(directory = %parent.display(), "Creating database directory");
                std::fs::create_dir_all(parent)
                    .context("Failed to create database directory")?;
            }
        }

        // Open database connection
        debug!(path = %db_path, "Opening SQLite connection");
        let conn = Connection::open(db_path).map_err(|e| {
            error!(path = %db_path, error = %e, "Failed to open SQLite database");
            e
        }).context("Failed to open SQLite database")?;

        // Get SQLite version
        let sqlite_version: String = conn
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))
            .unwrap_or_else(|_| "unknown".to_string());
        debug!(sqlite_version = %sqlite_version, "SQLite version");

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: db_path.to_string(),
        };

        // Initialize schema
        db.init_schema()?;

        // Log final database status
        let (size_bytes, size_human) = db.get_db_size();
        let report_count = db.get_total_report_count().unwrap_or(0);

        info!(
            path = %db_path,
            size = %size_human,
            size_bytes = size_bytes,
            reports = report_count,
            sqlite_version = %sqlite_version,
            "Database initialized successfully"
        );

        Ok(db)
    }

    /// Get total report count
    fn get_total_report_count(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM reports",
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        Ok(count)
    }

    /// Get database file size
    pub fn get_db_size(&self) -> (u64, String) {
        match std::fs::metadata(&self.db_path) {
            Ok(metadata) => {
                let size = metadata.len();
                let human = Self::format_bytes(size);
                (size, human)
            }
            Err(_) => (0, "0 B".to_string()),
        }
    }

    fn format_bytes(bytes: u64) -> String {
        const KB: u64 = 1024;
        const MB: u64 = KB * 1024;
        const GB: u64 = MB * 1024;

        if bytes >= GB {
            format!("{:.2} GB", bytes as f64 / GB as f64)
        } else if bytes >= MB {
            format!("{:.2} MB", bytes as f64 / MB as f64)
        } else if bytes >= KB {
            format!("{:.2} KB", bytes as f64 / KB as f64)
        } else {
            format!("{} B", bytes)
        }
    }

    fn init_schema(&self) -> Result<()> {
        debug!("Initializing database schema");
        let conn = self.conn.lock().unwrap();

        // Check if reports table exists (to determine if this is a fresh DB)
        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='reports'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if table_exists {
            debug!("Reports table already exists, checking schema");
        } else {
            info!("Creating new database schema");
        }

        conn.execute_batch(
            r#"
            -- Reports table
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cluster TEXT NOT NULL,
                namespace TEXT NOT NULL,
                name TEXT NOT NULL,
                report_type TEXT NOT NULL,
                app TEXT DEFAULT '',
                image TEXT DEFAULT '',
                registry TEXT DEFAULT '',
                critical_count INTEGER DEFAULT 0,
                high_count INTEGER DEFAULT 0,
                medium_count INTEGER DEFAULT 0,
                low_count INTEGER DEFAULT 0,
                unknown_count INTEGER DEFAULT 0,
                components_count INTEGER DEFAULT 0,
                data TEXT NOT NULL,
                received_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                notes TEXT DEFAULT '',
                notes_created_at TEXT,
                notes_updated_at TEXT,
                UNIQUE(cluster, namespace, name, report_type)
            );

            -- Indexes for common queries
            CREATE INDEX IF NOT EXISTS idx_reports_cluster ON reports(cluster);
            CREATE INDEX IF NOT EXISTS idx_reports_namespace ON reports(namespace);
            CREATE INDEX IF NOT EXISTS idx_reports_report_type ON reports(report_type);
            CREATE INDEX IF NOT EXISTS idx_reports_app ON reports(app);
            CREATE INDEX IF NOT EXISTS idx_reports_severity ON reports(critical_count, high_count);

            -- Clusters view for quick cluster listing
            CREATE VIEW IF NOT EXISTS clusters_view AS
            SELECT
                cluster,
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN 1 ELSE 0 END) as vuln_count,
                SUM(CASE WHEN report_type = 'sbomreport' THEN 1 ELSE 0 END) as sbom_count,
                MAX(updated_at) as last_seen
            FROM reports
            GROUP BY cluster;
            "#,
        )
        .context("Failed to initialize database schema")?;

        // Migration: Add notes column if it doesn't exist (for existing databases)
        let has_notes_column: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('reports') WHERE name='notes'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_notes_column {
            info!("Migrating database: adding notes column");
            conn.execute("ALTER TABLE reports ADD COLUMN notes TEXT DEFAULT ''", [])
                .context("Failed to add notes column")?;
        }

        // Migration: Add notes_created_at column if it doesn't exist
        let has_notes_created_at: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('reports') WHERE name='notes_created_at'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_notes_created_at {
            info!("Migrating database: adding notes_created_at column");
            conn.execute("ALTER TABLE reports ADD COLUMN notes_created_at TEXT", [])
                .context("Failed to add notes_created_at column")?;
        }

        // Migration: Add notes_updated_at column if it doesn't exist
        let has_notes_updated_at: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('reports') WHERE name='notes_updated_at'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_notes_updated_at {
            info!("Migrating database: adding notes_updated_at column");
            conn.execute("ALTER TABLE reports ADD COLUMN notes_updated_at TEXT", [])
                .context("Failed to add notes_updated_at column")?;
        }

        // Log schema details
        let index_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name='reports'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        debug!(
            table = "reports",
            indexes = index_count,
            view = "clusters_view",
            "Database schema initialized"
        );

        Ok(())
    }

    /// Insert or update a report
    pub fn upsert_report(&self, payload: &ReportPayload) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        // Extract metadata from data
        let (app, image, registry) = self.extract_metadata(&payload.data);
        let (critical, high, medium, low, unknown) = self.extract_vuln_summary(&payload.data);
        let components_count = self.extract_components_count(&payload.data);

        let data_json = serde_json::to_string(&payload.data)?;
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
                data_json,
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
    pub fn query_reports(&self, report_type: &str, params: &QueryParams) -> Result<Vec<ReportMeta>> {
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

        // Severity filter (only for vulnerability reports, SBOM reports don't have severity counts)
        if report_type == "vulnerabilityreport" {
            if let Some(severities) = &params.severity {
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

        let params_refs: Vec<&dyn rusqlite::ToSql> = sql_params.iter().map(|p| p.as_ref()).collect();

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
            let data_str: String = row.get(15)?;
            let data: serde_json::Value = serde_json::from_str(&data_str).unwrap_or_default();

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
                data,
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

        let stats = conn.query_row(
            r#"
            SELECT
                COUNT(DISTINCT cluster) as total_clusters,
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN 1 ELSE 0 END) as total_vuln,
                SUM(CASE WHEN report_type = 'sbomreport' THEN 1 ELSE 0 END) as total_sbom,
                COALESCE(SUM(critical_count), 0) as total_critical,
                COALESCE(SUM(high_count), 0) as total_high,
                COALESCE(SUM(medium_count), 0) as total_medium,
                COALESCE(SUM(low_count), 0) as total_low
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
                    db_size_bytes,
                    db_size_human,
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
            let mut stmt = conn.prepare(
                "SELECT DISTINCT namespace FROM reports ORDER BY namespace",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for row in rows {
                results.push(row?);
            }
        }

        Ok(results)
    }

    // Helper methods for extracting metadata from JSON

    fn extract_metadata(&self, data: &serde_json::Value) -> (String, String, String) {
        let app = data
            .get("metadata")
            .and_then(|m| m.get("labels"))
            .and_then(|l| {
                l.get("trivy-operator.resource.name")
                    .or_else(|| l.get("app.kubernetes.io/name"))
                    .or_else(|| l.get("app"))
            })
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let artifact = data.get("report").and_then(|r| r.get("artifact"));
        let image = artifact
            .map(|a| {
                let repo = a.get("repository").and_then(|v| v.as_str()).unwrap_or("");
                let tag = a.get("tag").and_then(|v| v.as_str()).unwrap_or("");
                if tag.is_empty() {
                    repo.to_string()
                } else {
                    format!("{}:{}", repo, tag)
                }
            })
            .unwrap_or_default();

        let registry = data
            .get("report")
            .and_then(|r| r.get("registry"))
            .and_then(|r| r.get("server"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        (app, image, registry)
    }

    fn extract_vuln_summary(&self, data: &serde_json::Value) -> (i64, i64, i64, i64, i64) {
        let summary = data.get("report").and_then(|r| r.get("summary"));
        if let Some(s) = summary {
            (
                s.get("criticalCount").and_then(|v| v.as_i64()).unwrap_or(0),
                s.get("highCount").and_then(|v| v.as_i64()).unwrap_or(0),
                s.get("mediumCount").and_then(|v| v.as_i64()).unwrap_or(0),
                s.get("lowCount").and_then(|v| v.as_i64()).unwrap_or(0),
                s.get("unknownCount").and_then(|v| v.as_i64()).unwrap_or(0),
            )
        } else {
            (0, 0, 0, 0, 0)
        }
    }

    fn extract_components_count(&self, data: &serde_json::Value) -> i64 {
        data.get("report")
            .and_then(|r| r.get("summary"))
            .and_then(|s| s.get("componentsCount"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
    }
}

impl Clone for Database {
    fn clone(&self) -> Self {
        Self {
            conn: self.conn.clone(),
            db_path: self.db_path.clone(),
        }
    }
}
