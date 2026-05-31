use anyhow::{Context, Result};
use aws_sdk_s3::Client as S3Client;
use chrono::{DateTime, Utc};
use std::time::Instant;
use tracing::{debug, info, warn};

/// S3 object metadata for retention management
#[derive(Debug, Clone)]
struct S3Object {
    key: String,
    last_modified: DateTime<Utc>,
    size: i64,
}

/// Clean up old snapshots in S3 based on retention policy
pub async fn cleanup_old_snapshots(
    s3_client: &S3Client,
    bucket_name: &str,
    cache_cluster_id: &str,
    retention_count: u32,
) -> Result<usize> {
    if retention_count == 0 {
        info!(
            retention_count,
            "Retention count is 0, skipping cleanup for unlimited retention"
        );
        return Ok(0);
    }

    let cleanup_start_time = Instant::now();
    info!(
        bucket_name = %bucket_name,
        cache_cluster_id = %cache_cluster_id,
        retention_count,
        "Starting S3 snapshot retention cleanup"
    );

    // List all objects with the cache cluster prefix
    let prefix = format!("{}-", cache_cluster_id);
    debug!(
        prefix = %prefix,
        "Listing S3 objects with prefix"
    );

    let mut objects = Vec::new();
    let mut continuation_token: Option<String> = None;
    let mut total_listed = 0;

    loop {
        let mut request = s3_client
            .list_objects_v2()
            .bucket(bucket_name)
            .prefix(&prefix);

        if let Some(token) = continuation_token {
            request = request.continuation_token(token);
        }

        let response = request.send().await.context("Failed to list S3 objects")?;

        let contents = response.contents();
        let batch_size = contents.len();
        total_listed += batch_size;

        debug!(batch_size, total_listed, "Retrieved S3 objects batch");

        for obj in contents {
            if let (Some(key), Some(last_modified), Some(size)) =
                (obj.key(), obj.last_modified(), obj.size())
            {
                objects.push(S3Object {
                    key: key.to_string(),
                    last_modified: DateTime::from_timestamp(
                        last_modified.secs(),
                        last_modified.subsec_nanos(),
                    )
                    .unwrap_or_else(Utc::now),
                    size,
                });
            }
        }

        if response.is_truncated().unwrap_or(false) {
            continuation_token = response.next_continuation_token().map(|s| s.to_string());
            debug!("More objects available, continuing pagination");
        } else {
            break;
        }
    }

    let total_objects = objects.len();
    info!(
        total_objects,
        retention_count, "S3 objects listing completed"
    );

    if total_objects == 0 {
        info!("No snapshots found in S3, nothing to clean up");
        return Ok(0);
    }

    // Sort by last modified date (newest first)
    objects.sort_by_key(|o| std::cmp::Reverse(o.last_modified));

    // Log the snapshots we found
    for (idx, obj) in objects.iter().enumerate() {
        debug!(
            index = idx + 1,
            key = %obj.key,
            last_modified = %obj.last_modified.format("%Y-%m-%d %H:%M:%S UTC"),
            size_bytes = obj.size,
            status = if idx < retention_count as usize { "KEEP" } else { "DELETE" },
            "Snapshot status"
        );
    }

    // Determine which objects to delete
    let objects_to_delete: Vec<_> = objects.iter().skip(retention_count as usize).collect();

    let delete_count = objects_to_delete.len();
    let keep_count = total_objects - delete_count;

    if delete_count == 0 {
        info!(
            total_objects,
            retention_count, "All snapshots are within retention policy, nothing to delete"
        );
        return Ok(0);
    }

    info!(
        total_objects,
        keep_count, delete_count, "Retention analysis completed"
    );

    // Delete old objects
    let mut deleted_count = 0;
    let mut failed_count = 0;
    let mut total_deleted_size: i64 = 0;

    for obj in objects_to_delete {
        let delete_start = Instant::now();

        info!(
            key = %obj.key,
            last_modified = %obj.last_modified.format("%Y-%m-%d %H:%M:%S UTC"),
            size_bytes = obj.size,
            "Deleting old snapshot"
        );

        match s3_client
            .delete_object()
            .bucket(bucket_name)
            .key(&obj.key)
            .send()
            .await
        {
            Ok(_) => {
                let delete_duration = delete_start.elapsed().as_secs_f64();
                deleted_count += 1;
                total_deleted_size += obj.size;

                info!(
                    key = %obj.key,
                    duration_seconds = delete_duration,
                    size_bytes = obj.size,
                    deleted_count,
                    remaining = delete_count - deleted_count,
                    "Snapshot deleted successfully"
                );
            }
            Err(e) => {
                let delete_duration = delete_start.elapsed().as_secs_f64();
                failed_count += 1;

                warn!(
                    key = %obj.key,
                    error = %e,
                    duration_seconds = delete_duration,
                    failed_count,
                    "Failed to delete snapshot"
                );
            }
        }
    }

    let total_cleanup_time = cleanup_start_time.elapsed().as_secs_f64();

    info!(
        total_objects,
        kept = keep_count,
        deleted = deleted_count,
        failed = failed_count,
        total_deleted_size_bytes = total_deleted_size,
        total_deleted_size_mb = total_deleted_size as f64 / 1024.0 / 1024.0,
        duration_seconds = total_cleanup_time,
        "S3 snapshot retention cleanup completed"
    );

    if failed_count > 0 {
        warn!(
            failed_count,
            deleted_count, "Some deletions failed, but continuing"
        );
    }

    Ok(deleted_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::delete_object::DeleteObjectOutput;
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
    use aws_sdk_s3::types::Object;
    use aws_smithy_mocks::{RuleMode, mock, mock_client};
    use aws_smithy_types::DateTime;

    fn obj(key: &str, secs: i64) -> Object {
        Object::builder()
            .key(key)
            .last_modified(DateTime::from_secs(secs))
            .size(1024)
            .build()
    }

    #[tokio::test]
    async fn test_retention_zero_early_return() {
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[]);
        let deleted = cleanup_old_snapshots(&client, "bucket", "cluster", 0)
            .await
            .unwrap();
        assert_eq!(deleted, 0);
    }

    #[tokio::test]
    async fn test_retention_empty_bucket() {
        let list = mock!(Client::list_objects_v2)
            .then_output(|| ListObjectsV2Output::builder().is_truncated(false).build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list]);
        let deleted = cleanup_old_snapshots(&client, "bucket", "cluster", 3)
            .await
            .unwrap();
        assert_eq!(deleted, 0);
    }

    #[tokio::test]
    async fn test_retention_all_within_retention() {
        let list = mock!(Client::list_objects_v2).then_output(|| {
            ListObjectsV2Output::builder()
                .contents(obj("cluster-1", 100))
                .contents(obj("cluster-2", 200))
                .is_truncated(false)
                .build()
        });
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list]);
        let deleted = cleanup_old_snapshots(&client, "bucket", "cluster", 5)
            .await
            .unwrap();
        assert_eq!(deleted, 0);
    }

    #[tokio::test]
    async fn test_retention_deletes_excess() {
        let list = mock!(Client::list_objects_v2).then_output(|| {
            ListObjectsV2Output::builder()
                .contents(obj("cluster-1", 100))
                .contents(obj("cluster-2", 200))
                .contents(obj("cluster-3", 300))
                .is_truncated(false)
                .build()
        });
        // retention 1 => 2 objects deleted
        let delete =
            mock!(Client::delete_object).then_output(|| DeleteObjectOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list, &delete]);
        let deleted = cleanup_old_snapshots(&client, "bucket", "cluster", 1)
            .await
            .unwrap();
        assert_eq!(deleted, 2);
    }

    #[tokio::test]
    async fn test_retention_pagination() {
        // First page truncated, second page final.
        let page1 = mock!(Client::list_objects_v2)
            .match_requests(|req| req.continuation_token().is_none())
            .then_output(|| {
                ListObjectsV2Output::builder()
                    .contents(obj("cluster-1", 100))
                    .contents(obj("cluster-2", 200))
                    .is_truncated(true)
                    .next_continuation_token("token-2")
                    .build()
            });
        let page2 = mock!(Client::list_objects_v2)
            .match_requests(|req| req.continuation_token() == Some("token-2"))
            .then_output(|| {
                ListObjectsV2Output::builder()
                    .contents(obj("cluster-3", 300))
                    .is_truncated(false)
                    .build()
            });
        let delete =
            mock!(Client::delete_object).then_output(|| DeleteObjectOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&page1, &page2, &delete]);
        // 3 total, retention 1 => 2 deleted
        let deleted = cleanup_old_snapshots(&client, "bucket", "cluster", 1)
            .await
            .unwrap();
        assert_eq!(deleted, 2);
    }

    #[tokio::test]
    async fn test_retention_delete_failure() {
        let list = mock!(Client::list_objects_v2).then_output(|| {
            ListObjectsV2Output::builder()
                .contents(obj("cluster-1", 100))
                .contents(obj("cluster-2", 200))
                .is_truncated(false)
                .build()
        });
        // Delete fails with HTTP 500 -> counted as failed, not deleted.
        let delete = mock!(Client::delete_object)
            .sequence()
            .http_status(500, None)
            .build();
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list, &delete]);
        let deleted = cleanup_old_snapshots(&client, "bucket", "cluster", 1)
            .await
            .unwrap();
        assert_eq!(deleted, 0);
    }

    #[tokio::test]
    async fn test_retention_list_error() {
        let list = mock!(Client::list_objects_v2)
            .sequence()
            .http_status(500, None)
            .build();
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list]);
        assert!(
            cleanup_old_snapshots(&client, "bucket", "cluster", 1)
                .await
                .is_err()
        );
    }
}
