use crate::models::ScanResult;
use crate::publisher::Publisher;
use crate::reporter::{ConsoleFormatter, ReportFormatter};
use anyhow::Result;
use async_trait::async_trait;

pub struct ConsolePublisher {
    formatter: ConsoleFormatter,
}

impl ConsolePublisher {
    pub fn new() -> Self {
        Self {
            formatter: ConsoleFormatter::new(),
        }
    }
}

impl Default for ConsolePublisher {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Publisher for ConsolePublisher {
    async fn publish(&self, result: &ScanResult) -> Result<()> {
        let output = self.formatter.format(result)?;
        println!("{}", output);
        Ok(())
    }

    fn name(&self) -> &str {
        "console"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ScanResult, WorkflowInfo};
    use chrono::Duration;

    #[tokio::test]
    async fn test_console_publisher() {
        let publisher = ConsolePublisher::new();
        assert_eq!(publisher.name(), "console");

        let mut result = ScanResult::new();
        result.total_repos = 5;
        result.scan_duration = Duration::seconds(10);

        let mut workflow = WorkflowInfo::new(
            "test-repo".to_string(),
            "ci".to_string(),
            1,
            ".github/workflows/ci.yml".to_string(),
        );
        workflow.cron_schedules = vec!["0 0 * * *".to_string()];
        result.workflows.push(workflow);

        let publish_result = publisher.publish(&result).await;
        assert!(publish_result.is_ok());
    }
}
