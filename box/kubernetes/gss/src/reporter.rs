use crate::models::ScanResult;
use anyhow::Result;

const KST_OFFSET_HOURS: i32 = 9;

pub trait ReportFormatter: Send + Sync {
    fn format(&self, result: &ScanResult) -> Result<String>;
}

pub struct ConsoleFormatter;

impl ConsoleFormatter {
    pub fn new() -> Self {
        Self
    }

    fn convert_cron_to_kst(cron: &str) -> String {
        let parts: Vec<&str> = cron.split_whitespace().collect();
        if parts.len() != 5 {
            return cron.to_string();
        }

        let minute = parts[0];
        let hour = parts[1];
        let day = parts[2];
        let month = parts[3];
        let dow = parts[4];

        // Parse hour field
        let kst_parts = if hour.contains(',') {
            // Multiple hours: "0,12" -> "9,21"
            let hours: Vec<&str> = hour.split(',').collect();
            let kst_hours: Vec<String> = hours
                .iter()
                .map(|h| {
                    h.parse::<i32>()
                        .map(|h| (h + KST_OFFSET_HOURS) % 24)
                        .map(|h| h.to_string())
                        .unwrap_or_else(|_| h.to_string())
                })
                .collect();
            (
                minute.to_string(),
                kst_hours.join(","),
                day.to_string(),
                month.to_string(),
                dow.to_string(),
            )
        } else if hour.contains('-') {
            // Range: "9-17" -> "18-2" (wraps)
            let range: Vec<&str> = hour.split('-').collect();
            if range.len() == 2 {
                let start = range[0].parse::<i32>().unwrap_or(0);
                let end = range[1].parse::<i32>().unwrap_or(0);
                let kst_start = (start + KST_OFFSET_HOURS) % 24;
                let kst_end = (end + KST_OFFSET_HOURS) % 24;
                (
                    minute.to_string(),
                    format!("{}-{}", kst_start, kst_end),
                    day.to_string(),
                    month.to_string(),
                    dow.to_string(),
                )
            } else {
                return cron.to_string();
            }
        } else if hour.contains('/') {
            // Step values: "*/6" -> "*/6" (same)
            (
                minute.to_string(),
                hour.to_string(),
                day.to_string(),
                month.to_string(),
                dow.to_string(),
            )
        } else if hour == "*" {
            // Every hour
            (
                minute.to_string(),
                hour.to_string(),
                day.to_string(),
                month.to_string(),
                dow.to_string(),
            )
        } else {
            // Single hour
            match hour.parse::<i32>() {
                Ok(h) => {
                    let kst_hour = (h + KST_OFFSET_HOURS) % 24;
                    let mut kst_dow = dow.to_string();

                    // Adjust day of week if hour wraps to next day
                    if h + KST_OFFSET_HOURS >= 24 && dow != "*" {
                        kst_dow = Self::adjust_day_of_week(dow);
                    }

                    (
                        minute.to_string(),
                        kst_hour.to_string(),
                        day.to_string(),
                        month.to_string(),
                        kst_dow,
                    )
                }
                Err(_) => return cron.to_string(),
            }
        };

        format!(
            "{} {} {} {} {}",
            kst_parts.0, kst_parts.1, kst_parts.2, kst_parts.3, kst_parts.4
        )
    }

    fn adjust_day_of_week(dow: &str) -> String {
        if dow.contains(',') {
            let days: Vec<&str> = dow.split(',').collect();
            let adjusted: Vec<String> = days.iter().map(|d| Self::increment_day(d)).collect();
            adjusted.join(",")
        } else if dow.contains('-') {
            let range: Vec<&str> = dow.split('-').collect();
            if range.len() == 2 {
                format!(
                    "{}-{}",
                    Self::increment_day(range[0]),
                    Self::increment_day(range[1])
                )
            } else {
                dow.to_string()
            }
        } else {
            Self::increment_day(dow)
        }
    }

    fn increment_day(day: &str) -> String {
        match day.parse::<i32>() {
            Ok(d) => ((d % 7) + 1).to_string(),
            Err(_) => day.to_string(),
        }
    }
}

impl Default for ConsoleFormatter {
    fn default() -> Self {
        Self::new()
    }
}

