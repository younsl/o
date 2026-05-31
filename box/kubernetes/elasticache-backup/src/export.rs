use anyhow::{Context, Result};
use aws_sdk_elasticache::Client as ElastiCacheClient;
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

use crate::error::BackupError;

/// Export snapshot to S3 bucket
pub async fn export_to_s3(
    client: &ElastiCacheClient,
    snapshot_name: &str,
    s3_bucket_name: &str,
) -> Result<(String, String)> {
    let export_start_time = Instant::now();

    // Get source snapshot details before copy
    match client
        .describe_snapshots()
        .snapshot_name(snapshot_name)
        .send()
        .await
    {
        Ok(response) => {
            if let Some(_snapshot) = response.snapshots().first() {
                debug!(
                    snapshot_name = %snapshot_name,
                    "Source snapshot found for S3 export"
                );
            }
        }
        Err(e) => {
            warn!(
                snapshot_name = %snapshot_name,
                error = %e,
                "Failed to get snapshot details before copy"
            );
        }
    }

    // Generate target snapshot name for S3 export
    let target_snapshot_name = format!("{}-s3-export", snapshot_name);

    info!(
        source_snapshot_name = %snapshot_name,
        target_snapshot_name = %target_snapshot_name,
        s3_bucket_name = %s3_bucket_name,
        "Initiating snapshot copy to S3"
    );

    let response = client
        .copy_snapshot()
        .source_snapshot_name(snapshot_name)
        .target_snapshot_name(&target_snapshot_name)
        .target_bucket(s3_bucket_name)
        .send()
        .await
        .context("Failed to copy snapshot to S3")?;

    if let Some(copied_snapshot) = response.snapshot() {
        let export_initiation_time = export_start_time.elapsed().as_secs_f64();
        info!(
            duration_seconds = export_initiation_time,
            target_snapshot_name = %target_snapshot_name,
            snapshot_arn = copied_snapshot.arn().unwrap_or("Unknown"),
            "S3 export initiated successfully"
        );
    }

    let s3_location = format!("s3://{}/{}", s3_bucket_name, target_snapshot_name);
    Ok((target_snapshot_name, s3_location))
}

