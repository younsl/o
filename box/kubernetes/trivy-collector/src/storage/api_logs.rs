//! API request logging storage operations

use anyhow::{Context, Result};

use super::Database;
use super::models::{ApiLogEntry, ApiLogQuery, ApiLogStats};

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

        // Top paths
        let mut stmt = conn.prepare(
            "SELECT path, COUNT(*) as cnt FROM api_logs GROUP BY path ORDER BY cnt DESC LIMIT 10",
        )?;
        let top_paths = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(ApiLogStats {
            total_requests,
            requests_today,
            avg_duration_ms,
            error_count,
            unique_users,
            top_paths,
        })
    }

    /// Delete API logs older than retention_days
    pub fn cleanup_old_api_logs(&self, retention_days: u32) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%dT%H:%M:%S").to_string();

        let deleted = conn.execute("DELETE FROM api_logs WHERE created_at < ?1", [&cutoff_str])?;

        Ok(deleted as u64)
    }
}
