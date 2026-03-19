//! Prometheus metrics for the ec2-scheduler operator.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use prometheus_client::encoding::EncodeLabelSet;
use prometheus_client::encoding::text::encode;
use prometheus_client::metrics::counter::Counter;
use prometheus_client::metrics::family::Family;
use prometheus_client::metrics::gauge::Gauge;
use prometheus_client::metrics::histogram::Histogram;
use prometheus_client::registry::Registry;

/// Labels for action metrics.
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct ActionLabels {
    pub schedule: String,
    pub action: String,
    pub result: String,
}

/// Labels for instance metrics.
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct InstanceLabels {
    pub schedule: String,
    pub region: String,
    pub state: String,
}

/// Labels for reconcile metrics.
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct ReconcileLabels {
    pub schedule: String,
    pub result: String,
}

/// Labels for reconcile duration metrics.
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct ReconcileDurationLabels {
    pub schedule: String,
}

/// Labels for next-action metrics.
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct NextActionLabels {
    pub schedule: String,
    pub action: String,
}

/// Labels for schedule info metrics.
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct ScheduleInfoLabels {
    pub schedule: String,
    pub timezone: String,
    pub paused: String,
}

/// Key for tracking initialized schedules.
type ScheduleKey = String;

const RECONCILE_BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/// All Prometheus metrics for the operator.
pub struct Metrics {
    pub actions_total: Family<ActionLabels, Counter>,
    pub managed_instances: Family<InstanceLabels, Gauge>,
    pub reconcile_total: Family<ReconcileLabels, Counter>,
    pub reconcile_duration_seconds: Family<ReconcileDurationLabels, Histogram>,
    pub next_action_seconds: Family<NextActionLabels, Gauge>,
    pub schedule_info: Family<ScheduleInfoLabels, Gauge>,
    /// Tracks which schedules have had their metrics pre-initialized.
    initialized_schedules: Mutex<HashSet<ScheduleKey>>,
}

impl Metrics {
    /// Create and register all metrics with the given registry.
    pub fn new(registry: &mut Registry) -> Self {
        let actions_total = Family::<ActionLabels, Counter>::default();
        registry.register(
            "ec2_scheduler_actions",
            "Total number of EC2 start/stop actions executed",
            actions_total.clone(),
        );

        let managed_instances = Family::<InstanceLabels, Gauge>::default();
        registry.register(
            "ec2_scheduler_managed_instances",
            "Number of managed EC2 instances by state",
            managed_instances.clone(),
        );

        let reconcile_total = Family::<ReconcileLabels, Counter>::default();
        registry.register(
            "ec2_scheduler_reconcile",
            "Total number of reconcile calls",
            reconcile_total.clone(),
        );

        let reconcile_duration_seconds =
            Family::<ReconcileDurationLabels, Histogram>::new_with_constructor(|| {
                Histogram::new(RECONCILE_BUCKETS.iter().copied())
            });
        registry.register(
            "ec2_scheduler_reconcile_duration_seconds",
            "Duration of reconcile calls in seconds",
            reconcile_duration_seconds.clone(),
        );

        let next_action_seconds = Family::<NextActionLabels, Gauge>::default();
        registry.register(
            "ec2_scheduler_next_action_seconds",
            "Seconds until the next scheduled action",
            next_action_seconds.clone(),
        );

        let schedule_info = Family::<ScheduleInfoLabels, Gauge>::default();
        registry.register(
            "ec2_scheduler_schedule_info",
            "Schedule information (1=active)",
            schedule_info.clone(),
        );

        Self {
            actions_total,
            managed_instances,
            reconcile_total,
            reconcile_duration_seconds,
            next_action_seconds,
            schedule_info,
            initialized_schedules: Mutex::new(HashSet::new()),
        }
    }

    /// Pre-initialize counter label combinations for a schedule.
    pub fn init_for_schedule(&self, schedule: &str) {
        let key = schedule.to_string();
        {
            let mut initialized = self.initialized_schedules.lock().unwrap();
            if !initialized.insert(key) {
                return;
            }
        }

        // reconcile_total: pre-initialize all result label values
        for result in &["success", "requeue", "error"] {
            let _ = self.reconcile_total.get_or_create(&ReconcileLabels {
                schedule: schedule.to_string(),
                result: result.to_string(),
            });
        }

        // actions_total: pre-initialize start/stop with success/error
        for action in &["Start", "Stop"] {
            for result in &["success", "error"] {
                let _ = self.actions_total.get_or_create(&ActionLabels {
                    schedule: schedule.to_string(),
                    action: action.to_string(),
                    result: result.to_string(),
                });
            }
        }
    }
}

/// Axum handler that encodes the registry as `OpenMetrics` text.
async fn metrics_handler(State(registry): State<Arc<Registry>>) -> impl IntoResponse {
    let mut buf = String::new();
    if encode(&mut buf, &registry).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to encode metrics".to_string(),
        );
    }
    (StatusCode::OK, buf)
}