/// Wait for S3 export to complete
pub async fn wait_for_completion(
    client: &ElastiCacheClient,
    source_snapshot_name: &str,
    max_wait_time: u64,
    check_interval: u64,
) -> Result<()> {
    let wait_start_time = Instant::now();
    let mut checks_performed = 0;

    info!(
        source_snapshot_name = %source_snapshot_name,
        max_wait_time_seconds = max_wait_time,
        check_interval_seconds = check_interval,
        "Waiting for S3 export completion"
    );

    loop {
        if wait_start_time.elapsed().as_secs() >= max_wait_time {
            return Err(BackupError::Timeout(format!(
                "S3 export completion timeout after {:.1}s",
                wait_start_time.elapsed().as_secs_f64()
            ))
            .into());
        }

        let response = client
            .describe_snapshots()
            .snapshot_name(source_snapshot_name)
            .send()
            .await
            .context("Failed to describe snapshots during export wait")?;

        let snapshots = response.snapshots();
        if snapshots.is_empty() {
            return Err(BackupError::NotFound(format!(
                "Source snapshot {} not found",
                source_snapshot_name
            ))
            .into());
        }

        let snapshot = &snapshots[0];
        let status = snapshot.snapshot_status().unwrap_or("Unknown");
        checks_performed += 1;
        let elapsed_time = wait_start_time.elapsed().as_secs_f64();

        debug!(
            check_number = checks_performed,
            status = %status,
            elapsed_seconds = elapsed_time,
            "Export status check"
        );

        if status == "available" {
            let total_wait_time = wait_start_time.elapsed().as_secs_f64();
            info!(
                checks_performed,
                duration_seconds = total_wait_time,
                source_snapshot_name = %source_snapshot_name,
                "S3 export completed successfully"
            );
            return Ok(());
        } else if status == "failed" {
            return Err(BackupError::ExportFailed(format!(
                "S3 export failed with source snapshot status: {} after {} checks",
                status, checks_performed
            ))
            .into());
        } else if status == "copying" {
            debug!(
                status = %status,
                check_number = checks_performed,
                "S3 export in progress"
            );
        }

        // Additional progress logging every 10 checks
        if checks_performed % 10 == 0 {
            info!(
                check_number = checks_performed,
                status = %status,
                elapsed_seconds = elapsed_time,
                "Long-running S3 export detected"
            );
        }

        tokio::time::sleep(Duration::from_secs(check_interval)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_elasticache::Client;
    use aws_sdk_elasticache::operation::copy_snapshot::{CopySnapshotError, CopySnapshotOutput};
    use aws_sdk_elasticache::operation::describe_snapshots::DescribeSnapshotsOutput;
    use aws_sdk_elasticache::types::Snapshot;
    use aws_sdk_elasticache::types::error::SnapshotNotFoundFault;
    use aws_smithy_mocks::{RuleMode, mock, mock_client};

    fn snap(status: &str) -> Snapshot {
        Snapshot::builder()
            .snapshot_status(status)
            .arn("arn:aws:elasticache:test")
            .build()
    }

    #[tokio::test]
    async fn test_export_to_s3_ok() {
        let describe = mock!(Client::describe_snapshots).then_output(|| {
            DescribeSnapshotsOutput::builder()
                .snapshots(snap("available"))
                .build()
        });
        let copy = mock!(Client::copy_snapshot).then_output(|| {
            CopySnapshotOutput::builder()
                .snapshot(snap("copying"))
                .build()
        });
        let client = mock_client!(aws_sdk_elasticache, RuleMode::MatchAny, &[&describe, &copy]);
        let (target, location) = export_to_s3(&client, "snap", "my-bucket").await.unwrap();
        assert_eq!(target, "snap-s3-export");
        assert_eq!(location, "s3://my-bucket/snap-s3-export");
    }

    #[tokio::test]
    async fn test_export_to_s3_describe_error_then_copy() {
        // describe fails (warning), copy still proceeds.
        let describe = mock!(Client::describe_snapshots).then_error(|| {
            aws_sdk_elasticache::operation::describe_snapshots::DescribeSnapshotsError::SnapshotNotFoundFault(
                SnapshotNotFoundFault::builder().build(),
            )
        });
        let copy =
            mock!(Client::copy_snapshot).then_output(|| CopySnapshotOutput::builder().build());
        let client = mock_client!(aws_sdk_elasticache, RuleMode::MatchAny, &[&describe, &copy]);
        let (target, _) = export_to_s3(&client, "snap", "b").await.unwrap();
        assert_eq!(target, "snap-s3-export");
    }

    #[tokio::test]
    async fn test_export_to_s3_copy_error() {
        let describe = mock!(Client::describe_snapshots)
            .then_output(|| DescribeSnapshotsOutput::builder().build());
        let copy = mock!(Client::copy_snapshot).then_error(|| {
            CopySnapshotError::SnapshotNotFoundFault(SnapshotNotFoundFault::builder().build())
        });
        let client = mock_client!(aws_sdk_elasticache, RuleMode::MatchAny, &[&describe, &copy]);
        assert!(export_to_s3(&client, "snap", "b").await.is_err());
    }

    #[tokio::test]
    async fn test_wait_for_completion_available() {
        let rule = mock!(Client::describe_snapshots).then_output(|| {
            DescribeSnapshotsOutput::builder()
                .snapshots(snap("available"))
                .build()
        });
        let client = mock_client!(aws_sdk_elasticache, RuleMode::MatchAny, &[&rule]);
        wait_for_completion(&client, "snap", 30, 1).await.unwrap();
    }

    #[tokio::test]
    async fn test_wait_for_completion_failed() {
        let rule = mock!(Client::describe_snapshots).then_output(|| {
            DescribeSnapshotsOutput::builder()
                .snapshots(snap("failed"))
                .build()
        });
        let client = mock_client!(aws_sdk_elasticache, RuleMode::MatchAny, &[&rule]);
        assert!(wait_for_completion(&client, "snap", 30, 1).await.is_err());
    }

    #[tokio::test]
    async fn test_wait_for_completion_empty() {
        let rule = mock!(Client::describe_snapshots)
            .then_output(|| DescribeSnapshotsOutput::builder().build());
        let client = mock_client!(aws_sdk_elasticache, RuleMode::MatchAny, &[&rule]);
        assert!(wait_for_completion(&client, "snap", 30, 1).await.is_err());
    }

    #[tokio::test]
    async fn test_wait_for_completion_timeout() {
        let rule = mock!(Client::describe_snapshots).then_output(|| {
            DescribeSnapshotsOutput::builder()
                .snapshots(snap("copying"))
                .build()
        });
        let client = mock_client!(aws_sdk_elasticache, RuleMode::MatchAny, &[&rule]);
        let err = wait_for_completion(&client, "snap", 0, 1)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("timeout"));
    }
}
