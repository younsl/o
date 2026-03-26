//! API request logging storage operations

use anyhow::{Context, Result};

use super::Database;
use super::models::{ApiLogEntry, ApiLogQuery, ApiLogStats, CleanupHistoryEntry};

impl Database {
    /// Insert an API log entry
    pub fn insert_api_log(&self, entry: &ApiLogEntry) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"INSERT INTO api_logs (method, path, status_code, duration_ms, user_sub, user_email, remote_addr, user_agent, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
            rusqlite::params![
                entry.method,
                entry.path,
                entry.status_code,
                entry.duration_ms,
                entry.user_sub,
                entry.user_email,
                entry.remote_addr,
                entry.user_agent,
                entry.created_at,
            ],
        )
        .context("Failed to insert API log")?;
        Ok(())
    }

    /// List API logs with filtering and pagination
    pub fn list_api_logs(&self, params: &ApiLogQuery) -> Result<(Vec<ApiLogEntry>, i64)> {
        let conn = self.conn.lock().unwrap();

        let mut conditions = Vec::new();
        let mut bind_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(method) = &params.method {
            bind_values.push(Box::new(method.clone()));
            conditions.push(format!("method = ?{}", bind_values.len()));
        }
        if let Some(path_prefix) = &params.path_prefix {
            bind_values.push(Box::new(format!("{}%", path_prefix)));
            conditions.push(format!("path LIKE ?{}", bind_values.len()));
        }
        if let Some(status_min) = params.status_min {
            bind_values.push(Box::new(status_min as i32));
            conditions.push(format!("status_code >= ?{}", bind_values.len()));
        }
        if let Some(status_max) = params.status_max {
            bind_values.push(Box::new(status_max as i32));
            conditions.push(format!("status_code <= ?{}", bind_values.len()));
        }
        if let Some(user) = &params.user {
            bind_values.push(Box::new(format!("%{}%", user)));
            conditions.push(format!(
                "(user_email LIKE ?{len} OR user_sub LIKE ?{len})",
                len = bind_values.len()
            ));
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        // Count total
        let count_sql = format!("SELECT COUNT(*) FROM api_logs {}", where_clause);
        let total: i64 = conn
            .query_row(
                &count_sql,
                rusqlite::params_from_iter(bind_values.iter().map(|v| v.as_ref())),
                |row| row.get(0),
            )
            .unwrap_or(0);

        // Fetch rows
        let query_sql = format!(
            "SELECT id, method, path, status_code, duration_ms, user_sub, user_email, remote_addr, user_agent, created_at
             FROM api_logs {} ORDER BY id DESC LIMIT ?{} OFFSET ?{}",
            where_clause,
            bind_values.len() + 1,
            bind_values.len() + 2,
        );
        bind_values.push(Box::new(params.limit));
        bind_values.push(Box::new(params.offset));

        let mut stmt = conn.prepare(&query_sql)?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(bind_values.iter().map(|v| v.as_ref())),
                |row| {
                    Ok(ApiLogEntry {
                        id: Some(row.get(0)?),
                        method: row.get(1)?,
                        path: row.get(2)?,
                        status_code: row.get::<_, i32>(3)? as u16,
                        duration_ms: row.get::<_, i64>(4)? as u64,
                        user_sub: row.get(5)?,
                        user_email: row.get(6)?,
                        remote_addr: row.get(7)?,
                        user_agent: row.get(8)?,
                        created_at: row.get(9)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;

        Ok((rows, total))
    }

    /// Get API log statistics
    pub fn get_api_log_stats(&self) -> Result<ApiLogStats> {
        let conn = self.conn.lock().unwrap();

        let total_requests: i64 = conn
            .query_row("SELECT COUNT(*) FROM api_logs", [], |row| row.get(0))
            .unwrap_or(0);

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let requests_today: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM api_logs WHERE created_at >= ?1",
                [&today],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let avg_duration_ms: f64 = conn
            .query_row(
                "SELECT COALESCE(AVG(duration_ms), 0) FROM api_logs",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0.0);

        let error_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM api_logs WHERE status_code >= 400",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let unique_users: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT user_email) FROM api_logs WHERE user_email != ''",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // Top paths with error count
        let mut stmt = conn.prepare(
            "SELECT path, COUNT(*) as cnt, SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors FROM api_logs GROUP BY path ORDER BY cnt DESC LIMIT 10",
        )?;
        let top_paths = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Last cleanup entry
        let last_cleanup: Option<CleanupHistoryEntry> = conn
            .query_row(
                "SELECT id, retention_days, deleted_count, triggered_by, cleaned_at FROM cleanup_history ORDER BY id DESC LIMIT 1",
                [],
                |row| {
                    Ok(CleanupHistoryEntry {
                        id: row.get(0)?,
                        retention_days: row.get::<_, i32>(1)? as u32,
                        deleted_count: row.get(2)?,
                        triggered_by: row.get(3)?,
                        cleaned_at: row.get(4)?,
                    })
                },
            )
            .ok();

        Ok(ApiLogStats {
            total_requests,
            requests_today,
            avg_duration_ms,
            error_count,
            unique_users,
            top_paths,
            last_cleanup,
        })
    }

    /// Delete API logs older than retention_days and record cleanup history
    pub fn cleanup_old_api_logs(&self, retention_days: u32, triggered_by: &str) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%dT%H:%M:%S").to_string();

        let deleted = conn.execute("DELETE FROM api_logs WHERE created_at < ?1", [&cutoff_str])?;
        let deleted_count = deleted as u64;

        // Record cleanup history
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        conn.execute(
            "INSERT INTO cleanup_history (retention_days, deleted_count, triggered_by, cleaned_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![retention_days, deleted_count as i64, triggered_by, now],
        )
        .context("Failed to record cleanup history")?;

        Ok(deleted_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::models::{ApiLogEntry, ApiLogQuery};

    fn sample_log(method: &str, path: &str, status: u16) -> ApiLogEntry {
        ApiLogEntry {
            id: None,
            method: method.to_string(),
            path: path.to_string(),
            status_code: status,
            duration_ms: 42,
            user_sub: "sub-123".to_string(),
            user_email: "user@example.com".to_string(),
            remote_addr: "10.0.0.1".to_string(),
            user_agent: "test-agent".to_string(),
            created_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        }
    }

    fn old_log(method: &str, path: &str) -> ApiLogEntry {
        ApiLogEntry {
            id: None,
            method: method.to_string(),
            path: path.to_string(),
            status_code: 200,
            duration_ms: 10,
            user_sub: String::new(),
            user_email: String::new(),
            remote_addr: String::new(),
            user_agent: String::new(),
            created_at: "2020-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_insert_and_list_api_logs() {
        let db = Database::new(":memory:").unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/stats", 200))
            .unwrap();
        db.insert_api_log(&sample_log("POST", "/api/v1/reports", 500))
            .unwrap();

        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                limit: 50,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(total, 2);
        assert_eq!(items.len(), 2);
        assert!(items[0].id.is_some());
    }

    #[test]
    fn test_list_api_logs_filter_by_method() {
        let db = Database::new(":memory:").unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/stats", 200))
            .unwrap();
        db.insert_api_log(&sample_log("POST", "/api/v1/reports", 200))
            .unwrap();

        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                method: Some("GET".to_string()),
                limit: 50,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(total, 1);
        assert_eq!(items[0].method, "GET");
    }

    #[test]
    fn test_list_api_logs_filter_by_path_prefix() {
        let db = Database::new(":memory:").unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/stats", 200))
            .unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/clusters", 200))
            .unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/admin/logs", 200))
            .unwrap();

        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                path_prefix: Some("/api/v1/admin".to_string()),
                limit: 50,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(total, 1);
        assert_eq!(items[0].path, "/api/v1/admin/logs");
    }

    #[test]
    fn test_list_api_logs_filter_by_status_range() {
        let db = Database::new(":memory:").unwrap();
        db.insert_api_log(&sample_log("GET", "/a", 200)).unwrap();
        db.insert_api_log(&sample_log("GET", "/b", 404)).unwrap();
        db.insert_api_log(&sample_log("GET", "/c", 500)).unwrap();

        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                status_min: Some(400),
                status_max: Some(499),
                limit: 50,
                ..Default::default()
            })
            .unwrap();

        assert_eq!(total, 1);
        assert_eq!(items[0].status_code, 404);
    }

    #[test]
    fn test_list_api_logs_filter_by_user() {
        let db = Database::new(":memory:").unwrap();
        db.insert_api_log(&sample_log("GET", "/a", 200)).unwrap();

        let (_, total) = db
            .list_api_logs(&ApiLogQuery {
                user: Some("user@example.com".to_string()),
                limit: 50,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(total, 1);

        let (_, total) = db
            .list_api_logs(&ApiLogQuery {
                user: Some("nobody@example.com".to_string()),
                limit: 50,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(total, 0);
    }

    #[test]
    fn test_list_api_logs_pagination() {
        let db = Database::new(":memory:").unwrap();
        for i in 0..5 {
            db.insert_api_log(&sample_log("GET", &format!("/path/{}", i), 200))
                .unwrap();
        }

        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                limit: 2,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(total, 5);
        assert_eq!(items.len(), 2);

        let (items, _) = db
            .list_api_logs(&ApiLogQuery {
                limit: 2,
                offset: 4,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn test_get_api_log_stats_empty() {
        let db = Database::new(":memory:").unwrap();
        let stats = db.get_api_log_stats().unwrap();
        assert_eq!(stats.total_requests, 0);
        assert_eq!(stats.requests_today, 0);
        assert_eq!(stats.error_count, 0);
        assert_eq!(stats.unique_users, 0);
        assert!(stats.top_paths.is_empty());
        assert!(stats.last_cleanup.is_none());
    }

    #[test]
    fn test_get_api_log_stats_with_data() {
        let db = Database::new(":memory:").unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/stats", 200))
            .unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/stats", 500))
            .unwrap();
        db.insert_api_log(&sample_log("POST", "/api/v1/reports", 200))
            .unwrap();

        let stats = db.get_api_log_stats().unwrap();
        assert_eq!(stats.total_requests, 3);
        assert_eq!(stats.requests_today, 3);
        assert_eq!(stats.error_count, 1);
        assert_eq!(stats.unique_users, 1);
        assert!(!stats.top_paths.is_empty());
        // /api/v1/stats should be top path with 2 requests
        assert_eq!(stats.top_paths[0].0, "/api/v1/stats");
        assert_eq!(stats.top_paths[0].1, 2);
    }

    #[test]
    fn test_cleanup_old_api_logs() {
        let db = Database::new(":memory:").unwrap();
        // Insert old logs (2020) and recent logs
        db.insert_api_log(&old_log("GET", "/old")).unwrap();
        db.insert_api_log(&old_log("GET", "/old2")).unwrap();
        db.insert_api_log(&sample_log("GET", "/recent", 200))
            .unwrap();

        let deleted = db.cleanup_old_api_logs(7, "test-user").unwrap();
        assert_eq!(deleted, 2);

        // Verify only recent log remains
        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                limit: 50,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(items[0].path, "/recent");

        // Verify cleanup history recorded
        let stats = db.get_api_log_stats().unwrap();
        assert!(stats.last_cleanup.is_some());
        let cleanup = stats.last_cleanup.unwrap();
        assert_eq!(cleanup.retention_days, 7);
        assert_eq!(cleanup.deleted_count, 2);
        assert_eq!(cleanup.triggered_by, "test-user");
    }

    #[test]
    fn test_cleanup_no_old_logs() {
        let db = Database::new(":memory:").unwrap();
        db.insert_api_log(&sample_log("GET", "/recent", 200))
            .unwrap();

        let deleted = db.cleanup_old_api_logs(7, "system").unwrap();
        assert_eq!(deleted, 0);
    }

    #[test]
    fn test_count_api_logs() {
        let db = Database::new(":memory:").unwrap();
        assert_eq!(db.count_api_logs().unwrap(), 0);

        db.insert_api_log(&sample_log("GET", "/a", 200)).unwrap();
        db.insert_api_log(&sample_log("POST", "/b", 201)).unwrap();
        assert_eq!(db.count_api_logs().unwrap(), 2);
    }

    #[test]
    fn test_count_reports() {
        let db = Database::new(":memory:").unwrap();
        assert_eq!(db.count_reports("vulnerabilityreport").unwrap(), 0);
        assert_eq!(db.count_reports("sbomreport").unwrap(), 0);
    }
}
