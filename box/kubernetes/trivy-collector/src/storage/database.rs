//! Database connection and lifecycle management

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tracing::{debug, error, info};

use super::schema::init_schema;

/// SQLite database wrapper with connection pooling
pub struct Database {
    pub(super) conn: Arc<Mutex<Connection>>,
    db_path: String,
}

impl Database {
    /// Create a new database connection
    pub fn new(db_path: &str) -> Result<Self> {
        info!(path = %db_path, "Initializing database");

        // Check if database file already exists
        let db_exists = Path::new(db_path).exists();
        if db_exists {
            let metadata = std::fs::metadata(db_path).ok();
            let size = metadata
                .map(|m| Self::format_bytes(m.len()))
                .unwrap_or_else(|| "unknown".to_string());
            info!(path = %db_path, size = %size, "Found existing database file");
        } else {
            info!(path = %db_path, "Creating new database file");
        }

        // Create parent directory if it doesn't exist
        if let Some(parent) = Path::new(db_path).parent()
            && !parent.as_os_str().is_empty()
            && !parent.exists()
        {
            info!(directory = %parent.display(), "Creating database directory");
            std::fs::create_dir_all(parent).context("Failed to create database directory")?;
        }

        // Open database connection
        debug!(path = %db_path, "Opening SQLite connection");
        let conn = Connection::open(db_path)
            .map_err(|e| {
                error!(path = %db_path, error = %e, "Failed to open SQLite database");
                e
            })
            .context("Failed to open SQLite database")?;

        // Get SQLite version
        let sqlite_version: String = conn
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))
            .unwrap_or_else(|_| "unknown".to_string());
        debug!(sqlite_version = %sqlite_version, "SQLite version");

        // Initialize schema
        init_schema(&conn)?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: db_path.to_string(),
        };

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
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM reports", [], |row| row.get(0))
            .unwrap_or(0);
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

impl Clone for Database {
    fn clone(&self) -> Self {
        Self {
            conn: self.conn.clone(),
            db_path: self.db_path.clone(),
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

    #[test]
    fn test_database_in_memory() {
        let db = Database::new(":memory:").expect("Failed to create in-memory database");
        let count = db.get_total_report_count().expect("Failed to get count");
        assert_eq!(count, 0);
    }

    #[test]
    fn test_database_stats_empty() {
        let db = Database::new(":memory:").expect("Failed to create database");
        let stats = db.get_stats().expect("Failed to get stats");

        assert_eq!(stats.total_clusters, 0);
        assert_eq!(stats.total_vuln_reports, 0);
        assert_eq!(stats.total_sbom_reports, 0);
        assert_eq!(stats.total_critical, 0);
        assert_eq!(stats.total_high, 0);
    }

    #[test]
    fn test_database_list_clusters_empty() {
        let db = Database::new(":memory:").expect("Failed to create database");
        let clusters = db.list_clusters().expect("Failed to list clusters");
        assert!(clusters.is_empty());
    }

    #[test]
    fn test_database_list_namespaces_empty() {
        let db = Database::new(":memory:").expect("Failed to create database");
        let namespaces = db.list_namespaces(None).expect("Failed to list namespaces");
        assert!(namespaces.is_empty());
    }
}
