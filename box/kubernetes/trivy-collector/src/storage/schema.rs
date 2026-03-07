//! Database schema initialization and migrations

use anyhow::{Context, Result};
use rusqlite::Connection;
use tracing::{debug, info};

/// Initialize the database schema
pub fn init_schema(conn: &Connection) -> Result<()> {
    debug!("Initializing database schema");

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
        CREATE INDEX IF NOT EXISTS idx_reports_received_at ON reports(received_at);

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

    // Run migrations
    run_migrations(conn)?;

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

/// Run database migrations for existing databases
fn run_migrations(conn: &Connection) -> Result<()> {
    // Migration: Add notes column if it doesn't exist
    if !column_exists(conn, "notes")? {
        info!("Migrating database: adding notes column");
        conn.execute("ALTER TABLE reports ADD COLUMN notes TEXT DEFAULT ''", [])
            .context("Failed to add notes column")?;
    }

    // Migration: Add notes_created_at column if it doesn't exist
    if !column_exists(conn, "notes_created_at")? {
        info!("Migrating database: adding notes_created_at column");
        conn.execute("ALTER TABLE reports ADD COLUMN notes_created_at TEXT", [])
            .context("Failed to add notes_created_at column")?;
    }

    // Migration: Add notes_updated_at column if it doesn't exist
    if !column_exists(conn, "notes_updated_at")? {
        info!("Migrating database: adding notes_updated_at column");
        conn.execute("ALTER TABLE reports ADD COLUMN notes_updated_at TEXT", [])
            .context("Failed to add notes_updated_at column")?;
    }

    // Migration: Create api_tokens table if it doesn't exist
    if !table_exists_check(conn, "api_tokens")? {
        info!("Migrating database: creating api_tokens table");
        conn.execute_batch(
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
        .context("Failed to create api_tokens table")?;
    }

    // Migration: Add description column to api_tokens if it doesn't exist
    if table_exists_check(conn, "api_tokens")?
        && !column_exists_in(conn, "api_tokens", "description")?
    {
        info!("Migrating database: adding description column to api_tokens");
        conn.execute(
            "ALTER TABLE api_tokens ADD COLUMN description TEXT DEFAULT ''",
            [],
        )
        .context("Failed to add description column to api_tokens")?;
    }

    Ok(())
}

/// Check if a table exists in the database
fn table_exists_check(conn: &Connection, table_name: &str) -> Result<bool> {
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name=?1",
            [table_name],
            |row| row.get(0),
        )
        .unwrap_or(false);
    Ok(exists)
}

/// Check if a column exists in the reports table
fn column_exists(conn: &Connection, column_name: &str) -> Result<bool> {
    column_exists_in(conn, "reports", column_name)
}

/// Check if a column exists in the given table
fn column_exists_in(conn: &Connection, table_name: &str, column_name: &str) -> Result<bool> {
    let query = format!(
        "SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name=?1",
        table_name
    );
    let exists: bool = conn
        .query_row(&query, [column_name], |row| row.get(0))
        .unwrap_or(false);
    Ok(exists)
}
