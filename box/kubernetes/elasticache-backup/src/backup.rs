use anyhow::Result;
use aws_config::BehaviorVersion;
use aws_sdk_elasticache::Client as ElastiCacheClient;
use aws_sdk_s3::Client as S3Client;
use std::time::Instant;
use tracing::{info, info_span};

use crate::cli::Args;
use crate::export;
use crate::retention;
use crate::snapshot;
use crate::types::StepTimings;

/// Run the complete backup workflow
pub async fn run(
    args: &Args,
    step_timings: &mut StepTimings,
    snapshot_name_out: &mut Option<String>,
) -> Result<(String, String, usize)> {
    // Initialize AWS SDK
    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(aws_config::Region::new(args.region.clone()))
        .load()
        .await;

    let elasticache_client = ElastiCacheClient::new(&config);
    let s3_client = S3Client::new(&config);

    run_with_clients(
        &elasticache_client,
        &s3_client,
        args,
        step_timings,
        snapshot_name_out,
    )
    .await
}

/// Run the backup workflow against the provided AWS clients.
///
/// This is the dependency-injected core of [`run`]; it contains the full
/// orchestration logic minus AWS client construction so it can be driven with
/// mock clients in tests.
pub(crate) async fn run_with_clients(
    elasticache_client: &ElastiCacheClient,
    s3_client: &S3Client,
    args: &Args,
    step_timings: &mut StepTimings,
    snapshot_name_out: &mut Option<String>,
) -> Result<(String, String, usize)> {
    // Step 1: Create snapshot
    let _span = info_span!("step_1_snapshot_creation").entered();
    info!("Creating ElastiCache snapshot");
    let step1_start = Instant::now();
    let snapshot_name =
        snapshot::create_snapshot(elasticache_client, &args.cache_cluster_id).await?;
    *snapshot_name_out = Some(snapshot_name.clone());
    step_timings.snapshot_creation = step1_start.elapsed().as_secs_f64();
    info!(
        duration_seconds = step_timings.snapshot_creation,
        snapshot_name = %snapshot_name,
        "Snapshot creation completed"
    );
    drop(_span);

    // Step 2: Wait for snapshot completion
    let _span = info_span!("step_2_snapshot_wait", snapshot_name = %snapshot_name).entered();
    info!("Waiting for snapshot completion");
    let step2_start = Instant::now();
    snapshot::wait_for_completion(
        elasticache_client,
        &snapshot_name,
        args.snapshot_timeout,
        args.check_interval,
    )
    .await?;
    step_timings.snapshot_wait = step2_start.elapsed().as_secs_f64();
    info!(
        duration_seconds = step_timings.snapshot_wait,
        "Snapshot wait completed"
    );
    drop(_span);

    // Step 3: Export to S3
    let _span = info_span!("step_3_s3_export", snapshot_name = %snapshot_name).entered();
    info!("Copying snapshot to S3");
    let step3_start = Instant::now();
    let (target_snapshot_name, s3_location) =
        export::export_to_s3(elasticache_client, &snapshot_name, &args.s3_bucket_name).await?;
    step_timings.s3_export = step3_start.elapsed().as_secs_f64();
    info!(
        duration_seconds = step_timings.s3_export,
        target_snapshot_name = %target_snapshot_name,
        s3_location = %s3_location,
        "S3 export completed"
    );
    drop(_span);

    // Step 4: Wait for export completion
    let _span = info_span!("step_4_export_wait", snapshot_name = %snapshot_name).entered();
    info!("Waiting for S3 export completion");
    let step4_start = Instant::now();
    export::wait_for_completion(
        elasticache_client,
        &snapshot_name,
        args.export_timeout,
        args.check_interval,
    )
    .await?;
    step_timings.export_wait = step4_start.elapsed().as_secs_f64();
    info!(
        duration_seconds = step_timings.export_wait,
        "Export wait completed"
    );
    drop(_span);

    // Step 5: Cleanup
    let _span = info_span!("step_5_cleanup", snapshot_name = %snapshot_name).entered();
    info!("Cleaning up source snapshot");
    let step5_start = Instant::now();
    snapshot::cleanup(elasticache_client, &snapshot_name).await;
    step_timings.cleanup = step5_start.elapsed().as_secs_f64();
    info!(duration_seconds = step_timings.cleanup, "Cleanup completed");
    drop(_span);

    // Step 6: Retention cleanup
    let _span = info_span!("step_6_retention_cleanup").entered();
    let step6_start = Instant::now();
    let deleted_count = if args.retention_count > 0 {
        info!(
            retention_count = args.retention_count,
            "Starting retention cleanup"
        );
        match retention::cleanup_old_snapshots(
            s3_client,
            &args.s3_bucket_name,
            &args.cache_cluster_id,
            args.retention_count,
        )
        .await
        {
            Ok(count) => {
                step_timings.retention = step6_start.elapsed().as_secs_f64();
                info!(
                    deleted_count = count,
                    duration_seconds = step_timings.retention,
                    "Retention cleanup completed"
                );
                count
            }
            Err(e) => {
                step_timings.retention = step6_start.elapsed().as_secs_f64();
                info!(
                    error = %e,
                    duration_seconds = step_timings.retention,
                    "Retention cleanup failed, continuing"
                );
                0
            }
        }
    } else {
        info!(
            retention_count = 0,
            "Retention cleanup disabled, unlimited retention"
        );
        0
    };
    drop(_span);

    Ok((target_snapshot_name, s3_location, deleted_count))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_elasticache::Client as EcClient;
    use aws_sdk_elasticache::operation::copy_snapshot::CopySnapshotOutput;
    use aws_sdk_elasticache::operation::create_snapshot::CreateSnapshotOutput;
    use aws_sdk_elasticache::operation::delete_snapshot::DeleteSnapshotOutput;
    use aws_sdk_elasticache::operation::describe_snapshots::DescribeSnapshotsOutput;
    use aws_sdk_elasticache::types::Snapshot;
    use aws_sdk_s3::Client as S3MockClient;
    use aws_sdk_s3::operation::delete_object::DeleteObjectOutput;
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
    use aws_sdk_s3::types::Object;
    use aws_smithy_mocks::{RuleMode, mock, mock_client};
    use aws_smithy_types::DateTime;

    fn test_args(retention_count: u32) -> Args {
        Args {
            cache_cluster_id: "cluster".to_string(),
            s3_bucket_name: "bucket".to_string(),
            region: "ap-northeast-2".to_string(),
            snapshot_timeout: 30,
            export_timeout: 30,
            check_interval: 1,
            retention_count,
        }
    }

    fn available() -> Snapshot {
        Snapshot::builder().snapshot_status("available").build()
    }

    #[tokio::test]
    async fn test_run_with_clients_happy_path_with_retention() {
        let create = mock!(EcClient::create_snapshot).then_output(|| {
            CreateSnapshotOutput::builder()
                .snapshot(available())
                .build()
        });
        let describe = mock!(EcClient::describe_snapshots).then_output(|| {
            DescribeSnapshotsOutput::builder()
                .snapshots(available())
                .build()
        });
        let copy = mock!(EcClient::copy_snapshot)
            .then_output(|| CopySnapshotOutput::builder().snapshot(available()).build());
        let delete_snap = mock!(EcClient::delete_snapshot)
            .then_output(|| DeleteSnapshotOutput::builder().build());
        let ec_client = mock_client!(
            aws_sdk_elasticache,
            RuleMode::MatchAny,
            &[&create, &describe, &copy, &delete_snap]
        );

        let list = mock!(S3MockClient::list_objects_v2).then_output(|| {
            ListObjectsV2Output::builder()
                .contents(
                    Object::builder()
                        .key("cluster-1")
                        .last_modified(DateTime::from_secs(100))
                        .size(10)
                        .build(),
                )
                .contents(
                    Object::builder()
                        .key("cluster-2")
                        .last_modified(DateTime::from_secs(200))
                        .size(10)
                        .build(),
                )
                .is_truncated(false)
                .build()
        });
        let delete_obj = mock!(S3MockClient::delete_object)
            .then_output(|| DeleteObjectOutput::builder().build());
        let s3_client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list, &delete_obj]);

        let args = test_args(1);
        let mut timings = StepTimings::default();
        let mut name = None;
        let (target, location, deleted) =
            run_with_clients(&ec_client, &s3_client, &args, &mut timings, &mut name)
                .await
                .unwrap();
        assert!(target.ends_with("-s3-export"));
        assert!(location.starts_with("s3://bucket/"));
        assert_eq!(deleted, 1);
        assert!(name.is_some());
    }

    #[tokio::test]
    async fn test_run_with_clients_no_retention() {
        let create = mock!(EcClient::create_snapshot).then_output(|| {
            CreateSnapshotOutput::builder()
                .snapshot(available())
                .build()
        });
        let describe = mock!(EcClient::describe_snapshots).then_output(|| {
            DescribeSnapshotsOutput::builder()
                .snapshots(available())
                .build()
        });
        let copy = mock!(EcClient::copy_snapshot)
            .then_output(|| CopySnapshotOutput::builder().snapshot(available()).build());
        let delete_snap = mock!(EcClient::delete_snapshot)
            .then_output(|| DeleteSnapshotOutput::builder().build());
        let ec_client = mock_client!(
            aws_sdk_elasticache,
            RuleMode::MatchAny,
            &[&create, &describe, &copy, &delete_snap]
        );
        // retention_count = 0 -> S3 client never used.
        let s3_client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[]);

        let args = test_args(0);
        let mut timings = StepTimings::default();
        let mut name = None;
        let (_, _, deleted) =
            run_with_clients(&ec_client, &s3_client, &args, &mut timings, &mut name)
                .await
                .unwrap();
        assert_eq!(deleted, 0);
    }

    #[tokio::test]
    async fn test_run_with_clients_retention_error_is_swallowed() {
        let create = mock!(EcClient::create_snapshot).then_output(|| {
            CreateSnapshotOutput::builder()
                .snapshot(available())
                .build()
        });
        let describe = mock!(EcClient::describe_snapshots).then_output(|| {
            DescribeSnapshotsOutput::builder()
                .snapshots(available())
                .build()
        });
        let copy = mock!(EcClient::copy_snapshot)
            .then_output(|| CopySnapshotOutput::builder().snapshot(available()).build());
        let delete_snap = mock!(EcClient::delete_snapshot)
            .then_output(|| DeleteSnapshotOutput::builder().build());
        let ec_client = mock_client!(
            aws_sdk_elasticache,
            RuleMode::MatchAny,
            &[&create, &describe, &copy, &delete_snap]
        );
        // Retention listing fails -> error swallowed, deleted_count = 0.
        let list = mock!(S3MockClient::list_objects_v2)
            .sequence()
            .http_status(500, None)
            .build();
        let s3_client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list]);

        let args = test_args(2);
        let mut timings = StepTimings::default();
        let mut name = None;
        let (_, _, deleted) =
            run_with_clients(&ec_client, &s3_client, &args, &mut timings, &mut name)
                .await
                .unwrap();
        assert_eq!(deleted, 0);
    }
}
