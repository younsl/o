//! Prometheus metrics for the kuo operator.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

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

/// Labels for reconcile metrics.
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct ReconcileLabels {
    pub cluster_name: String,
    pub region: String,
    pub result: String,
}

/// Labels for upgrade metrics (cluster-level).
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct UpgradeLabels {
    pub cluster_name: String,
    pub region: String,
}

/// Labels for phase metrics.
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct PhaseLabels {
    pub cluster_name: String,
    pub region: String,
    pub phase: String,
}

/// Key for tracking per-cluster phase start times.
type ClusterKey = (String, String);

/// All Prometheus metrics for the operator.
pub struct Metrics {
    pub reconcile_total: Family<ReconcileLabels, Counter>,
    pub reconcile_duration_seconds: Family<UpgradeLabels, Histogram>,
    pub upgrade_phase_info: Family<PhaseLabels, Gauge>,
    pub upgrade_completed_total: Family<UpgradeLabels, Counter>,
    pub upgrade_failed_total: Family<UpgradeLabels, Counter>,
    pub phase_transition_total: Family<PhaseLabels, Counter>,
    pub phase_duration_seconds: Family<PhaseLabels, Histogram>,
    /// In-memory tracking of when the current phase started for each cluster.
    phase_start_times: Mutex<HashMap<ClusterKey, Instant>>,
}

const RECONCILE_BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/// Buckets for phase duration (1s to 1h): phases like UpgradingControlPlane
/// or UpgradingNodeGroups can take tens of minutes.
const PHASE_DURATION_BUCKETS: &[f64] = &[
    1.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0, 1800.0, 3600.0,
];

impl Metrics {
    /// Create and register all metrics with the given registry.
    pub fn new(registry: &mut Registry) -> Self {
        let reconcile_total = Family::<ReconcileLabels, Counter>::default();
        registry.register(
            "kuo_reconcile",
            "Total number of reconcile calls",
            reconcile_total.clone(),
        );

        let reconcile_duration_seconds =
            Family::<UpgradeLabels, Histogram>::new_with_constructor(|| {
                Histogram::new(RECONCILE_BUCKETS.iter().copied())
            });
        registry.register(
            "kuo_reconcile_duration_seconds",
            "Duration of reconcile calls in seconds",
            reconcile_duration_seconds.clone(),
        );

        let upgrade_phase_info = Family::<PhaseLabels, Gauge>::default();
        registry.register(
            "kuo_upgrade_phase_info",
            "Current upgrade phase (1=active, 0=inactive)",
            upgrade_phase_info.clone(),
        );

        let upgrade_completed_total = Family::<UpgradeLabels, Counter>::default();
        registry.register(
            "kuo_upgrade_completed",
            "Total number of upgrades that reached Completed phase",
            upgrade_completed_total.clone(),
        );

        let upgrade_failed_total = Family::<UpgradeLabels, Counter>::default();
        registry.register(
            "kuo_upgrade_failed",
            "Total number of upgrades that reached Failed phase",
            upgrade_failed_total.clone(),
        );

        let phase_transition_total = Family::<PhaseLabels, Counter>::default();
        registry.register(
            "kuo_phase_transition",
            "Total number of phase transitions",
            phase_transition_total.clone(),
        );

        let phase_duration_seconds = Family::<PhaseLabels, Histogram>::new_with_constructor(|| {
            Histogram::new(PHASE_DURATION_BUCKETS.iter().copied())
        });
        registry.register(
            "kuo_phase_duration_seconds",
            "Time spent in each upgrade phase in seconds",
            phase_duration_seconds.clone(),
        );

        Self {
            reconcile_total,
            reconcile_duration_seconds,
            upgrade_phase_info,
            upgrade_completed_total,
            upgrade_failed_total,
            phase_transition_total,
            phase_duration_seconds,
            phase_start_times: Mutex::new(HashMap::new()),
        }
    }

    /// Record the start of a phase for the given cluster.
    /// Overwrites any existing entry.
    pub fn record_phase_start(&self, cluster_name: &str, region: &str) {
        let key = (cluster_name.to_string(), region.to_string());
        self.phase_start_times
            .lock()
            .unwrap()
            .insert(key, Instant::now());
    }

    /// Ensure a phase start time is tracked for the given cluster.
    /// Does nothing if an entry already exists (idempotent across reconcile loops).
    pub fn ensure_phase_start(&self, cluster_name: &str, region: &str) {
        let key = (cluster_name.to_string(), region.to_string());
        self.phase_start_times
            .lock()
            .unwrap()
            .entry(key)
            .or_insert_with(Instant::now);
    }

    /// Observe the duration of the completed phase and remove the start time entry.
    /// Returns the observed duration in seconds, or None if no start time was tracked.
    pub fn observe_phase_duration(
        &self,
        cluster_name: &str,
        region: &str,
        phase: &str,
    ) -> Option<f64> {
        let key = (cluster_name.to_string(), region.to_string());
        let start = self.phase_start_times.lock().unwrap().remove(&key)?;
        let duration = start.elapsed().as_secs_f64();
        self.phase_duration_seconds
            .get_or_create(&PhaseLabels {
                cluster_name: cluster_name.to_string(),
                region: region.to_string(),
                phase: phase.to_string(),
            })
            .observe(duration);
        Some(duration)
    }
}

