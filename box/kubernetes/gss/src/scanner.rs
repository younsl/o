use crate::models::{ScanResult, WorkflowFile, WorkflowInfo};
use anyhow::{Context, Result};
use chrono::Utc;
use octocrab::Octocrab;
use octocrab::models::{Repository, workflows::WorkFlow};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Semaphore;
use tracing::{debug, info, warn};

const EXCLUDE_REPOS_PATH: &str = "/etc/gss/exclude-repos.txt";

pub struct Scanner {
    client: Arc<Octocrab>,
    concurrent_scans: usize,
    request_timeout: u64,
    excluded_repos: HashSet<String>,
}

impl Scanner {
    pub fn new(client: Octocrab, concurrent_scans: usize, request_timeout: u64) -> Result<Self> {
        let excluded_repos = Self::load_excluded_repos()?;
        info!("Loaded {} excluded repositories", excluded_repos.len());
        info!("Request timeout set to {} seconds", request_timeout);

        Ok(Self {
            client: Arc::new(client),
            concurrent_scans,
            request_timeout,
            excluded_repos,
        })
    }

    fn load_excluded_repos() -> Result<HashSet<String>> {
        let path = Path::new(EXCLUDE_REPOS_PATH);
        if !path.exists() {
            debug!("Exclude repos file not found at {}", EXCLUDE_REPOS_PATH);
            return Ok(HashSet::new());
        }

        let content = fs::read_to_string(path).with_context(|| {
            format!("Failed to read exclude repos file: {}", EXCLUDE_REPOS_PATH)
        })?;

        let repos: HashSet<String> = content
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| line.to_string())
            .collect();

