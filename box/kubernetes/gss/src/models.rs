use chrono::Duration;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowInfo {
    pub repo_name: String,
    pub workflow_name: String,
    pub workflow_id: i64,
    pub workflow_file_name: String,
    pub cron_schedules: Vec<String>,
    pub last_status: String,
    pub workflow_last_author: String,
    pub is_active_user: bool,
}

impl WorkflowInfo {
    pub fn new(
        repo_name: String,
        workflow_name: String,
        workflow_id: i64,
        workflow_file_name: String,
    ) -> Self {
        Self {
            repo_name,
            workflow_name,
            workflow_id,
            workflow_file_name,
            cron_schedules: Vec::new(),
            last_status: String::new(),
            workflow_last_author: String::new(),
            is_active_user: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub workflows: Vec<WorkflowInfo>,
    pub total_repos: usize,
    pub excluded_repos_count: usize,
    pub scan_duration: Duration,
    pub max_concurrent_scans: usize,
}

impl ScanResult {
    pub fn new() -> Self {
        Self {
            workflows: Vec::new(),
            total_repos: 0,
            excluded_repos_count: 0,
            scan_duration: Duration::zero(),
            max_concurrent_scans: 0,
        }
    }
}

impl Default for ScanResult {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Deserialize)]
pub struct WorkflowFile {
    pub on: Option<WorkflowTrigger>,
}

#[derive(Debug, Deserialize)]
pub struct WorkflowTrigger {
    pub schedule: Option<Vec<ScheduleConfig>>,
}

#[derive(Debug, Deserialize)]
pub struct ScheduleConfig {
    pub cron: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_info_creation() {
        let workflow = WorkflowInfo::new(
            "test-repo".to_string(),
            "test-workflow".to_string(),
            123,
            ".github/workflows/test.yml".to_string(),
        );

        assert_eq!(workflow.repo_name, "test-repo");
        assert_eq!(workflow.workflow_name, "test-workflow");
        assert_eq!(workflow.workflow_id, 123);
        assert!(workflow.cron_schedules.is_empty());
    }

    #[test]
    fn test_scan_result_default() {
        let result = ScanResult::default();
        assert_eq!(result.total_repos, 0);
        assert_eq!(result.excluded_repos_count, 0);
        assert!(result.workflows.is_empty());
    }

    #[test]
    fn test_workflow_yaml_parsing() {
        let yaml = r#"
on:
  schedule:
    - cron: "0 9 * * *"
    - cron: "0 18 * * 1-5"
"#;

        let workflow: WorkflowFile = serde_yaml::from_str(yaml).unwrap();
        assert!(workflow.on.is_some());

        let trigger = workflow.on.unwrap();
        assert!(trigger.schedule.is_some());

        let schedules = trigger.schedule.unwrap();
        assert_eq!(schedules.len(), 2);
        assert_eq!(schedules[0].cron, "0 9 * * *");
        assert_eq!(schedules[1].cron, "0 18 * * 1-5");
    }
}