/// Start the metrics server on the given port.
pub async fn serve(port: u16, registry: Arc<Registry>) -> anyhow::Result<()> {
    use axum::Router;
    use axum::routing::get;
    use tokio::net::TcpListener;
    use tracing::info;

    let app = Router::new()
        .route("/metrics", get(metrics_handler))
        .with_state(registry);

    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    info!("Metrics server listening on port {}", port);
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_registration() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry);

        metrics
            .reconcile_total
            .get_or_create(&ReconcileLabels {
                schedule: "test".to_string(),
                result: "success".to_string(),
            })
            .inc();

        metrics
            .actions_total
            .get_or_create(&ActionLabels {
                schedule: "test".to_string(),
                action: "Start".to_string(),
                result: "success".to_string(),
            })
            .inc();
    }

    #[test]
    fn test_metrics_encoding() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry);

        metrics
            .reconcile_total
            .get_or_create(&ReconcileLabels {
                schedule: "dev-instances".to_string(),
                result: "success".to_string(),
            })
            .inc();

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();
        assert!(buf.contains("ec2_scheduler_reconcile_total"));
        assert!(buf.contains("dev-instances"));
    }

    #[test]
    fn test_histogram_observe() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry);

        let labels = ReconcileDurationLabels {
            schedule: "test".to_string(),
        };
        metrics
            .reconcile_duration_seconds
            .get_or_create(&labels)
            .observe(0.5);

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();
        assert!(buf.contains("ec2_scheduler_reconcile_duration_seconds"));
    }

    #[test]
    fn test_init_for_schedule_creates_zero_counters() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry);

        metrics.init_for_schedule("dev-instances");

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();

        assert!(
            buf.contains(
                r#"ec2_scheduler_reconcile_total{schedule="dev-instances",result="success"} 0"#
            ),
            "missing pre-initialized reconcile_total success"
        );
        assert!(
            buf.contains(
                r#"ec2_scheduler_reconcile_total{schedule="dev-instances",result="requeue"} 0"#
            ),
            "missing pre-initialized reconcile_total requeue"
        );
        assert!(
            buf.contains(
                r#"ec2_scheduler_reconcile_total{schedule="dev-instances",result="error"} 0"#
            ),
            "missing pre-initialized reconcile_total error"
        );
    }

    #[test]
    fn test_init_for_schedule_is_idempotent() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry);

        metrics.init_for_schedule("dev-instances");
        metrics
            .reconcile_total
            .get_or_create(&ReconcileLabels {
                schedule: "dev-instances".to_string(),
                result: "error".to_string(),
            })
            .inc();

        // Second init should not reset the counter
        metrics.init_for_schedule("dev-instances");

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();
        assert!(
            buf.contains(
                r#"ec2_scheduler_reconcile_total{schedule="dev-instances",result="error"} 1"#
            ),
            "init_for_schedule should not reset existing counters"
        );
    }

    #[test]
    fn test_full_lifecycle_encoding() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry);

        let schedule = "dev-instances";

        // Actions
        metrics
            .actions_total
            .get_or_create(&ActionLabels {
                schedule: schedule.to_string(),
                action: "Start".to_string(),
                result: "success".to_string(),
            })
            .inc();

        metrics
            .actions_total
            .get_or_create(&ActionLabels {
                schedule: schedule.to_string(),
                action: "Stop".to_string(),
                result: "success".to_string(),
            })
            .inc();

        // Instances
        metrics
            .managed_instances
            .get_or_create(&InstanceLabels {
                schedule: schedule.to_string(),
                region: "ap-northeast-2".to_string(),
                state: "running".to_string(),
            })
            .set(3);

        // Reconcile
        metrics
            .reconcile_total
            .get_or_create(&ReconcileLabels {
                schedule: schedule.to_string(),
                result: "success".to_string(),
            })
            .inc();

        metrics
            .reconcile_duration_seconds
            .get_or_create(&ReconcileDurationLabels {
                schedule: schedule.to_string(),
            })
            .observe(0.042);

        // Next action
        metrics
            .next_action_seconds
            .get_or_create(&NextActionLabels {
                schedule: schedule.to_string(),
                action: "Start".to_string(),
            })
            .set(3600);

        // Schedule info
        metrics
            .schedule_info
            .get_or_create(&ScheduleInfoLabels {
                schedule: schedule.to_string(),
                timezone: "Asia/Seoul".to_string(),
                paused: "false".to_string(),
            })
            .set(1);

        // Encode and verify
        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();

        assert!(buf.contains("ec2_scheduler_actions_total"));
        assert!(buf.contains("ec2_scheduler_managed_instances"));
        assert!(buf.contains("ec2_scheduler_reconcile_total"));
        assert!(buf.contains("ec2_scheduler_reconcile_duration_seconds"));
        assert!(buf.contains("ec2_scheduler_next_action_seconds"));
        assert!(buf.contains("ec2_scheduler_schedule_info"));

        assert!(buf.contains("# TYPE ec2_scheduler_actions counter"));
        assert!(buf.contains("# TYPE ec2_scheduler_managed_instances gauge"));
        assert!(buf.contains("# TYPE ec2_scheduler_reconcile counter"));
        assert!(buf.contains("# TYPE ec2_scheduler_reconcile_duration_seconds histogram"));
        assert!(buf.contains("# TYPE ec2_scheduler_next_action_seconds gauge"));
        assert!(buf.contains("# TYPE ec2_scheduler_schedule_info gauge"));

        assert!(buf.ends_with("# EOF\n"), "missing EOF marker");
    }
}