        Ok(repos)
    }

    pub async fn scan_scheduled_workflows(&self, org: &str) -> Result<ScanResult> {
        let start_time = Utc::now();
        info!("Starting scan for organization: {}", org);

        let repos = self.list_all_repos(org).await?;
        let total_repos = repos.len();
        info!("Found {} repositories to scan", total_repos);

        // Filter excluded repos
        let repos_to_scan: Vec<_> = repos
            .into_iter()
            .filter(|repo| !self.excluded_repos.contains(&repo.name))
            .collect();

        let excluded_count = total_repos - repos_to_scan.len();
        info!(
            "Scanning {} repositories (excluded: {})",
            repos_to_scan.len(),
            excluded_count
        );

        // Scan repositories concurrently
        let workflows = self.scan_repos_concurrently(org, repos_to_scan).await?;

        let scan_duration = Utc::now() - start_time;
        let result = ScanResult {
            workflows,
            total_repos,
            excluded_repos_count: excluded_count,
            scan_duration: chrono::Duration::from_std(scan_duration.to_std()?)?,
            max_concurrent_scans: self.concurrent_scans,
        };

        info!(
            "Scan completed: found {} scheduled workflows in {:?}",
            result.workflows.len(),
            scan_duration
        );

        Ok(result)
    }

    async fn list_all_repos(&self, org: &str) -> Result<Vec<Repository>> {
        let mut all_repos = Vec::new();
        let mut page = 1u32;

        loop {
            debug!("Fetching repositories page {} for org: {}", page, org);

            let repos = match tokio::time::timeout(
                std::time::Duration::from_secs(self.request_timeout),
                self.client
                    .orgs(org)
                    .list_repos()
                    .per_page(100)
                    .page(page)
                    .send(),
            )
            .await
            {
                Ok(Ok(repos)) => {
                    debug!(
                        "Successfully fetched {} repositories on page {}",
                        repos.items.len(),
                        page
                    );
                    repos
                }
                Ok(Err(e)) => {
                    return Err(anyhow::anyhow!(
                        "Failed to list repositories on page {}: {}. This may be caused by: \
                        1) Invalid or expired GitHub token \
                        2) Insufficient token permissions (needs 'repo' or 'read:org' scope) \
                        3) Organization '{}' not found \
                        4) Network connectivity issues. \
                        Original error: {}",
                        page,
                        e,
                        org,
                        e
                    ));
                }
                Err(_) => {
                    return Err(anyhow::anyhow!(
                        "Timeout listing repositories on page {} (timeout: {}s)",
                        page,
                        self.request_timeout
                    ));
                }
            };

            if repos.items.is_empty() {
                break;
            }

            all_repos.extend(repos.items);
            page += 1;
        }

        info!("Successfully listed all {} repositories", all_repos.len());
        Ok(all_repos)
    }

    async fn scan_repos_concurrently(
        &self,
        org: &str,
        repos: Vec<Repository>,
    ) -> Result<Vec<WorkflowInfo>> {
        let semaphore = Arc::new(Semaphore::new(self.concurrent_scans));
        let active_scans = Arc::new(AtomicUsize::new(0));
        let max_concurrent = Arc::new(AtomicUsize::new(0));
        let timeout_secs = self.request_timeout;

        let mut tasks = Vec::new();

        for repo in repos {
            let semaphore = Arc::clone(&semaphore);
            let active = Arc::clone(&active_scans);
            let max_conc = Arc::clone(&max_concurrent);
            let client = Arc::clone(&self.client);
            let org = org.to_string();

            let task = tokio::spawn(async move {
                let _permit = semaphore.acquire().await.unwrap();

                // Track concurrent scans
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                max_conc.fetch_max(current, Ordering::SeqCst);

                let result = Self::scan_repository(client, &org, &repo, timeout_secs).await;

                active.fetch_sub(1, Ordering::SeqCst);
                result
            });

            tasks.push(task);
        }

        let mut all_workflows = Vec::new();
        for task in tasks {
            match task.await {
                Ok(Ok(mut workflows)) => all_workflows.append(&mut workflows),
                Ok(Err(e)) => warn!("Repository scan failed: {}", e),
                Err(e) => warn!("Task join error: {}", e),
            }
        }

        Ok(all_workflows)
    }

    async fn scan_repository(
        client: Arc<Octocrab>,
        org: &str,
        repo: &Repository,
        timeout_secs: u64,
    ) -> Result<Vec<WorkflowInfo>> {
        let repo_name = &repo.name;
        debug!("Scanning repository: {}", repo_name);

        let mut workflows_with_schedule = Vec::new();

        // List all workflows with timeout
        let workflows = match tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            client.workflows(org, repo_name).list().per_page(100).send(),
        )
        .await
        {
            Ok(Ok(w)) => w.items,
            Ok(Err(e)) => {
                debug!("Failed to list workflows for {}: {}", repo_name, e);
                return Ok(Vec::new());
            }
            Err(_) => {
                warn!("Timeout listing workflows for {}", repo_name);
                return Ok(Vec::new());
            }
        };

        for workflow in workflows {
            if let Some(schedules) =
                Self::check_workflow_schedule(&client, org, repo_name, &workflow, timeout_secs)
                    .await?
            {
                if schedules.is_empty() {
                    continue;
                }

                let mut workflow_info = WorkflowInfo::new(
                    repo_name.to_string(),
                    workflow.name.clone(),
                    workflow.id.0 as i64,
                    workflow.path.clone(),
                );

                workflow_info.cron_schedules = schedules;

                // Get last workflow run status with timeout
                if let Ok(last_status) = Self::get_last_run_status(
                    &client,
                    org,
                    repo_name,
                    workflow.id.0 as i64,
                    timeout_secs,
                )
                .await
                {
                    workflow_info.last_status = last_status;
                }

                // Get last committer info with timeout
                if let Ok((committer, is_active)) =
                    Self::get_last_committer(&client, org, repo_name, &workflow.path, timeout_secs)
                        .await
                {
                    workflow_info.workflow_last_author = committer;
                    workflow_info.is_active_user = is_active;
                }

                workflows_with_schedule.push(workflow_info);
            }
        }

        Ok(workflows_with_schedule)
    }

    async fn check_workflow_schedule(
        client: &Arc<Octocrab>,
        org: &str,
        repo: &str,
        workflow: &WorkFlow,
        timeout_secs: u64,
    ) -> Result<Option<Vec<String>>> {
        // Get workflow file content with timeout
        let content = match tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            client
                .repos(org, repo)
                .get_content()
                .path(&workflow.path)
                .send(),
        )
        .await
        {
            Ok(Ok(content)) => content,
            Ok(Err(e)) => {
                debug!("Failed to get workflow file {}: {}", workflow.path, e);
                return Ok(None);
            }
            Err(_) => {
                debug!("Timeout getting workflow file {}", workflow.path);
                return Ok(None);
            }
        };

        let file_content = match content.items.first() {
            Some(item) => match &item.content {
                Some(c) => c,
                None => return Ok(None),
            },
            None => return Ok(None),
        };

        // Decode base64 content
        use base64::Engine;
        use base64::engine::general_purpose::STANDARD;
        let decoded = match STANDARD.decode(file_content.replace('\n', "")) {
            Ok(d) => d,
            Err(e) => {
                debug!("Failed to decode workflow file content: {}", e);
                return Ok(None);
            }
        };

        let yaml_content = String::from_utf8_lossy(&decoded);

        // Parse YAML and extract schedules
        let workflow_file: WorkflowFile = match serde_yaml::from_str(&yaml_content) {
            Ok(wf) => wf,
            Err(e) => {
                debug!("Failed to parse workflow YAML: {}", e);
                return Ok(None);
            }
        };

        let schedules = workflow_file
            .on
            .and_then(|on| on.schedule)
            .map(|schedules| schedules.iter().map(|s| s.cron.clone()).collect());

        Ok(schedules)
    }

    async fn get_last_run_status(
        client: &Arc<Octocrab>,
        org: &str,
        repo: &str,
        workflow_id: i64,
        timeout_secs: u64,
    ) -> Result<String> {
        let runs = tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            client
                .workflows(org, repo)
                .list_runs(workflow_id.to_string())
                .per_page(1)
                .send(),
        )
        .await
        .context("Timeout getting workflow runs")?
        .context("Failed to get workflow runs")?;

        let status = runs
            .items
            .first()
            .and_then(|run| run.conclusion.as_ref())
            .map(|c| c.to_string())
            .unwrap_or_else(|| "never_run".to_string());

        Ok(status)
    }

    async fn get_last_committer(
        client: &Arc<Octocrab>,
        org: &str,
        repo: &str,
        workflow_path: &str,
        timeout_secs: u64,
    ) -> Result<(String, bool)> {
        let commits = tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            client
                .repos(org, repo)
                .list_commits()
                .path(workflow_path)
                .per_page(1)
                .send(),
        )
        .await
        .context("Timeout getting commits")?
        .context("Failed to get commits")?;

        let last_commit = commits.items.first().context("No commits found")?;

        // Use author.login (GitHub username) instead of committer.name
        let author_login = last_commit
            .author
            .as_ref()
            .map(|a| a.login.clone())
            .unwrap_or_else(|| "Unknown".to_string());

        // Try to determine if user is active by checking if we can fetch their profile
        let is_active = if let Some(author) = &last_commit.author {
            tokio::time::timeout(
                std::time::Duration::from_secs(timeout_secs),
                client.users(&author.login).profile(),
            )
            .await
            .is_ok_and(|r| r.is_ok())
        } else {
            false
        };

        Ok((author_login, is_active))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_excluded_repos_missing_file() {
        // This will pass when the file doesn't exist
        let result = Scanner::load_excluded_repos();
        assert!(result.is_ok());
    }

    #[test]
    fn test_workflow_yaml_parsing_with_schedule() {
        let yaml = r#"
on:
  schedule:
    - cron: "0 9 * * *"
    - cron: "0 18 * * 1-5"
"#;

        let workflow: WorkflowFile = serde_yaml::from_str(yaml).unwrap();
        let schedules = workflow.on.unwrap().schedule.unwrap();
        assert_eq!(schedules.len(), 2);
        assert_eq!(schedules[0].cron, "0 9 * * *");
    }

    #[test]
    fn test_workflow_yaml_parsing_without_schedule() {
        let yaml = r#"
on:
  push:
    branches:
      - main
"#;

        let workflow: WorkflowFile = serde_yaml::from_str(yaml).unwrap();
        assert!(workflow.on.unwrap().schedule.is_none());
    }
}
