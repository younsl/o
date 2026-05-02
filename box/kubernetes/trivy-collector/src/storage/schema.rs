//! Database schema initialization and migrations

use anyhow::{Context, Result};
use sqlx::SqlitePool;
use tracing::{debug, info};

/// Initialize the database schema
pub async fn init_schema(pool: &SqlitePool) -> Result<()> {
    debug!("Initializing database schema");

    // Check if reports table exists (to determine if this is a fresh DB)
    let (table_exists,): (bool,) = sqlx::query_as(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='reports'",
    )
    .fetch_one(pool)
    .await
    .unwrap_or((false,));

    if table_exists {
        debug!("Reports table already exists, checking schema");
    } else {
        info!("Creating new database schema");
    }

    sqlx::raw_sql(
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
        CREATE INDEX IF NOT EXISTS idx_reports_received_at ON reports(received_at);
        -- Composite index that serves the clusters_view aggregation
        -- (GROUP BY cluster with SUM per report_type and MAX(updated_at)).
        -- On a ~300 MB DB a scan-based aggregation can take tens of seconds;
        -- this index lets SQLite answer the whole view from the index alone.
        CREATE INDEX IF NOT EXISTS idx_reports_cluster_type_updated
            ON reports(cluster, report_type, updated_at);
        -- Serves "list newest reports of a given type" (ReportsPage):
        --   SELECT ... WHERE report_type = ? ORDER BY updated_at DESC LIMIT ?
        -- ORDER BY DESC is covered — SQLite walks the index in reverse.
        CREATE INDEX IF NOT EXISTS idx_reports_type_updated
            ON reports(report_type, updated_at);

        -- API tokens table
        CREATE TABLE IF NOT EXISTS api_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_sub TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            token_hash TEXT NOT NULL,
            token_prefix TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            last_used_at TEXT,
            UNIQUE(user_sub, name)
        );
        CREATE INDEX IF NOT EXISTS idx_api_tokens_user_sub ON api_tokens(user_sub);
        CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

        -- API logs table
        CREATE TABLE IF NOT EXISTS api_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            method TEXT NOT NULL,
            path TEXT NOT NULL,
            status_code INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            user_sub TEXT DEFAULT '',
            user_email TEXT DEFAULT '',
            remote_addr TEXT DEFAULT '',
            user_agent TEXT DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_api_logs_path ON api_logs(path);
        CREATE INDEX IF NOT EXISTS idx_api_logs_status_code ON api_logs(status_code);

        -- Cleanup history table
        CREATE TABLE IF NOT EXISTS cleanup_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            retention_days INTEGER NOT NULL,
            deleted_count INTEGER NOT NULL,
            triggered_by TEXT NOT NULL DEFAULT 'system',
            cleaned_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cleanup_history_cleaned_at ON cleanup_history(cleaned_at);

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
    .execute(pool)
    .await
    .context("Failed to initialize database schema")?;

    // Run migrations
    run_migrations(pool).await?;

    // Log schema details
    let (index_count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name='reports'",
    )
    .fetch_one(pool)
    .await
    .unwrap_or((0,));

    debug!(
        table = "reports",
        indexes = index_count,
        view = "clusters_view",
        "Database schema initialized"
    );

    Ok(())
}

