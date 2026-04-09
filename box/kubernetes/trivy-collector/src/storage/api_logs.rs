//! API request logging storage operations

use anyhow::{Context, Result};
use sqlx::{QueryBuilder, Row, Sqlite};

use super::Database;
use super::models::{ApiLogEntry, ApiLogQuery, ApiLogStats, CleanupHistoryEntry};

impl Database {
    /// Insert an API log entry
    pub async fn insert_api_log(&self, entry: &ApiLogEntry) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO api_logs (method, path, status_code, duration_ms, user_sub, user_email, remote_addr, user_agent, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"#,
        )
        .bind(&entry.method)
        .bind(&entry.path)
        .bind(entry.status_code as i32)
        .bind(entry.duration_ms as i64)
        .bind(&entry.user_sub)
        .bind(&entry.user_email)
        .bind(&entry.remote_addr)
        .bind(&entry.user_agent)
        .bind(&entry.created_at)
        .execute(&self.pool)
        .await
        .context("Failed to insert API log")?;
        Ok(())
    }

    /// List API logs with filtering and pagination
    pub async fn list_api_logs(&self, params: &ApiLogQuery) -> Result<(Vec<ApiLogEntry>, i64)> {
        // Count total using QueryBuilder
        let mut count_builder: QueryBuilder<Sqlite> =
            QueryBuilder::new("SELECT COUNT(*) FROM api_logs");

        let mut has_where = false;
        if let Some(method) = &params.method {
            count_builder.push(" WHERE method = ");
            count_builder.push_bind(method.clone());
            has_where = true;
        }
        if let Some(path_prefix) = &params.path_prefix {
            count_builder.push(if has_where { " AND " } else { " WHERE " });
            count_builder.push("path LIKE ");
            count_builder.push_bind(format!("{}%", path_prefix));
            has_where = true;
        }
        if let Some(status_min) = params.status_min {
            count_builder.push(if has_where { " AND " } else { " WHERE " });
            count_builder.push("status_code >= ");
            count_builder.push_bind(status_min as i32);
            has_where = true;
        }
        if let Some(status_max) = params.status_max {
            count_builder.push(if has_where { " AND " } else { " WHERE " });
            count_builder.push("status_code <= ");
            count_builder.push_bind(status_max as i32);
            has_where = true;
        }
        if let Some(user) = &params.user {
            count_builder.push(if has_where { " AND " } else { " WHERE " });
            let pattern = format!("%{}%", user);
            count_builder.push("(user_email LIKE ");
            count_builder.push_bind(pattern.clone());
            count_builder.push(" OR user_sub LIKE ");
            count_builder.push_bind(pattern);
            count_builder.push(")");
        }

        let total: i64 = count_builder
            .build()
            .fetch_one(&self.pool)
            .await
            .map(|row| row.get::<i64, _>(0))
            .unwrap_or(0);

        // Fetch rows using QueryBuilder
        let mut query_builder: QueryBuilder<Sqlite> = QueryBuilder::new(
            "SELECT id, method, path, status_code, duration_ms, user_sub, user_email, remote_addr, user_agent, created_at FROM api_logs",
        );

        let mut has_where = false;
        if let Some(method) = &params.method {
            query_builder.push(" WHERE method = ");
            query_builder.push_bind(method.clone());
            has_where = true;
        }
        if let Some(path_prefix) = &params.path_prefix {
            query_builder.push(if has_where { " AND " } else { " WHERE " });
            query_builder.push("path LIKE ");
            query_builder.push_bind(format!("{}%", path_prefix));
            has_where = true;
        }
        if let Some(status_min) = params.status_min {
            query_builder.push(if has_where { " AND " } else { " WHERE " });
            query_builder.push("status_code >= ");
            query_builder.push_bind(status_min as i32);
            has_where = true;
        }
        if let Some(status_max) = params.status_max {
            query_builder.push(if has_where { " AND " } else { " WHERE " });
            query_builder.push("status_code <= ");
            query_builder.push_bind(status_max as i32);
            has_where = true;
        }
        if let Some(user) = &params.user {
            query_builder.push(if has_where { " AND " } else { " WHERE " });
            let pattern = format!("%{}%", user);
            query_builder.push("(user_email LIKE ");
            query_builder.push_bind(pattern.clone());
            query_builder.push(" OR user_sub LIKE ");
            query_builder.push_bind(pattern);
            query_builder.push(")");
        }

        query_builder.push(" ORDER BY id DESC LIMIT ");
        query_builder.push_bind(params.limit);
        query_builder.push(" OFFSET ");
        query_builder.push_bind(params.offset);

        let rows = query_builder.build().fetch_all(&self.pool).await?;

        let items = rows
            .iter()
            .map(|row| ApiLogEntry {
                id: Some(row.get::<i64, _>(0)),
                method: row.get::<String, _>(1),
                path: row.get::<String, _>(2),
                status_code: row.get::<i32, _>(3) as u16,
                duration_ms: row.get::<i64, _>(4) as u64,
                user_sub: row.get::<String, _>(5),
                user_email: row.get::<String, _>(6),
                remote_addr: row.get::<String, _>(7),
                user_agent: row.get::<String, _>(8),
                created_at: row.get::<String, _>(9),
            })
            .collect();

        Ok((items, total))
    }

    /// Get API log statistics
    pub async fn get_api_log_stats(&self) -> Result<ApiLogStats> {
        let total_requests: i64 = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM api_logs")
            .fetch_one(&self.pool)
            .await
            .map(|r| r.0)
            .unwrap_or(0);

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let requests_today: i64 =
            sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM api_logs WHERE created_at >= $1")
                .bind(&today)
                .fetch_one(&self.pool)
                .await
                .map(|r| r.0)
                .unwrap_or(0);

        let avg_duration_ms: f64 =
            sqlx::query_as::<_, (f64,)>("SELECT COALESCE(AVG(duration_ms), 0) FROM api_logs")
                .fetch_one(&self.pool)
                .await
                .map(|r| r.0)
                .unwrap_or(0.0);

        let error_count: i64 =
            sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM api_logs WHERE status_code >= 400")
                .fetch_one(&self.pool)
                .await
                .map(|r| r.0)
                .unwrap_or(0);

        let unique_users: i64 = sqlx::query_as::<_, (i64,)>(
            "SELECT COUNT(DISTINCT user_email) FROM api_logs WHERE user_email != ''",
        )
        .fetch_one(&self.pool)
        .await
        .map(|r| r.0)
        .unwrap_or(0);

        // Top paths with error count
        let top_path_rows = sqlx::query(
            "SELECT path, COUNT(*) as cnt, SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors FROM api_logs GROUP BY path ORDER BY cnt DESC LIMIT 10",
        )
        .fetch_all(&self.pool)
        .await?;

        let top_paths: Vec<(String, i64, i64)> = top_path_rows
            .iter()
            .map(|row| {
                (
                    row.get::<String, _>(0),
                    row.get::<i64, _>(1),
                    row.get::<i64, _>(2),
                )
            })
            .collect();

        // Last cleanup entry
        let last_cleanup: Option<CleanupHistoryEntry> = sqlx::query(
            "SELECT id, retention_days, deleted_count, triggered_by, cleaned_at FROM cleanup_history ORDER BY id DESC LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?
        .map(|row| CleanupHistoryEntry {
            id: row.get::<i64, _>(0),
            retention_days: row.get::<i32, _>(1) as u32,
            deleted_count: row.get::<i64, _>(2),
            triggered_by: row.get::<String, _>(3),
            cleaned_at: row.get::<String, _>(4),
        });

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
    pub async fn cleanup_old_api_logs(
        &self,
        retention_days: u32,
        triggered_by: &str,
    ) -> Result<u64> {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%dT%H:%M:%S").to_string();

        let result = sqlx::query("DELETE FROM api_logs WHERE created_at < $1")
            .bind(&cutoff_str)
            .execute(&self.pool)
            .await?;
        let deleted_count = result.rows_affected();

        // Record cleanup history
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        sqlx::query(
            "INSERT INTO cleanup_history (retention_days, deleted_count, triggered_by, cleaned_at) VALUES ($1, $2, $3, $4)",
        )
        .bind(retention_days as i32)
        .bind(deleted_count as i64)
        .bind(triggered_by)
        .bind(&now)
        .execute(&self.pool)
        .await
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

    #[tokio::test]
    async fn test_insert_and_list_api_logs() {
        let db = Database::new(":memory:").await.unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/stats", 200))
            .await
            .unwrap();
        db.insert_api_log(&sample_log("POST", "/api/v1/reports", 500))
            .await
            .unwrap();

        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(total, 2);
        assert_eq!(items.len(), 2);
        assert!(items[0].id.is_some());
    }

    #[tokio::test]
    async fn test_list_api_logs_filter_by_method() {
        let db = Database::new(":memory:").await.unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/stats", 200))
            .await
            .unwrap();
        db.insert_api_log(&sample_log("POST", "/api/v1/reports", 200))
            .await
            .unwrap();

        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                method: Some("GET".to_string()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(total, 1);
        assert_eq!(items[0].method, "GET");
    }

    #[tokio::test]
    async fn test_list_api_logs_filter_by_path_prefix() {
        let db = Database::new(":memory:").await.unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/stats", 200))
            .await
            .unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/clusters", 200))
            .await
            .unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/admin/logs", 200))
            .await
            .unwrap();

        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                path_prefix: Some("/api/v1/admin".to_string()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(total, 1);
        assert_eq!(items[0].path, "/api/v1/admin/logs");
    }

    #[tokio::test]
    async fn test_list_api_logs_filter_by_status_range() {
        let db = Database::new(":memory:").await.unwrap();
        db.insert_api_log(&sample_log("GET", "/a", 200))
            .await
            .unwrap();
        db.insert_api_log(&sample_log("GET", "/b", 404))
            .await
            .unwrap();
        db.insert_api_log(&sample_log("GET", "/c", 500))
            .await
            .unwrap();

        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                status_min: Some(400),
                status_max: Some(499),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(total, 1);
        assert_eq!(items[0].status_code, 404);
    }

    #[tokio::test]
    async fn test_list_api_logs_filter_by_user() {
        let db = Database::new(":memory:").await.unwrap();
        db.insert_api_log(&sample_log("GET", "/a", 200))
            .await
            .unwrap();

        let (_, total) = db
            .list_api_logs(&ApiLogQuery {
                user: Some("user@example.com".to_string()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(total, 1);

        let (_, total) = db
            .list_api_logs(&ApiLogQuery {
                user: Some("nobody@example.com".to_string()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(total, 0);
    }

    #[tokio::test]
    async fn test_list_api_logs_pagination() {
        let db = Database::new(":memory:").await.unwrap();
        for i in 0..5 {
            db.insert_api_log(&sample_log("GET", &format!("/path/{}", i), 200))
                .await
                .unwrap();
        }

        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                limit: 2,
                offset: 0,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(total, 5);
        assert_eq!(items.len(), 2);

        let (items, _) = db
            .list_api_logs(&ApiLogQuery {
                limit: 2,
                offset: 4,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
    }

    #[tokio::test]
    async fn test_get_api_log_stats_empty() {
        let db = Database::new(":memory:").await.unwrap();
        let stats = db.get_api_log_stats().await.unwrap();
        assert_eq!(stats.total_requests, 0);
        assert_eq!(stats.requests_today, 0);
        assert_eq!(stats.error_count, 0);
        assert_eq!(stats.unique_users, 0);
        assert!(stats.top_paths.is_empty());
        assert!(stats.last_cleanup.is_none());
    }

    #[tokio::test]
    async fn test_get_api_log_stats_with_data() {
        let db = Database::new(":memory:").await.unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/stats", 200))
            .await
            .unwrap();
        db.insert_api_log(&sample_log("GET", "/api/v1/stats", 500))
            .await
            .unwrap();
        db.insert_api_log(&sample_log("POST", "/api/v1/reports", 200))
            .await
            .unwrap();

        let stats = db.get_api_log_stats().await.unwrap();
        assert_eq!(stats.total_requests, 3);
        assert_eq!(stats.requests_today, 3);
        assert_eq!(stats.error_count, 1);
        assert_eq!(stats.unique_users, 1);
        assert!(!stats.top_paths.is_empty());
        // /api/v1/stats should be top path with 2 requests
        assert_eq!(stats.top_paths[0].0, "/api/v1/stats");
        assert_eq!(stats.top_paths[0].1, 2);
    }

    #[tokio::test]
    async fn test_cleanup_old_api_logs() {
        let db = Database::new(":memory:").await.unwrap();
        // Insert old logs (2020) and recent logs
        db.insert_api_log(&old_log("GET", "/old")).await.unwrap();
        db.insert_api_log(&old_log("GET", "/old2")).await.unwrap();
        db.insert_api_log(&sample_log("GET", "/recent", 200))
            .await
            .unwrap();

        let deleted = db.cleanup_old_api_logs(7, "test-user").await.unwrap();
        assert_eq!(deleted, 2);

        // Verify only recent log remains
        let (items, total) = db
            .list_api_logs(&ApiLogQuery {
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(items[0].path, "/recent");

        // Verify cleanup history recorded
        let stats = db.get_api_log_stats().await.unwrap();
        assert!(stats.last_cleanup.is_some());
        let cleanup = stats.last_cleanup.unwrap();
        assert_eq!(cleanup.retention_days, 7);
        assert_eq!(cleanup.deleted_count, 2);
        assert_eq!(cleanup.triggered_by, "test-user");
    }

    #[tokio::test]
    async fn test_cleanup_no_old_logs() {
        let db = Database::new(":memory:").await.unwrap();
        db.insert_api_log(&sample_log("GET", "/recent", 200))
            .await
            .unwrap();

        let deleted = db.cleanup_old_api_logs(7, "system").await.unwrap();
        assert_eq!(deleted, 0);
    }

    #[tokio::test]
    async fn test_count_api_logs() {
        let db = Database::new(":memory:").await.unwrap();
        assert_eq!(db.count_api_logs().await.unwrap(), 0);

        db.insert_api_log(&sample_log("GET", "/a", 200))
            .await
            .unwrap();
        db.insert_api_log(&sample_log("POST", "/b", 201))
            .await
            .unwrap();
        assert_eq!(db.count_api_logs().await.unwrap(), 2);
    }

    #[tokio::test]
    async fn test_count_reports() {
        let db = Database::new(":memory:").await.unwrap();
        assert_eq!(db.count_reports("vulnerabilityreport").await.unwrap(), 0);
        assert_eq!(db.count_reports("sbomreport").await.unwrap(), 0);
    }
}
