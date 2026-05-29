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
    use base64::Engine;
    use wiremock::matchers::{method, path, path_regex, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

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

    #[test]
    fn test_workflow_yaml_parsing_empty_on() {
        let yaml = "name: Test\n";
        let workflow: WorkflowFile = serde_yaml::from_str(yaml).unwrap();
        assert!(workflow.on.is_none());
    }

    #[test]
    fn test_workflow_yaml_parsing_empty_schedule() {
        let yaml = r#"
on:
  schedule: []
"#;
        let workflow: WorkflowFile = serde_yaml::from_str(yaml).unwrap();
        let schedules = workflow.on.unwrap().schedule.unwrap();
        assert!(schedules.is_empty());
    }

    fn mock_author_json(base_url: &str) -> serde_json::Value {
        serde_json::json!({
            "login": "test-user",
            "id": 1,
            "node_id": "U_1",
            "avatar_url": format!("{}/avatars/1", base_url),
            "gravatar_id": "",
            "url": format!("{}/users/test-user", base_url),
            "html_url": format!("{}/test-user", base_url),
            "followers_url": format!("{}/users/test-user/followers", base_url),
            "following_url": format!("{}/users/test-user/following", base_url),
            "gists_url": format!("{}/users/test-user/gists", base_url),
            "starred_url": format!("{}/users/test-user/starred", base_url),
            "subscriptions_url": format!("{}/users/test-user/subscriptions", base_url),
            "organizations_url": format!("{}/users/test-user/orgs", base_url),
            "repos_url": format!("{}/users/test-user/repos", base_url),
            "events_url": format!("{}/users/test-user/events", base_url),
            "received_events_url": format!("{}/users/test-user/received_events", base_url),
            "type": "User",
            "site_admin": false
        })
    }

    #[tokio::test]
    async fn test_scan_empty_repos() {
        let mock_server = MockServer::start().await;
        let base_url = mock_server.uri();

        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&mock_server)
            .await;

        let octocrab = Octocrab::builder()
            .personal_token("test-token".to_string())
            .base_uri(&base_url)
            .unwrap()
            .build()
            .unwrap();

        let scanner = Scanner::new(octocrab, 5, 30).unwrap();
        let result = scanner.scan_scheduled_workflows("test-org").await.unwrap();

        assert_eq!(result.workflows.len(), 0);
        assert_eq!(result.total_repos, 0);
        assert_eq!(result.excluded_repos_count, 0);
        assert_eq!(result.max_concurrent_scans, 5);
    }

    #[tokio::test]
    async fn test_scan_repo_with_no_workflows() {
        let mock_server = MockServer::start().await;
        let base_url = mock_server.uri();

        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {
                    "id": 1,
                    "name": "test-repo",
                    "url": format!("{}/repos/test-org/test-repo", base_url)
                }
            ])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .and(query_param("page", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/repos/test-org/test-repo/actions/workflows"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "total_count": 0,
                "workflows": []
            })))
            .mount(&mock_server)
            .await;

        let octocrab = Octocrab::builder()
            .personal_token("test-token".to_string())
            .base_uri(&base_url)
            .unwrap()
            .build()
            .unwrap();

        let scanner = Scanner::new(octocrab, 5, 30).unwrap();
        let result = scanner.scan_scheduled_workflows("test-org").await.unwrap();

        assert_eq!(result.total_repos, 1);
        assert_eq!(result.workflows.len(), 0);
    }

    #[tokio::test]
    async fn test_scan_repo_with_scheduled_workflow() {
        let mock_server = MockServer::start().await;
        let base_url = mock_server.uri();

        // Page 1: one repo
        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {
                    "id": 1,
                    "name": "test-repo",
                    "url": format!("{}/repos/test-org/test-repo", base_url)
                }
            ])))
            .mount(&mock_server)
            .await;

        // Page 2: empty
        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .and(query_param("page", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&mock_server)
            .await;

        // Workflows list
        Mock::given(method("GET"))
            .and(path("/repos/test-org/test-repo/actions/workflows"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "total_count": 1,
                "workflows": [{
                    "id": 101,
                    "node_id": "W_101",
                    "name": "CI Pipeline",
                    "path": ".github/workflows/ci.yml",
                    "state": "active",
                    "created_at": "2024-01-01T00:00:00Z",
                    "updated_at": "2024-01-01T00:00:00Z",
                    "url": format!("{}/repos/test-org/test-repo/actions/workflows/101", base_url),
                    "html_url": format!("{}/test-org/test-repo/actions/workflows/ci.yml", base_url),
                    "badge_url": format!("{}/test-org/test-repo/workflows/CI/badge.svg", base_url)
                }]
            })))
            .mount(&mock_server)
            .await;

        // Workflow file content with schedule
        let yaml_content = "on:\n  schedule:\n    - cron: \"0 9 * * *\"\n";
        let encoded = base64::engine::general_purpose::STANDARD.encode(yaml_content);

        Mock::given(method("GET"))
            .and(path(
                "/repos/test-org/test-repo/contents/.github/workflows/ci.yml",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": "ci.yml",
                "path": ".github/workflows/ci.yml",
                "sha": "abc123",
                "size": 100,
                "url": format!("{}/repos/test-org/test-repo/contents/.github/workflows/ci.yml", base_url),
                "type": "file",
                "encoding": "base64",
                "content": encoded,
                "_links": {
                    "self": format!("{}/repos/test-org/test-repo/contents/.github/workflows/ci.yml", base_url)
                }
            })))
            .mount(&mock_server)
            .await;

        // Workflow runs (empty)
        Mock::given(method("GET"))
            .and(path_regex(
                r"/repos/test-org/test-repo/actions/workflows/.*/runs",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "total_count": 0,
                "workflow_runs": []
            })))
            .mount(&mock_server)
            .await;

        // Commits for workflow file
        Mock::given(method("GET"))
            .and(path("/repos/test-org/test-repo/commits"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {
                    "url": format!("{}/repos/test-org/test-repo/commits/sha1", base_url),
                    "sha": "sha1",
                    "node_id": "C_1",
                    "html_url": format!("{}/test-org/test-repo/commit/sha1", base_url),
                    "comments_url": format!("{}/repos/test-org/test-repo/commits/sha1/comments", base_url),
                    "commit": {
                        "url": format!("{}/repos/test-org/test-repo/git/commits/sha1", base_url),
                        "message": "Update ci.yml",
                        "comment_count": 0,
                        "tree": {
                            "sha": "tree_sha1",
                            "url": format!("{}/repos/test-org/test-repo/git/trees/tree_sha1", base_url)
                        }
                    },
                    "author": mock_author_json(&base_url),
                    "committer": mock_author_json(&base_url),
                    "parents": []
                }
            ])))
            .mount(&mock_server)
            .await;

        // User profile (for is_active check) - return 404 to simulate inactive
        Mock::given(method("GET"))
            .and(path("/users/test-user"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock_server)
            .await;

        let octocrab = Octocrab::builder()
            .personal_token("test-token".to_string())
            .base_uri(&base_url)
            .unwrap()
            .build()
            .unwrap();

        let scanner = Scanner::new(octocrab, 5, 30).unwrap();
        let result = scanner.scan_scheduled_workflows("test-org").await.unwrap();

        assert_eq!(result.total_repos, 1);
        assert_eq!(result.workflows.len(), 1);
        assert_eq!(result.workflows[0].repo_name, "test-repo");
        assert_eq!(result.workflows[0].workflow_name, "CI Pipeline");
        assert_eq!(result.workflows[0].cron_schedules, vec!["0 9 * * *"]);
        assert_eq!(result.workflows[0].last_status, "never_run");
        assert_eq!(result.workflows[0].workflow_last_author, "test-user");
    }

    #[tokio::test]
    async fn test_scan_repo_workflow_list_failure() {
        let mock_server = MockServer::start().await;
        let base_url = mock_server.uri();

        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {
                    "id": 1,
                    "name": "failing-repo",
                    "url": format!("{}/repos/test-org/failing-repo", base_url)
                }
            ])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .and(query_param("page", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&mock_server)
            .await;

        // Workflows endpoint returns error
        Mock::given(method("GET"))
            .and(path("/repos/test-org/failing-repo/actions/workflows"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&mock_server)
            .await;

        let octocrab = Octocrab::builder()
            .personal_token("test-token".to_string())
            .base_uri(&base_url)
            .unwrap()
            .build()
            .unwrap();

        let scanner = Scanner::new(octocrab, 5, 30).unwrap();
        let result = scanner.scan_scheduled_workflows("test-org").await.unwrap();

        assert_eq!(result.total_repos, 1);
        assert_eq!(result.workflows.len(), 0);
    }

    #[tokio::test]
    async fn test_scan_repo_content_fetch_failure() {
        let mock_server = MockServer::start().await;
        let base_url = mock_server.uri();

        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {
                    "id": 1,
                    "name": "test-repo",
                    "url": format!("{}/repos/test-org/test-repo", base_url)
                }
            ])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .and(query_param("page", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/repos/test-org/test-repo/actions/workflows"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "total_count": 1,
                "workflows": [{
                    "id": 101,
                    "node_id": "W_101",
                    "name": "CI Pipeline",
                    "path": ".github/workflows/ci.yml",
                    "state": "active",
                    "created_at": "2024-01-01T00:00:00Z",
                    "updated_at": "2024-01-01T00:00:00Z",
                    "url": format!("{}/repos/test-org/test-repo/actions/workflows/101", base_url),
                    "html_url": format!("{}/test-org/test-repo/actions/workflows/ci.yml", base_url),
                    "badge_url": format!("{}/test-org/test-repo/workflows/CI/badge.svg", base_url)
                }]
            })))
            .mount(&mock_server)
            .await;

        // Content endpoint returns 404
        Mock::given(method("GET"))
            .and(path(
                "/repos/test-org/test-repo/contents/.github/workflows/ci.yml",
            ))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock_server)
            .await;

        let octocrab = Octocrab::builder()
            .personal_token("test-token".to_string())
            .base_uri(&base_url)
            .unwrap()
            .build()
            .unwrap();

        let scanner = Scanner::new(octocrab, 5, 30).unwrap();
        let result = scanner.scan_scheduled_workflows("test-org").await.unwrap();

        assert_eq!(result.total_repos, 1);
        assert_eq!(result.workflows.len(), 0);
    }

    #[tokio::test]
    async fn test_scan_repo_with_non_schedule_workflow() {
        let mock_server = MockServer::start().await;
        let base_url = mock_server.uri();

        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {
                    "id": 1,
                    "name": "test-repo",
                    "url": format!("{}/repos/test-org/test-repo", base_url)
                }
            ])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .and(query_param("page", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/repos/test-org/test-repo/actions/workflows"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "total_count": 1,
                "workflows": [{
                    "id": 201,
                    "node_id": "W_201",
                    "name": "Push CI",
                    "path": ".github/workflows/push.yml",
                    "state": "active",
                    "created_at": "2024-01-01T00:00:00Z",
                    "updated_at": "2024-01-01T00:00:00Z",
                    "url": format!("{}/repos/test-org/test-repo/actions/workflows/201", base_url),
                    "html_url": format!("{}/test-org/test-repo/actions/workflows/push.yml", base_url),
                    "badge_url": format!("{}/test-org/test-repo/workflows/Push/badge.svg", base_url)
                }]
            })))
            .mount(&mock_server)
            .await;

        // Workflow content without schedule
        let yaml_content = "on:\n  push:\n    branches:\n      - main\n";
        let encoded = base64::engine::general_purpose::STANDARD.encode(yaml_content);

        Mock::given(method("GET"))
            .and(path(
                "/repos/test-org/test-repo/contents/.github/workflows/push.yml",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": "push.yml",
                "path": ".github/workflows/push.yml",
                "sha": "def456",
                "size": 80,
                "url": format!("{}/repos/test-org/test-repo/contents/.github/workflows/push.yml", base_url),
                "type": "file",
                "encoding": "base64",
                "content": encoded,
                "_links": {
                    "self": format!("{}/repos/test-org/test-repo/contents/.github/workflows/push.yml", base_url)
                }
            })))
            .mount(&mock_server)
            .await;

        let octocrab = Octocrab::builder()
            .personal_token("test-token".to_string())
            .base_uri(&base_url)
            .unwrap()
            .build()
            .unwrap();

        let scanner = Scanner::new(octocrab, 5, 30).unwrap();
        let result = scanner.scan_scheduled_workflows("test-org").await.unwrap();

        assert_eq!(result.total_repos, 1);
        assert_eq!(result.workflows.len(), 0);
    }

    #[tokio::test]
    async fn test_scan_repo_list_api_error() {
        let mock_server = MockServer::start().await;
        let base_url = mock_server.uri();

        Mock::given(method("GET"))
            .and(path("/orgs/test-org/repos"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock_server)
            .await;

        let octocrab = Octocrab::builder()
            .personal_token("invalid-token".to_string())
            .base_uri(&base_url)
            .unwrap()
            .build()
            .unwrap();

        let scanner = Scanner::new(octocrab, 5, 30).unwrap();
        let result = scanner.scan_scheduled_workflows("test-org").await;

        assert!(result.is_err());
    }
}