/// Run database migrations for existing databases
async fn run_migrations(pool: &SqlitePool) -> Result<()> {
    // Migration: Add notes column if it doesn't exist
    if !column_exists(pool, "reports", "notes").await? {
        info!("Migrating database: adding notes column");
        sqlx::query("ALTER TABLE reports ADD COLUMN notes TEXT DEFAULT ''")
            .execute(pool)
            .await
            .context("Failed to add notes column")?;
    }

    // Migration: Add notes_created_at column if it doesn't exist
    if !column_exists(pool, "reports", "notes_created_at").await? {
        info!("Migrating database: adding notes_created_at column");
        sqlx::query("ALTER TABLE reports ADD COLUMN notes_created_at TEXT")
            .execute(pool)
            .await
            .context("Failed to add notes_created_at column")?;
    }

    // Migration: Add notes_updated_at column if it doesn't exist
    if !column_exists(pool, "reports", "notes_updated_at").await? {
        info!("Migrating database: adding notes_updated_at column");
        sqlx::query("ALTER TABLE reports ADD COLUMN notes_updated_at TEXT")
            .execute(pool)
            .await
            .context("Failed to add notes_updated_at column")?;
    }

    // Migration: Create api_tokens table if it doesn't exist
    if !table_exists_check(pool, "api_tokens").await? {
        info!("Migrating database: creating api_tokens table");
        sqlx::raw_sql(
            r#"
            CREATE TABLE IF NOT EXISTS api_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_sub TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                token_hash TEXT NOT NULL,
                token_prefix TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                last_used_at TEXT,
                UNIQUE(user_sub, name)
            );
            CREATE INDEX IF NOT EXISTS idx_api_tokens_user_sub ON api_tokens(user_sub);
            CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
            "#,
        )
        .execute(pool)
        .await
        .context("Failed to create api_tokens table")?;
    }

    // Migration: Add description column to api_tokens if it doesn't exist
    if table_exists_check(pool, "api_tokens").await?
        && !column_exists(pool, "api_tokens", "description").await?
    {
        info!("Migrating database: adding description column to api_tokens");
        sqlx::query("ALTER TABLE api_tokens ADD COLUMN description TEXT DEFAULT ''")
            .execute(pool)
            .await
            .context("Failed to add description column to api_tokens")?;
    }

    // Migration: Create cleanup_history table if it doesn't exist
    if !table_exists_check(pool, "cleanup_history").await? {
        info!("Migrating database: creating cleanup_history table");
        sqlx::raw_sql(
            r#"
            CREATE TABLE IF NOT EXISTS cleanup_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                retention_days INTEGER NOT NULL,
                deleted_count INTEGER NOT NULL,
                triggered_by TEXT NOT NULL DEFAULT 'system',
                cleaned_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cleanup_history_cleaned_at ON cleanup_history(cleaned_at);
            "#,
        )
        .execute(pool)
        .await
        .context("Failed to create cleanup_history table")?;
    }

    // Migration: Add composite indexes that dramatically speed up the
    // clusters_view aggregation and "recent reports of type X" query. These
    // are IF NOT EXISTS so the migration is safe to run repeatedly, and we
    // follow up with ANALYZE so SQLite's query planner actually picks them.
    if !index_exists(pool, "idx_reports_cluster_type_updated").await?
        || !index_exists(pool, "idx_reports_type_updated").await?
    {
        info!("Migrating database: adding composite indexes on reports");
        sqlx::raw_sql(
            r#"
            CREATE INDEX IF NOT EXISTS idx_reports_cluster_type_updated
                ON reports(cluster, report_type, updated_at);
            CREATE INDEX IF NOT EXISTS idx_reports_type_updated
                ON reports(report_type, updated_at);
            ANALYZE reports;
            "#,
        )
        .execute(pool)
        .await
        .context("Failed to add composite indexes on reports")?;
    }

    // Migration: Create api_logs table if it doesn't exist
    if !table_exists_check(pool, "api_logs").await? {
        info!("Migrating database: creating api_logs table");
        sqlx::raw_sql(
            r#"
            CREATE TABLE IF NOT EXISTS api_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                status_code INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL,
                user_sub TEXT DEFAULT '',
                user_email TEXT DEFAULT '',
                remote_addr TEXT DEFAULT '',
                user_agent TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_logs(created_at);
            CREATE INDEX IF NOT EXISTS idx_api_logs_path ON api_logs(path);
            CREATE INDEX IF NOT EXISTS idx_api_logs_status_code ON api_logs(status_code);
            "#,
        )
        .execute(pool)
        .await
        .context("Failed to create api_logs table")?;
    }

    Ok(())
}

/// Check if a table exists in the database
async fn table_exists_check(pool: &SqlitePool, table_name: &str) -> Result<bool> {
    let (exists,): (bool,) =
        sqlx::query_as("SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name=$1")
            .bind(table_name)
            .fetch_one(pool)
            .await
            .unwrap_or((false,));
    Ok(exists)
}