impl ReportFormatter for ConsoleFormatter {
    fn format(&self, result: &ScanResult) -> Result<String> {
        let mut output = String::new();

        // Build info
        output.push_str(&format!("Version: {}\n", env!("CARGO_PKG_VERSION")));
        output.push_str(&format!(
            "Build Date: {}\n",
            option_env!("BUILD_DATE").unwrap_or("unknown")
        ));
        output.push_str(&format!(
            "Git Commit: {}\n",
            option_env!("GIT_COMMIT").unwrap_or("unknown")
        ));
        output.push_str(&format!(
            "Rust Version: {}\n\n",
            option_env!("RUSTC_VERSION").unwrap_or(env!("CARGO_PKG_RUST_VERSION"))
        ));

        // Table header
        output.push_str(&format!(
            "{:<4} {:<30} {:<40} {:<20} {:<20} {:<25} {:<15}\n",
            "NO",
            "REPOSITORY",
            "WORKFLOW",
            "UTC SCHEDULE",
            "KST SCHEDULE",
            "WORKFLOW LAST AUTHOR",
            "LAST STATUS"
        ));
        output.push_str(&"-".repeat(175));
        output.push('\n');

        // Table rows
        for (idx, workflow) in result.workflows.iter().enumerate() {
            let schedule = workflow.cron_schedules.join(", ");
            let kst_schedule = workflow
                .cron_schedules
                .iter()
                .map(|s| Self::convert_cron_to_kst(s))
                .collect::<Vec<_>>()
                .join(", ");

            let author = if workflow.is_active_user {
                workflow.workflow_last_author.clone()
            } else {
                format!("{} (inactive)", workflow.workflow_last_author)
            };

            output.push_str(&format!(
                "{:<4} {:<30} {:<40} {:<20} {:<20} {:<25} {:<15}\n",
                idx + 1,
                truncate(&workflow.repo_name, 30),
                truncate(&workflow.workflow_name, 40),
                truncate(&schedule, 20),
                truncate(&kst_schedule, 20),
                truncate(&author, 25),
                truncate(&workflow.last_status, 15)
            ));
        }

        output.push('\n');
        output.push_str(&format!(
            "Total: {} scheduled workflows found in {} repositories ({} excluded)\n",
            result.workflows.len(),
            result.total_repos,
            result.excluded_repos_count
        ));
        output.push_str(&format!("Scan duration: {:?}\n", result.scan_duration));

        Ok(output)
    }
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len.saturating_sub(3)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ScanResult, WorkflowInfo};
    use chrono::Duration;

    #[test]
    fn test_convert_cron_to_kst_simple() {
        assert_eq!(
            ConsoleFormatter::convert_cron_to_kst("0 9 * * *"),
            "0 18 * * *"
        );
        assert_eq!(
            ConsoleFormatter::convert_cron_to_kst("30 14 * * 1"),
            "30 23 * * 1"
        );
    }

    #[test]
    fn test_convert_cron_to_kst_midnight_wrap() {
        assert_eq!(
            ConsoleFormatter::convert_cron_to_kst("0 20 * * 5"),
            "0 5 * * 6"
        );
    }

    #[test]
    fn test_convert_cron_to_kst_multiple_hours() {
        assert_eq!(
            ConsoleFormatter::convert_cron_to_kst("0 0,12 * * *"),
            "0 9,21 * * *"
        );
    }

    #[test]
    fn test_convert_cron_to_kst_every_hour() {
        assert_eq!(
            ConsoleFormatter::convert_cron_to_kst("0 * * * *"),
            "0 * * * *"
        );
    }

    #[test]
    fn test_convert_cron_to_kst_step() {
        assert_eq!(
            ConsoleFormatter::convert_cron_to_kst("0 */6 * * *"),
            "0 */6 * * *"
        );
    }

    #[test]
    fn test_console_formatter() {
        let mut result = ScanResult::new();
        result.total_repos = 10;
        result.excluded_repos_count = 2;
        result.scan_duration = Duration::seconds(30);

        let mut workflow = WorkflowInfo::new(
            "test-repo".to_string(),
            "test-workflow".to_string(),
            123,
            ".github/workflows/test.yml".to_string(),
        );
        workflow.cron_schedules = vec!["0 9 * * *".to_string()];
        workflow.last_status = "success".to_string();
        workflow.workflow_last_author = "johndoe".to_string();
        workflow.is_active_user = true;

        result.workflows.push(workflow);

        let formatter = ConsoleFormatter::new();
        let output = formatter.format(&result).unwrap();

        assert!(output.contains("test-repo"));
        assert!(output.contains("test-workflow"));
        assert!(output.contains("0 9 * * *"));
        assert!(output.contains("0 18 * * *")); // KST conversion
        assert!(output.contains("Total: 1 scheduled workflows"));
    }

    #[test]
    fn test_truncate() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("this is a very long string", 10), "this is...");
    }
}
