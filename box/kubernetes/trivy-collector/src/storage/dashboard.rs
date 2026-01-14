//! Dashboard statistics and trend operations

use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tracing::{debug, info};
use utoipa::ToSchema;

use super::database::Database;

/// Aggregated trend data point
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TrendDataPoint {
    pub date: String,
    pub clusters_count: i64,
    pub vuln_reports: i64,
    pub sbom_reports: i64,
    pub critical: i64,
    pub high: i64,
    pub medium: i64,
    pub low: i64,
    pub unknown: i64,
    pub components: i64,
}

/// Trend response metadata
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TrendMeta {
    pub range_start: String,
    pub range_end: String,
    pub granularity: String,
    pub clusters: Vec<String>,
    /// Earliest date with data (data retention start)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_from: Option<String>,
    /// Latest date with data (data retention end)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_to: Option<String>,
}

/// Full trend response
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TrendResponse {
    pub meta: TrendMeta,
    pub series: Vec<TrendDataPoint>,
}

impl Database {
    /// Capture daily snapshot of current statistics per cluster
    pub fn capture_daily_snapshot(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let now = chrono::Utc::now().to_rfc3339();

        // Insert or replace daily stats for each cluster
        let affected = conn.execute(
            r#"
            INSERT OR REPLACE INTO daily_stats (
                date, cluster, vuln_report_count, sbom_report_count,
                critical_count, high_count, medium_count, low_count, unknown_count,
                components_count, snapshot_at
            )
            SELECT
                ?1 as date,
                cluster,
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN 1 ELSE 0 END) as vuln_report_count,
                SUM(CASE WHEN report_type = 'sbomreport' THEN 1 ELSE 0 END) as sbom_report_count,
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN critical_count ELSE 0 END) as critical_count,
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN high_count ELSE 0 END) as high_count,
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN medium_count ELSE 0 END) as medium_count,
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN low_count ELSE 0 END) as low_count,
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN unknown_count ELSE 0 END) as unknown_count,
                SUM(COALESCE(components_count, 0)) as components_count,
                ?2 as snapshot_at
            FROM reports
            GROUP BY cluster
            "#,
            params![today, now],
        )?;

        info!(date = %today, clusters_updated = affected, "Daily snapshot captured");
        Ok(affected as i64)
    }

    /// Check if today's snapshot exists
    pub fn has_today_snapshot(&self) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM daily_stats WHERE date = ?1",
            params![today],
            |row| row.get(0),
        )?;

        Ok(count > 0)
    }

    /// Get the date range of stored data in daily_stats
    pub fn get_data_range(&self) -> Result<(Option<String>, Option<String>)> {
        let conn = self.conn.lock().unwrap();

        let result: (Option<String>, Option<String>) =
            conn.query_row("SELECT MIN(date), MAX(date) FROM daily_stats", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;

        Ok(result)
    }

    /// Get the date range of stored data from reports table
    pub fn get_reports_data_range(&self) -> Result<(Option<String>, Option<String>)> {
        let conn = self.conn.lock().unwrap();

        let result: (Option<String>, Option<String>) = conn.query_row(
            "SELECT MIN(date(received_at)), MAX(date(received_at)) FROM reports WHERE received_at IS NOT NULL",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        Ok(result)
    }

    /// Get trend data for the specified date range
    pub fn get_trends(
        &self,
        start_date: &str,
        end_date: &str,
        cluster: Option<&str>,
        granularity: &str,
    ) -> Result<TrendResponse> {
        let conn = self.conn.lock().unwrap();

        // Get list of clusters
        let clusters: Vec<String> = if let Some(c) = cluster {
            vec![c.to_string()]
        } else {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT cluster FROM daily_stats WHERE date >= ?1 AND date <= ?2 ORDER BY cluster",
            )?;
            let rows =
                stmt.query_map(params![start_date, end_date], |row| row.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        // Build query based on granularity
        let (date_expr, group_by) = match granularity {
            "weekly" => ("strftime('%Y-W%W', date)", "strftime('%Y-W%W', date)"),
            _ => ("date", "date"), // daily is default
        };

        let mut sql = format!(
            r#"
            SELECT
                {} as period,
                COUNT(DISTINCT cluster) as clusters_count,
                SUM(vuln_report_count) as vuln_reports,
                SUM(sbom_report_count) as sbom_reports,
                SUM(critical_count) as critical,
                SUM(high_count) as high,
                SUM(medium_count) as medium,
                SUM(low_count) as low,
                SUM(unknown_count) as unknown,
                SUM(components_count) as components
            FROM daily_stats
            WHERE date >= ?1 AND date <= ?2
            "#,
            date_expr
        );

        let mut sql_params: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(start_date.to_string()),
            Box::new(end_date.to_string()),
        ];

        if let Some(c) = cluster {
            sql.push_str(" AND cluster = ?3");
            sql_params.push(Box::new(c.to_string()));
        }

        sql.push_str(&format!(" GROUP BY {} ORDER BY {} ASC", group_by, group_by));

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            sql_params.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok(TrendDataPoint {
                date: row.get(0)?,
                clusters_count: row.get(1)?,
                vuln_reports: row.get(2)?,
                sbom_reports: row.get(3)?,
                critical: row.get(4)?,
                high: row.get(5)?,
                medium: row.get(6)?,
                low: row.get(7)?,
                unknown: row.get(8)?,
                components: row.get(9)?,
            })
        })?;

        let series: Vec<TrendDataPoint> = rows.filter_map(|r| r.ok()).collect();

        debug!(
            start = %start_date,
            end = %end_date,
            granularity = %granularity,
            points = series.len(),
            "Trend data retrieved"
        );

        Ok(TrendResponse {
            meta: TrendMeta {
                range_start: start_date.to_string(),
                range_end: end_date.to_string(),
                granularity: granularity.to_string(),
                clusters,
                data_from: None,
                data_to: None,
            },
            series,
        })
    }

    /// Backfill historical data from received_at timestamps
    pub fn backfill_from_received_at(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();

        // Get distinct dates from received_at
        let affected = conn.execute(
            r#"
            INSERT OR IGNORE INTO daily_stats (
                date, cluster, vuln_report_count, sbom_report_count,
                critical_count, high_count, medium_count, low_count, unknown_count,
                components_count, snapshot_at
            )
            SELECT
                date(received_at) as date,
                cluster,
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN 1 ELSE 0 END),
                SUM(CASE WHEN report_type = 'sbomreport' THEN 1 ELSE 0 END),
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN critical_count ELSE 0 END),
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN high_count ELSE 0 END),
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN medium_count ELSE 0 END),
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN low_count ELSE 0 END),
                SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN unknown_count ELSE 0 END),
                SUM(COALESCE(components_count, 0)),
                ?1
            FROM reports
            WHERE received_at IS NOT NULL
            GROUP BY date(received_at), cluster
            "#,
            params![now],
        )?;

        info!(
            rows_inserted = affected,
            "Historical data backfilled from received_at"
        );
        Ok(affected as i64)
    }

    /// Get current live statistics (without daily_stats, directly from reports)
    pub fn get_live_trends(
        &self,
        start_date: &str,
        end_date: &str,
        cluster: Option<&str>,
        granularity: &str,
    ) -> Result<TrendResponse> {
        let conn = self.conn.lock().unwrap();

        // Get list of clusters
        let clusters: Vec<String> = if let Some(c) = cluster {
            vec![c.to_string()]
        } else {
            let mut stmt = conn.prepare("SELECT DISTINCT cluster FROM reports ORDER BY cluster")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        // Generate all time slots (hourly: 24 hours from now, daily: all days in range)
        // For cumulative totals: calculate totals up to each time point
        let (sql, sql_params): (String, Vec<Box<dyn rusqlite::ToSql>>) = if granularity == "hourly"
        {
            // Optimized hourly query using window functions (single table scan)
            // Before: 216 correlated subqueries (24 hours × 9 metrics)
            // After: 1 scan with GROUP BY + window functions for cumulative sums
            let cluster_filter = if cluster.is_some() {
                " AND cluster = ?1"
            } else {
                ""
            };
            let params: Vec<Box<dyn rusqlite::ToSql>> = if let Some(c) = cluster {
                vec![Box::new(c.to_string())]
            } else {
                vec![]
            };
            let sql = format!(
                r#"
                WITH baseline AS (
                    -- Step 1: Calculate totals BEFORE the 24-hour window (baseline)
                    SELECT
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN 1 ELSE 0 END) as vuln,
                        SUM(CASE WHEN report_type = 'sbomreport' THEN 1 ELSE 0 END) as sbom,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN critical_count ELSE 0 END) as critical,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN high_count ELSE 0 END) as high,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN medium_count ELSE 0 END) as medium,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN low_count ELSE 0 END) as low,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN unknown_count ELSE 0 END) as unknown,
                        SUM(COALESCE(components_count, 0)) as components
                    FROM reports
                    WHERE received_at < datetime('now', '-23 hours'){}
                ),
                hourly_agg AS (
                    -- Step 2: Aggregate increments within the 24-hour window
                    -- Use 'localtime' to convert received_at (UTC) to local timezone for grouping
                    SELECT
                        strftime('%Y-%m-%d %H:00', received_at, 'localtime') as hour,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN 1 ELSE 0 END) as vuln,
                        SUM(CASE WHEN report_type = 'sbomreport' THEN 1 ELSE 0 END) as sbom,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN critical_count ELSE 0 END) as critical,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN high_count ELSE 0 END) as high,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN medium_count ELSE 0 END) as medium,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN low_count ELSE 0 END) as low,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN unknown_count ELSE 0 END) as unknown,
                        SUM(COALESCE(components_count, 0)) as components
                    FROM reports
                    WHERE received_at >= datetime('now', '-23 hours'){}
                    GROUP BY strftime('%Y-%m-%d %H:00', received_at, 'localtime')
                ),
                all_hours AS (
                    -- Step 3: Generate 24 hourly slots using RECURSIVE CTE
                    -- Use 'localtime' to match user's timezone
                    SELECT strftime('%Y-%m-%d %H:00:00', datetime('now', 'localtime', '-23 hours')) as hour
                    UNION ALL
                    SELECT strftime('%Y-%m-%d %H:00:00', datetime(hour, '+1 hour'))
                    FROM all_hours
                    WHERE hour < strftime('%Y-%m-%d %H:00:00', datetime('now', 'localtime'))
                )
                -- Step 4: cumulative values for each hour
                SELECT
                    strftime('%Y-%m-%d %H:00', h.hour) as period,
                    -- Clusters: distinct count up to each hour (subquery for accurate cumulative)
                    -- Use 'localtime' to convert received_at (UTC) to local timezone
                    (SELECT COUNT(DISTINCT cluster) FROM reports WHERE strftime('%Y-%m-%d %H:00', received_at, 'localtime') <= strftime('%Y-%m-%d %H:00', h.hour){}) as clusters_count,
                    COALESCE((SELECT vuln FROM baseline), 0) + SUM(COALESCE(a.vuln, 0)) OVER (ORDER BY h.hour) as vuln_reports,
                    COALESCE((SELECT sbom FROM baseline), 0) + SUM(COALESCE(a.sbom, 0)) OVER (ORDER BY h.hour) as sbom_reports,
                    COALESCE((SELECT critical FROM baseline), 0) + SUM(COALESCE(a.critical, 0)) OVER (ORDER BY h.hour) as critical,
                    COALESCE((SELECT high FROM baseline), 0) + SUM(COALESCE(a.high, 0)) OVER (ORDER BY h.hour) as high,
                    COALESCE((SELECT medium FROM baseline), 0) + SUM(COALESCE(a.medium, 0)) OVER (ORDER BY h.hour) as medium,
                    COALESCE((SELECT low FROM baseline), 0) + SUM(COALESCE(a.low, 0)) OVER (ORDER BY h.hour) as low,
                    COALESCE((SELECT unknown FROM baseline), 0) + SUM(COALESCE(a.unknown, 0)) OVER (ORDER BY h.hour) as unknown,
                    COALESCE((SELECT components FROM baseline), 0) + SUM(COALESCE(a.components, 0)) OVER (ORDER BY h.hour) as components
                FROM all_hours h
                LEFT JOIN hourly_agg a ON strftime('%Y-%m-%d %H:00', h.hour) = a.hour
                ORDER BY h.hour ASC
                "#,
                cluster_filter, cluster_filter, cluster_filter
            );
            (sql, params)
        } else {
            // Daily: uses date parameters
            // Optimized query using window functions (single table scan)
            // Before: 270 correlated subqueries (30 days × 9 metrics)
            // After: 1 scan with GROUP BY + window functions for cumulative sums
            let cluster_filter = if cluster.is_some() {
                " AND cluster = ?3"
            } else {
                ""
            };
            let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new(start_date.to_string()),
                Box::new(end_date.to_string()),
            ];
            if let Some(c) = cluster {
                params.push(Box::new(c.to_string()));
            }
            let sql = format!(
                r#"
                WITH baseline AS (
                    -- Step 1: Calculate totals BEFORE the date range (baseline)
                    SELECT
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN 1 ELSE 0 END) as vuln,
                        SUM(CASE WHEN report_type = 'sbomreport' THEN 1 ELSE 0 END) as sbom,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN critical_count ELSE 0 END) as critical,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN high_count ELSE 0 END) as high,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN medium_count ELSE 0 END) as medium,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN low_count ELSE 0 END) as low,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN unknown_count ELSE 0 END) as unknown,
                        SUM(COALESCE(components_count, 0)) as components
                    FROM reports
                    WHERE date(received_at, 'localtime') < date(?1){}
                ),
                daily_agg AS (
                    -- Step 2: Aggregate increments within the date range
                    SELECT
                        date(received_at, 'localtime') as day,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN 1 ELSE 0 END) as vuln,
                        SUM(CASE WHEN report_type = 'sbomreport' THEN 1 ELSE 0 END) as sbom,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN critical_count ELSE 0 END) as critical,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN high_count ELSE 0 END) as high,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN medium_count ELSE 0 END) as medium,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN low_count ELSE 0 END) as low,
                        SUM(CASE WHEN report_type = 'vulnerabilityreport' THEN unknown_count ELSE 0 END) as unknown,
                        SUM(COALESCE(components_count, 0)) as components
                    FROM reports
                    WHERE date(received_at, 'localtime') >= date(?1)
                      AND date(received_at, 'localtime') <= date(?2){}
                    GROUP BY date(received_at, 'localtime')
                ),
                all_days AS (
                    -- Step 3: Generate all date slots using RECURSIVE CTE
                    SELECT date(?1) as day
                    UNION ALL
                    SELECT date(day, '+1 day')
                    FROM all_days
                    WHERE day < date(?2)
                )
                -- Step 4: cumulative values for each day
                SELECT
                    d.day as period,
                    -- Clusters: distinct count up to each day (subquery for accurate cumulative)
                    (SELECT COUNT(DISTINCT cluster) FROM reports WHERE date(received_at, 'localtime') <= d.day{}) as clusters_count,
                    COALESCE((SELECT vuln FROM baseline), 0) + SUM(COALESCE(a.vuln, 0)) OVER (ORDER BY d.day) as vuln_reports,
                    COALESCE((SELECT sbom FROM baseline), 0) + SUM(COALESCE(a.sbom, 0)) OVER (ORDER BY d.day) as sbom_reports,
                    COALESCE((SELECT critical FROM baseline), 0) + SUM(COALESCE(a.critical, 0)) OVER (ORDER BY d.day) as critical,
                    COALESCE((SELECT high FROM baseline), 0) + SUM(COALESCE(a.high, 0)) OVER (ORDER BY d.day) as high,
                    COALESCE((SELECT medium FROM baseline), 0) + SUM(COALESCE(a.medium, 0)) OVER (ORDER BY d.day) as medium,
                    COALESCE((SELECT low FROM baseline), 0) + SUM(COALESCE(a.low, 0)) OVER (ORDER BY d.day) as low,
                    COALESCE((SELECT unknown FROM baseline), 0) + SUM(COALESCE(a.unknown, 0)) OVER (ORDER BY d.day) as unknown,
                    COALESCE((SELECT components FROM baseline), 0) + SUM(COALESCE(a.components, 0)) OVER (ORDER BY d.day) as components
                FROM all_days d
                LEFT JOIN daily_agg a ON d.day = a.day
                ORDER BY d.day ASC
                "#,
                cluster_filter,
                cluster_filter,
                cluster_filter
            );
            (sql, params)
        };

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            sql_params.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok(TrendDataPoint {
                date: row.get(0)?,
                clusters_count: row.get(1)?,
                vuln_reports: row.get(2)?,
                sbom_reports: row.get(3)?,
                critical: row.get(4)?,
                high: row.get(5)?,
                medium: row.get(6)?,
                low: row.get(7)?,
                unknown: row.get(8)?,
                components: row.get(9)?,
            })
        })?;

        let series: Vec<TrendDataPoint> = rows.filter_map(|r| r.ok()).collect();

        Ok(TrendResponse {
            meta: TrendMeta {
                range_start: start_date.to_string(),
                range_end: end_date.to_string(),
                granularity: granularity.to_string(),
                clusters,
                data_from: None,
                data_to: None,
            },
            series,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::types::ReportPayload;
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
            data: json!({
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
            }),
            received_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn test_capture_daily_snapshot() {
        let db = Database::new(":memory:").expect("Failed to create database");

        // Insert test reports
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
            "default",
            "app3",
            "sbomreport",
        ))
        .unwrap();

        // Capture snapshot
        let count = db
            .capture_daily_snapshot()
            .expect("Failed to capture snapshot");
        assert!(count >= 2); // At least 2 clusters

        // Verify snapshot exists
        assert!(db.has_today_snapshot().unwrap());
    }

    #[test]
    fn test_get_trends_empty() {
        let db = Database::new(":memory:").expect("Failed to create database");

        let trends = db
            .get_trends("2025-01-01", "2025-01-31", None, "daily")
            .expect("Failed to get trends");

        assert!(trends.series.is_empty());
        assert!(trends.meta.clusters.is_empty());
    }

    #[test]
    fn test_get_live_trends() {
        let db = Database::new(":memory:").expect("Failed to create database");

        // Insert test reports
        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .unwrap();

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let trends = db
            .get_live_trends(&today, &today, None, "daily")
            .expect("Failed to get live trends");

        // Should have at least one data point for today
        assert!(!trends.series.is_empty() || trends.meta.clusters.contains(&"prod".to_string()));
    }

    #[test]
    fn test_get_live_trends_hourly() {
        let db = Database::new(":memory:").expect("Failed to create database");

        // Insert test reports
        db.upsert_report(&create_test_payload(
            "prod",
            "default",
            "app1",
            "vulnerabilityreport",
        ))
        .unwrap();

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let trends = db
            .get_live_trends(&today, &today, None, "hourly")
            .expect("Failed to get live trends (hourly)");

        // Should have hourly granularity
        assert_eq!(trends.meta.granularity, "hourly");
    }
}
