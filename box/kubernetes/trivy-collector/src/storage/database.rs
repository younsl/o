//! Database connection and lifecycle management

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use std::path::Path;
use std::str::FromStr;
use tracing::{debug, info};

use super::schema::init_schema;

/// SQLite database wrapper with sqlx async connection pooling
#[derive(Clone)]
pub struct Database {
    pub(super) pool: SqlitePool,
    db_path: String,
}

impl Database {
    /// Default pool size for file-based databases
    const DEFAULT_POOL_SIZE: u32 = 8;

    /// Create a new database with async connection pooling
    pub async fn new(db_path: &str) -> Result<Self> {
        info!(path = %db_path, "Initializing database");

        // Check if database file already exists
        let db_exists = Path::new(db_path).exists();
        if db_exists {
            let metadata = std::fs::metadata(db_path).ok();
            let size = metadata
                .map(|m| Self::format_bytes(m.len()))
                .unwrap_or_else(|| "unknown".to_string());
            info!(path = %db_path, size = %size, "Found existing database file");
        } else if db_path != ":memory:" {
            info!(path = %db_path, "Creating new database file");
        }

        // Create parent directory if it doesn't exist
        if db_path != ":memory:"
            && let Some(parent) = Path::new(db_path).parent()
            && !parent.as_os_str().is_empty()
            && !parent.exists()
        {
            info!(directory = %parent.display(), "Creating database directory");
            std::fs::create_dir_all(parent).context("Failed to create database directory")?;
        }

        // Build connection options with pragmas
        let connect_options = if db_path == ":memory:" {
            SqliteConnectOptions::from_str("sqlite::memory:")?
        } else {
            SqliteConnectOptions::from_str(&format!("sqlite:{}", db_path))?
        }
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_millis(5000))
        .foreign_keys(true)
        .create_if_missing(true);

        // In-memory databases must use pool_size=1 since each connection
        // would otherwise create a separate isolated database
        let pool_size = if db_path == ":memory:" {
            1
        } else {
            Self::DEFAULT_POOL_SIZE
        };

        debug!(pool_size = pool_size, "Building connection pool");

        let pool = SqlitePoolOptions::new()
            .max_connections(pool_size)
            .connect_with(connect_options)
            .await
            .context("Failed to create database connection pool")?;

        // Initialize schema
        init_schema(&pool).await?;

        let db = Self {
            pool,
            db_path: db_path.to_string(),
        };

        // Log final database status
        let (size_bytes, size_human) = db.get_db_size();
        let report_count = db.get_total_report_count().await.unwrap_or(0);

        info!(
            path = %db_path,
            size = %size_human,
            size_bytes = size_bytes,
            reports = report_count,
            pool_size = pool_size,
            "Database initialized successfully"
        );

        Ok(db)
    }

    /// Get total report count
    async fn get_total_report_count(&self) -> Result<i64> {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM reports")
            .fetch_one(&self.pool)
            .await
            .unwrap_or((0,));
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

    /// Count reports by type (for metrics)
    pub async fn count_reports(&self, report_type: &str) -> Result<i64> {
        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM reports WHERE report_type = $1")
                .bind(report_type)
                .fetch_one(&self.pool)
                .await
                .unwrap_or((0,));
        Ok(count)
    }

    /// Count API log entries (for metrics)
    pub async fn count_api_logs(&self) -> Result<i64> {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM api_logs")
            .fetch_one(&self.pool)
            .await
            .unwrap_or((0,));
        Ok(count)
    }

    /// Format bytes into human-readable string
    pub(super) fn format_bytes(bytes: u64) -> String {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_bytes_bytes() {
        assert_eq!(Database::format_bytes(0), "0 B");
        assert_eq!(Database::format_bytes(512), "512 B");
        assert_eq!(Database::format_bytes(1023), "1023 B");
    }

    #[test]
    fn test_format_bytes_kilobytes() {
        assert_eq!(Database::format_bytes(1024), "1.00 KB");
        assert_eq!(Database::format_bytes(1536), "1.50 KB");
        assert_eq!(Database::format_bytes(10240), "10.00 KB");
    }

    #[test]
    fn test_format_bytes_megabytes() {
        assert_eq!(Database::format_bytes(1024 * 1024), "1.00 MB");
        assert_eq!(Database::format_bytes(1024 * 1024 * 5), "5.00 MB");
        assert_eq!(Database::format_bytes(1024 * 1024 + 512 * 1024), "1.50 MB");
    }

    #[test]
    fn test_format_bytes_gigabytes() {
        assert_eq!(Database::format_bytes(1024 * 1024 * 1024), "1.00 GB");
        assert_eq!(Database::format_bytes(1024 * 1024 * 1024 * 2), "2.00 GB");
    }

    #[tokio::test]
    async fn test_database_in_memory() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create in-memory database");
        let count = db
            .get_total_report_count()
            .await
            .expect("Failed to get count");
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn test_database_stats_empty() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");
        let stats = db.get_stats().await.expect("Failed to get stats");

        assert_eq!(stats.total_clusters, 0);
        assert_eq!(stats.total_vuln_reports, 0);
        assert_eq!(stats.total_sbom_reports, 0);
        assert_eq!(stats.total_critical, 0);
        assert_eq!(stats.total_high, 0);
    }

    #[tokio::test]
    async fn test_database_list_clusters_empty() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");
        let clusters = db.list_clusters().await.expect("Failed to list clusters");
        assert!(clusters.is_empty());
    }

    #[tokio::test]
    async fn test_database_list_namespaces_empty() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");
        let namespaces = db
            .list_namespaces(None)
            .await
            .expect("Failed to list namespaces");
        assert!(namespaces.is_empty());
    }
}
