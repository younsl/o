//! Storage layer for Trivy Collector
//!
//! This module provides SQLite-based persistence for vulnerability and SBOM reports.
//!
//! # Module Structure
//! - `database`: Database connection and lifecycle management
//! - `models`: Data types and structures
//! - `schema`: Database schema initialization and migrations
//! - `operations`: CRUD and query operations
//! - `extractors`: JSON metadata extraction helpers

mod database;
mod extractors;
mod models;
mod operations;
mod schema;

// Re-export public types
pub use database::Database;
pub use models::{ClusterInfo, FullReport, QueryParams, ReportMeta, Stats, VulnSummary};