/// Check if an index exists in the database.
async fn index_exists(pool: &SqlitePool, index_name: &str) -> Result<bool> {
    let (exists,): (bool,) =
        sqlx::query_as("SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='index' AND name=$1")
            .bind(index_name)
            .fetch_one(pool)
            .await
            .unwrap_or((false,));
    Ok(exists)
}

/// Check if a column exists in the given table
async fn column_exists(pool: &SqlitePool, table_name: &str, column_name: &str) -> Result<bool> {
    let query = format!(
        "SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name=$1",
        table_name
    );
    let (exists,): (bool,) = sqlx::query_as(&query)
        .bind(column_name)
        .fetch_one(pool)
        .await
        .unwrap_or((false,));
    Ok(exists)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn test_init_schema_fresh_db() {
        let pool = test_pool().await;
        init_schema(&pool).await.unwrap();

        // Verify tables exist
        assert!(table_exists_check(&pool, "reports").await.unwrap());
        assert!(table_exists_check(&pool, "api_tokens").await.unwrap());
        assert!(table_exists_check(&pool, "api_logs").await.unwrap());
        assert!(table_exists_check(&pool, "cleanup_history").await.unwrap());
    }

    #[tokio::test]
    async fn test_init_schema_idempotent() {
        let pool = test_pool().await;
        init_schema(&pool).await.unwrap();
        // Running again should not fail
        init_schema(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn test_table_exists_check() {
        let pool = test_pool().await;
        assert!(!table_exists_check(&pool, "reports").await.unwrap());
        init_schema(&pool).await.unwrap();
        assert!(table_exists_check(&pool, "reports").await.unwrap());
        assert!(!table_exists_check(&pool, "nonexistent").await.unwrap());
    }

    #[tokio::test]
    async fn test_column_exists() {
        let pool = test_pool().await;
        init_schema(&pool).await.unwrap();
        assert!(column_exists(&pool, "reports", "notes").await.unwrap());
        assert!(
            column_exists(&pool, "reports", "notes_created_at")
                .await
                .unwrap()
        );
        assert!(
            column_exists(&pool, "reports", "notes_updated_at")
                .await
                .unwrap()
        );
        assert!(
            !column_exists(&pool, "reports", "nonexistent_col")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn test_column_exists_in() {
        let pool = test_pool().await;
        init_schema(&pool).await.unwrap();
        assert!(
            column_exists(&pool, "api_tokens", "description")
                .await
                .unwrap()
        );
        assert!(
            column_exists(&pool, "api_tokens", "user_sub")
                .await
                .unwrap()
        );
        assert!(
            !column_exists(&pool, "api_tokens", "nonexistent")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn test_migrations_on_existing_db() {
        let pool = test_pool().await;
        // Create only the reports table (simulating old schema without notes)
        sqlx::raw_sql(
            r#"
            CREATE TABLE reports (
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
                UNIQUE(cluster, namespace, name, report_type)
            );
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        // Run migrations should add missing columns and tables
        run_migrations(&pool).await.unwrap();

        // Verify migrations applied
        assert!(column_exists(&pool, "reports", "notes").await.unwrap());
        assert!(
            column_exists(&pool, "reports", "notes_created_at")
                .await
                .unwrap()
        );
        assert!(
            column_exists(&pool, "reports", "notes_updated_at")
                .await
                .unwrap()
        );
        assert!(table_exists_check(&pool, "api_tokens").await.unwrap());
        assert!(table_exists_check(&pool, "api_logs").await.unwrap());
        assert!(table_exists_check(&pool, "cleanup_history").await.unwrap());
        assert!(
            column_exists(&pool, "api_tokens", "description")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn test_indexes_created() {
        let pool = test_pool().await;
        init_schema(&pool).await.unwrap();

        let (index_count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE type='index'")
                .fetch_one(&pool)
                .await
                .unwrap();
        // Should have at least the report indexes
        assert!(index_count > 0);
    }
}
