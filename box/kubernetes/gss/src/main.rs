mod config;
mod connectivity;
mod logger;
mod models;
mod publisher;
mod reporter;
mod scanner;

use anyhow::{Context, Result};
use config::Config;
use connectivity::ConnectivityChecker;
use octocrab::Octocrab;
use publisher::PublisherFactory;
use scanner::Scanner;
use tracing::{error, info};

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        error!("Application error: {:#}", e);
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    // Load configuration
    let config = Config::load().context("Failed to load configuration")?;

    // Initialize logger
    logger::init_logger(&config.log_level);
    info!("Starting GHES Schedule Scanner");
    info!("Version: {}", env!("CARGO_PKG_VERSION"));

    // Log configuration summary
    info!(
        github_org = %config.github_organization,
        github_base_url = %config.github_base_url,
        log_level = %config.log_level,
        publisher_type = %config.publisher_type,
        request_timeout = config.request_timeout,
        concurrent_scans = config.concurrent_scans,
        connectivity_max_retries = config.connectivity_max_retries,
        connectivity_retry_interval = config.connectivity_retry_interval,
        connectivity_timeout = config.connectivity_timeout,
        "Configuration loaded"
    );

    // Validate configuration
    config
        .validate()
        .context("Configuration validation failed")?;

    // Check connectivity to GitHub Enterprise Server
    info!("Verifying connectivity to GitHub Enterprise Server");
    let connectivity_checker =
        ConnectivityChecker::new(&config).context("Failed to create connectivity checker")?;
    connectivity_checker
        .verify_connectivity()
        .await
        .context("Connectivity verification failed")?;

    // Initialize GitHub client
    let github_client = create_github_client(&config)?;

    // Initialize scanner
    let scanner = Scanner::new(
        github_client,
        config.concurrent_scans,
        config.request_timeout,
    )
    .context("Failed to create scanner")?;

    // Scan for scheduled workflows
    info!("Scanning organization: {}", config.github_organization);
    let scan_result = scanner
        .scan_scheduled_workflows(&config.github_organization)
        .await
        .context("Failed to scan workflows")?;

    info!(
        "Scan completed: found {} scheduled workflows",
        scan_result.workflows.len()
    );

    // Create and use publisher
    let publisher = PublisherFactory::create(&config).context("Failed to create publisher")?;

    info!("Publishing results using {} publisher", publisher.name());
    publisher
        .publish(&scan_result)
        .await
        .context("Failed to publish results")?;

    info!("GHES Schedule Scanner completed successfully");
    Ok(())
}

fn create_github_client(config: &Config) -> Result<Octocrab> {
    let token = config.github_token.clone();

    // Parse the base URL and append /api/v3 for GitHub Enterprise Server
    let base_url = config.github_base_url.trim_end_matches('/');
    let api_url = format!("{}/api/v3", base_url);

    info!("Initializing GitHub client with API URL: {}", api_url);

    // Create octocrab instance with personal token and custom base URL
    let octocrab = Octocrab::builder()
        .personal_token(token)
        .base_uri(&api_url)
        .context("Failed to parse GitHub base URL")?
        .build()
        .context("Failed to build GitHub client")?;

    Ok(octocrab)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_create_github_client() {
        let config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://api.github.com".to_string(),
        );
        let client = create_github_client(&config);
        assert!(client.is_ok());
    }
}
