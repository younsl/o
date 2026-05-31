use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ExecutionSummary {
    pub status: String,
    pub message: String,
    pub total_execution_time_seconds: f64,
    pub step_timings: StepTimings,
    pub cache_cluster: String,
    pub snapshot_name: Option<String>,
    pub target_snapshot_name: Option<String>,
    pub s3_location: Option<String>,
    pub s3_bucket: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention_info: Option<RetentionInfo>,
}

#[derive(Debug, Serialize, Default)]
pub struct StepTimings {
    pub snapshot_creation: f64,
    pub snapshot_wait: f64,
    pub s3_export: f64,
    pub export_wait: f64,
    pub cleanup: f64,
    pub retention: f64,
}

#[derive(Debug, Serialize)]
pub struct RetentionInfo {
    pub enabled: bool,
    pub retention_count: u32,
    pub deleted_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_step_timings_default() {
        let t = StepTimings::default();
        assert_eq!(t.snapshot_creation, 0.0);
        assert_eq!(t.retention, 0.0);
    }

    #[test]
    fn test_summary_serializes_without_retention() {
        let summary = ExecutionSummary {
            status: "Success".to_string(),
            message: "ok".to_string(),
            total_execution_time_seconds: 1.5,
            step_timings: StepTimings::default(),
            cache_cluster: "cluster".to_string(),
            snapshot_name: Some("snap".to_string()),
            target_snapshot_name: Some("snap-s3-export".to_string()),
            s3_location: Some("s3://b/k".to_string()),
            s3_bucket: "b".to_string(),
            retention_info: None,
        };
        let json = serde_json::to_string(&summary).unwrap();
        // retention_info is skipped when None.
        assert!(!json.contains("retention_info"));
        assert!(json.contains("\"status\":\"Success\""));
    }

    #[test]
    fn test_summary_serializes_with_retention() {
        let summary = ExecutionSummary {
            status: "Success".to_string(),
            message: "ok".to_string(),
            total_execution_time_seconds: 0.0,
            step_timings: StepTimings::default(),
            cache_cluster: "c".to_string(),
            snapshot_name: None,
            target_snapshot_name: None,
            s3_location: None,
            s3_bucket: "b".to_string(),
            retention_info: Some(RetentionInfo {
                enabled: true,
                retention_count: 3,
                deleted_count: 2,
            }),
        };
        let json = serde_json::to_string(&summary).unwrap();
        assert!(json.contains("retention_info"));
        assert!(json.contains("\"deleted_count\":2"));
    }
}