/// Axum handler that encodes the registry as OpenMetrics text.
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

    let listener = TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
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

        // Increment a counter and verify no panic
        metrics
            .reconcile_total
            .get_or_create(&ReconcileLabels {
                cluster_name: "test".to_string(),
                region: "us-east-1".to_string(),
                result: "success".to_string(),
            })
            .inc();

        metrics
            .upgrade_completed_total
            .get_or_create(&UpgradeLabels {
                cluster_name: "test".to_string(),
                region: "us-east-1".to_string(),
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
                cluster_name: "my-cluster".to_string(),
                region: "ap-northeast-2".to_string(),
                result: "success".to_string(),
            })
            .inc();

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();
        assert!(buf.contains("kuo_reconcile_total"));
        assert!(buf.contains("my-cluster"));
        assert!(buf.contains("ap-northeast-2"));
    }

    #[test]
    fn test_histogram_observe() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry);

        let labels = UpgradeLabels {
            cluster_name: "test".to_string(),
            region: "us-east-1".to_string(),
        };
        metrics
            .reconcile_duration_seconds
            .get_or_create(&labels)
            .observe(0.5);

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();
        assert!(buf.contains("kuo_reconcile_duration_seconds"));
    }

    #[test]
    fn test_phase_gauge() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry);

        let labels = PhaseLabels {
            cluster_name: "test".to_string(),
            region: "us-east-1".to_string(),
            phase: "Planning".to_string(),
        };
        metrics.upgrade_phase_info.get_or_create(&labels).set(1);

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();
        assert!(buf.contains("kuo_upgrade_phase_info"));
        assert!(buf.contains("Planning"));
    }

    #[test]
    fn test_phase_duration_tracking() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry);

        // Start tracking, then observe
        metrics.record_phase_start("test-cluster", "us-east-1");
        let duration = metrics.observe_phase_duration("test-cluster", "us-east-1", "Planning");
        assert!(duration.is_some());

        // After observing, the entry is removed
        let duration = metrics.observe_phase_duration("test-cluster", "us-east-1", "Planning");
        assert!(duration.is_none());

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();
        assert!(buf.contains("kuo_phase_duration_seconds"));
    }

    #[test]
    fn test_ensure_phase_start_idempotent() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry);

        metrics.ensure_phase_start("test-cluster", "us-east-1");
        // Sleep briefly to ensure time passes
        std::thread::sleep(std::time::Duration::from_millis(10));
        // Second call should NOT overwrite the existing start time
        metrics.ensure_phase_start("test-cluster", "us-east-1");

        let duration = metrics.observe_phase_duration("test-cluster", "us-east-1", "Pending");
        assert!(duration.unwrap() >= 0.01);
    }

    /// Simulate a full upgrade lifecycle and verify all 7 metrics appear in
    /// the encoded OpenMetrics output with correct label values.
    #[test]
    fn test_full_lifecycle_encoding() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry);

        let cluster = "prod-cluster";
        let region = "ap-northeast-2";

        // --- Phase: Pending → Planning ---
        metrics.record_phase_start(cluster, region);
        std::thread::sleep(std::time::Duration::from_millis(5));
        metrics.observe_phase_duration(cluster, region, "Pending");
        metrics
            .upgrade_phase_info
            .get_or_create(&PhaseLabels {
                cluster_name: cluster.to_string(),
                region: region.to_string(),
                phase: "Pending".to_string(),
            })
            .set(0);
        metrics
            .upgrade_phase_info
            .get_or_create(&PhaseLabels {
                cluster_name: cluster.to_string(),
                region: region.to_string(),
                phase: "Planning".to_string(),
            })
            .set(1);
        metrics
            .phase_transition_total
            .get_or_create(&PhaseLabels {
                cluster_name: cluster.to_string(),
                region: region.to_string(),
                phase: "Planning".to_string(),
            })
            .inc();
        metrics.record_phase_start(cluster, region);

        // --- Reconcile metrics ---
        metrics
            .reconcile_total
            .get_or_create(&ReconcileLabels {
                cluster_name: cluster.to_string(),
                region: region.to_string(),
                result: "requeue".to_string(),
            })
            .inc();
        metrics
            .reconcile_total
            .get_or_create(&ReconcileLabels {
                cluster_name: cluster.to_string(),
                region: region.to_string(),
                result: "success".to_string(),
            })
            .inc();
        metrics
            .reconcile_total
            .get_or_create(&ReconcileLabels {
                cluster_name: cluster.to_string(),
                region: region.to_string(),
                result: "error".to_string(),
            })
            .inc();
        metrics
            .reconcile_duration_seconds
            .get_or_create(&UpgradeLabels {
                cluster_name: cluster.to_string(),
                region: region.to_string(),
            })
            .observe(0.042);

        // --- Terminal phase ---
        metrics
            .upgrade_completed_total
            .get_or_create(&UpgradeLabels {
                cluster_name: cluster.to_string(),
                region: region.to_string(),
            })
            .inc();
        metrics
            .upgrade_failed_total
            .get_or_create(&UpgradeLabels {
                cluster_name: cluster.to_string(),
                region: region.to_string(),
            })
            .inc();

        // --- Encode and verify ---
        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();

        // Print full output for debugging (visible with `cargo test -- --nocapture`)
        println!("--- OpenMetrics output ---\n{buf}--- end ---");

        // 1) kuo_reconcile_total — 3 result variants
        assert!(
            buf.contains(r#"kuo_reconcile_total{cluster_name="prod-cluster",region="ap-northeast-2",result="requeue"} 1"#),
            "missing reconcile_total requeue"
        );
        assert!(
            buf.contains(r#"kuo_reconcile_total{cluster_name="prod-cluster",region="ap-northeast-2",result="success"} 1"#),
            "missing reconcile_total success"
        );
        assert!(
            buf.contains(r#"kuo_reconcile_total{cluster_name="prod-cluster",region="ap-northeast-2",result="error"} 1"#),
            "missing reconcile_total error"
        );

        // 2) kuo_reconcile_duration_seconds — histogram with _bucket, _count, _sum
        assert!(
            buf.contains("kuo_reconcile_duration_seconds_bucket{"),
            "missing reconcile_duration_seconds bucket"
        );
        assert!(
            buf.contains("kuo_reconcile_duration_seconds_count{"),
            "missing reconcile_duration_seconds count"
        );
        assert!(
            buf.contains("kuo_reconcile_duration_seconds_sum{"),
            "missing reconcile_duration_seconds sum"
        );

        // 3) kuo_phase_duration_seconds — histogram
        assert!(
            buf.contains("kuo_phase_duration_seconds_bucket{"),
            "missing phase_duration_seconds bucket"
        );
        assert!(
            buf.contains(r#"phase="Pending"#),
            "missing Pending phase label in phase_duration"
        );

        // 4) kuo_upgrade_phase_info — gauge with active=1 and inactive=0
        assert!(
            buf.contains(r#"kuo_upgrade_phase_info{cluster_name="prod-cluster",region="ap-northeast-2",phase="Planning"} 1"#),
            "missing phase_info Planning=1"
        );
        assert!(
            buf.contains(r#"kuo_upgrade_phase_info{cluster_name="prod-cluster",region="ap-northeast-2",phase="Pending"} 0"#),
            "missing phase_info Pending=0"
        );

        // 5) kuo_phase_transition_total
        assert!(
            buf.contains(r#"kuo_phase_transition_total{cluster_name="prod-cluster",region="ap-northeast-2",phase="Planning"} 1"#),
            "missing phase_transition_total"
        );

        // 6) kuo_upgrade_completed_total
        assert!(
            buf.contains(r#"kuo_upgrade_completed_total{cluster_name="prod-cluster",region="ap-northeast-2"} 1"#),
            "missing upgrade_completed_total"
        );

        // 7) kuo_upgrade_failed_total
        assert!(
            buf.contains(
                r#"kuo_upgrade_failed_total{cluster_name="prod-cluster",region="ap-northeast-2"} 1"#
            ),
            "missing upgrade_failed_total"
        );

        // Verify TYPE declarations exist for all 7 metric families.
        // OpenMetrics convention: counter TYPE uses base name (without _total suffix),
        // while data lines include _total suffix.
        assert!(buf.contains("# TYPE kuo_reconcile counter"));
        assert!(buf.contains("# TYPE kuo_reconcile_duration_seconds histogram"));
        assert!(buf.contains("# TYPE kuo_upgrade_phase_info gauge"));
        assert!(buf.contains("# TYPE kuo_upgrade_completed counter"));
        assert!(buf.contains("# TYPE kuo_upgrade_failed counter"));
        assert!(buf.contains("# TYPE kuo_phase_transition counter"));
        assert!(buf.contains("# TYPE kuo_phase_duration_seconds histogram"));

        // Verify HELP descriptions exist
        assert!(buf.contains("# HELP kuo_reconcile "));
        assert!(buf.contains("# HELP kuo_reconcile_duration_seconds "));
        assert!(buf.contains("# HELP kuo_upgrade_phase_info "));
        assert!(buf.contains("# HELP kuo_upgrade_completed "));
        assert!(buf.contains("# HELP kuo_upgrade_failed "));
        assert!(buf.contains("# HELP kuo_phase_transition "));
        assert!(buf.contains("# HELP kuo_phase_duration_seconds "));

        // Verify EOF marker (OpenMetrics requirement)
        assert!(buf.ends_with("# EOF\n"), "missing EOF marker");
    }
}
