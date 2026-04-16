//! Prometheus metrics for the trivy-collector.

use std::sync::Arc;

use prometheus_client::encoding::EncodeLabelSet;
use prometheus_client::metrics::counter::Counter;
use prometheus_client::metrics::family::Family;
use prometheus_client::metrics::gauge::Gauge;
use prometheus_client::metrics::histogram::Histogram;
use prometheus_client::registry::Registry;

use crate::config::Mode;

// ============================================
// Label types
// ============================================

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct InfoLabels {
    pub version: String,
    pub mode: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct HttpLabels {
    pub method: String,
    pub status: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct HttpDurationLabels {
    pub method: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct ReportReceivedLabels {
    pub cluster: String,
    pub report_type: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct ReportTypeLabels {
    pub report_type: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct SendLabels {
    pub report_type: String,
    pub result: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct WatcherLabels {
    pub report_type: String,
    pub event_type: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct CleanupResultLabels {
    pub result: String,
}

// ============================================
// Histogram bucket constants
// ============================================

const HTTP_DURATION_BUCKETS: &[f64] = &[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0];

const SEND_DURATION_BUCKETS: &[f64] = &[0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0, 30.0];

// ============================================
// Metrics struct
// ============================================

/// All Prometheus metrics for trivy-collector.
///
/// Server-only and collector-only fields are wrapped in `Option`
/// so that only the relevant metrics are registered per mode.
pub struct Metrics {
    // -- Metadata --
    registered_count: usize,

    // -- Common --
    pub info: Family<InfoLabels, Gauge>,

    // -- Server mode --
    pub http_requests_total: Option<Family<HttpLabels, Counter>>,
    pub http_request_duration_seconds: Option<Family<HttpDurationLabels, Histogram>>,
    pub reports_received_total: Option<Family<ReportReceivedLabels, Counter>>,
    pub db_size_bytes: Option<Gauge>,
    pub db_reports_total: Option<Family<ReportTypeLabels, Gauge>>,
    pub api_logs_total: Option<Gauge>,
    pub api_logs_cleanup_runs_total: Option<Family<CleanupResultLabels, Counter>>,
    pub api_logs_cleanup_deleted_total: Option<Counter>,

    // -- Collector mode --
    pub reports_sent_total: Option<Family<SendLabels, Counter>>,
    pub reports_send_duration_seconds: Option<Family<ReportTypeLabels, Histogram>>,
    pub watcher_events_total: Option<Family<WatcherLabels, Counter>>,
    pub send_retries_total: Option<Family<ReportTypeLabels, Counter>>,
    pub server_up: Option<Gauge>,
}

impl Metrics {
    /// Create and register metrics based on mode.
    pub fn new(registry: &mut Registry, mode: Mode) -> Arc<Self> {
        // -- Common --
        let info = Family::<InfoLabels, Gauge>::default();
        registry.register("trivy_collector_info", "Build information", info.clone());

        // Set info gauge immediately
        info.get_or_create(&InfoLabels {
            version: env!("CARGO_PKG_VERSION").to_string(),
            mode: mode.to_string(),
        })
        .set(1);

        let mut metrics = Metrics {
            registered_count: 1, // info (always registered)
            info,
            http_requests_total: None,
            http_request_duration_seconds: None,
            reports_received_total: None,
            db_size_bytes: None,
            db_reports_total: None,
            api_logs_total: None,
            api_logs_cleanup_runs_total: None,
            api_logs_cleanup_deleted_total: None,
            reports_sent_total: None,
            reports_send_duration_seconds: None,
            watcher_events_total: None,
            send_retries_total: None,
            server_up: None,
        };

        let mode_count = match mode {
            Mode::Server => metrics.register_server(registry),
            Mode::Collector => metrics.register_collector(registry),
        };
        metrics.registered_count += mode_count;

        let metrics = Arc::new(metrics);

        match mode {
            Mode::Server => metrics.init_for_server(),
            Mode::Collector => metrics.init_for_collector(),
        }

        metrics
    }

    /// Returns the total number of registered metric families.
    pub fn count(&self) -> usize {
        self.registered_count
    }

    /// Returns the number of metrics registered for server mode.
    fn register_server(&mut self, registry: &mut Registry) -> usize {
        let mut count = 0;

        let http_requests_total = Family::<HttpLabels, Counter>::default();
        registry.register(
            "trivy_collector_http_requests",
            "Total HTTP requests",
            http_requests_total.clone(),
        );
        self.http_requests_total = Some(http_requests_total);
        count += 1;

        let http_request_duration_seconds =
            Family::<HttpDurationLabels, Histogram>::new_with_constructor(|| {
                Histogram::new(HTTP_DURATION_BUCKETS.iter().copied())
            });
        registry.register(
            "trivy_collector_http_request_duration_seconds",
            "HTTP request duration in seconds",
            http_request_duration_seconds.clone(),
        );
        self.http_request_duration_seconds = Some(http_request_duration_seconds);
        count += 1;

        let reports_received_total = Family::<ReportReceivedLabels, Counter>::default();
        registry.register(
            "trivy_collector_reports_received",
            "Total reports received from collectors",
            reports_received_total.clone(),
        );
        self.reports_received_total = Some(reports_received_total);
        count += 1;

        let db_size_bytes = Gauge::default();
        registry.register(
            "trivy_collector_db_size_bytes",
            "SQLite database file size in bytes",
            db_size_bytes.clone(),
        );
        self.db_size_bytes = Some(db_size_bytes);
        count += 1;

        let db_reports_total = Family::<ReportTypeLabels, Gauge>::default();
        registry.register(
            "trivy_collector_db_reports",
            "Total reports stored in database",
            db_reports_total.clone(),
        );
        self.db_reports_total = Some(db_reports_total);
        count += 1;

        let api_logs_total = Gauge::default();
        registry.register(
            "trivy_collector_api_logs",
            "Total API log entries in database",
            api_logs_total.clone(),
        );
        self.api_logs_total = Some(api_logs_total);
        count += 1;

        let api_logs_cleanup_runs_total = Family::<CleanupResultLabels, Counter>::default();
        registry.register(
            "trivy_collector_api_logs_cleanup_runs",
            "Total API log cleanup runs",
            api_logs_cleanup_runs_total.clone(),
        );
        self.api_logs_cleanup_runs_total = Some(api_logs_cleanup_runs_total);
        count += 1;

        let api_logs_cleanup_deleted_total = Counter::default();
        registry.register(
            "trivy_collector_api_logs_cleanup_deleted",
            "Total API log entries deleted by cleanup",
            api_logs_cleanup_deleted_total.clone(),
        );
        self.api_logs_cleanup_deleted_total = Some(api_logs_cleanup_deleted_total);
        count += 1;

        count
    }

    /// Returns the number of metrics registered for collector mode.
    fn register_collector(&mut self, registry: &mut Registry) -> usize {
        let mut count = 0;

        let reports_sent_total = Family::<SendLabels, Counter>::default();
        registry.register(
            "trivy_collector_reports_sent",
            "Total reports sent to server",
            reports_sent_total.clone(),
        );
        self.reports_sent_total = Some(reports_sent_total);
        count += 1;

        let reports_send_duration_seconds =
            Family::<ReportTypeLabels, Histogram>::new_with_constructor(|| {
                Histogram::new(SEND_DURATION_BUCKETS.iter().copied())
            });
        registry.register(
            "trivy_collector_reports_send_duration_seconds",
            "Report send duration in seconds",
            reports_send_duration_seconds.clone(),
        );
        self.reports_send_duration_seconds = Some(reports_send_duration_seconds);
        count += 1;

        let watcher_events_total = Family::<WatcherLabels, Counter>::default();
        registry.register(
            "trivy_collector_watcher_events",
            "Total Kubernetes watcher events",
            watcher_events_total.clone(),
        );
        self.watcher_events_total = Some(watcher_events_total);
        count += 1;

        let send_retries_total = Family::<ReportTypeLabels, Counter>::default();
        registry.register(
            "trivy_collector_send_retries",
            "Total report send retries",
            send_retries_total.clone(),
        );
        self.send_retries_total = Some(send_retries_total);
        count += 1;

        let server_up = Gauge::default();
        registry.register(
            "trivy_collector_server_up",
            "Central server connectivity (1=up, 0=down)",
            server_up.clone(),
        );
        self.server_up = Some(server_up);
        count += 1;

        count
    }

    /// Pre-initialize server counters to avoid No data on first scrape.
    fn init_for_server(&self) {
        if let Some(ref http) = self.http_requests_total {
            for method in &["GET", "POST", "PUT", "DELETE"] {
                for status in &["200", "400", "404", "500"] {
                    let _ = http.get_or_create(&HttpLabels {
                        method: method.to_string(),
                        status: status.to_string(),
                    });
                }
            }
        }

        if let Some(ref received) = self.reports_received_total {
            for rt in &["vulnerabilityreport", "sbomreport"] {
                let _ = received.get_or_create(&ReportReceivedLabels {
                    cluster: String::new(),
                    report_type: rt.to_string(),
                });
            }
        }

        if let Some(ref cleanup) = self.api_logs_cleanup_runs_total {
            for result in &["success", "error"] {
                let _ = cleanup.get_or_create(&CleanupResultLabels {
                    result: result.to_string(),
                });
            }
        }
    }

    /// Pre-initialize collector counters to avoid No data on first scrape.
    fn init_for_collector(&self) {
        if let Some(ref sent) = self.reports_sent_total {
            for rt in &["vulnerabilityreport", "sbomreport"] {
                for result in &["success", "error"] {
                    let _ = sent.get_or_create(&SendLabels {
                        report_type: rt.to_string(),
                        result: result.to_string(),
                    });
                }
            }
        }

        if let Some(ref events) = self.watcher_events_total {
            for rt in &["vulnerabilityreport", "sbomreport"] {
                for et in &["apply", "init_apply", "delete", "init", "init_done"] {
                    let _ = events.get_or_create(&WatcherLabels {
                        report_type: rt.to_string(),
                        event_type: et.to_string(),
                    });
                }
            }
        }

        if let Some(ref retries) = self.send_retries_total {
            for rt in &["vulnerabilityreport", "sbomreport"] {
                let _ = retries.get_or_create(&ReportTypeLabels {
                    report_type: rt.to_string(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prometheus_client::encoding::text::encode;

    #[test]
    fn test_server_metrics_registration() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry, Mode::Server);

        assert!(metrics.http_requests_total.is_some());
        assert!(metrics.reports_received_total.is_some());
        assert!(metrics.db_size_bytes.is_some());
        assert!(metrics.api_logs_total.is_some());
        // Collector-only fields should be None
        assert!(metrics.reports_sent_total.is_none());
        assert!(metrics.server_up.is_none());
    }

    #[test]
    fn test_collector_metrics_registration() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry, Mode::Collector);

        assert!(metrics.reports_sent_total.is_some());
        assert!(metrics.watcher_events_total.is_some());
        assert!(metrics.server_up.is_some());
        // Server-only fields should be None
        assert!(metrics.http_requests_total.is_none());
        assert!(metrics.db_size_bytes.is_none());
    }

    #[test]
    fn test_info_gauge_set_on_creation() {
        let mut registry = Registry::default();
        let _metrics = Metrics::new(&mut registry, Mode::Server);

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();
        assert!(buf.contains("trivy_collector_info"));
        assert!(buf.contains(env!("CARGO_PKG_VERSION")));
        assert!(buf.contains("server"));
    }

    #[test]
    fn test_server_pre_initialization() {
        let mut registry = Registry::default();
        let _metrics = Metrics::new(&mut registry, Mode::Server);

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();

        // HTTP counters should exist with 0 values
        assert!(
            buf.contains(r#"trivy_collector_http_requests_total{method="GET",status="200"} 0"#),
            "missing pre-initialized GET 200"
        );
        assert!(
            buf.contains(r#"trivy_collector_http_requests_total{method="POST",status="500"} 0"#),
            "missing pre-initialized POST 500"
        );

        // Cleanup counters should exist
        assert!(
            buf.contains(r#"trivy_collector_api_logs_cleanup_runs_total{result="success"} 0"#),
            "missing pre-initialized cleanup success"
        );
    }

    #[test]
    fn test_collector_pre_initialization() {
        let mut registry = Registry::default();
        let _metrics = Metrics::new(&mut registry, Mode::Collector);

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();

        // Send counters should exist with 0 values
        assert!(
            buf.contains(r#"trivy_collector_reports_sent_total{report_type="vulnerabilityreport",result="success"} 0"#),
            "missing pre-initialized sent success"
        );

        // Watcher events should exist
        assert!(
            buf.contains(r#"trivy_collector_watcher_events_total{report_type="vulnerabilityreport",event_type="apply"} 0"#),
            "missing pre-initialized watcher apply"
        );
    }

    #[test]
    fn test_counter_increment() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry, Mode::Server);

        metrics
            .http_requests_total
            .as_ref()
            .unwrap()
            .get_or_create(&HttpLabels {
                method: "GET".to_string(),
                status: "200".to_string(),
            })
            .inc();

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();
        assert!(
            buf.contains(r#"trivy_collector_http_requests_total{method="GET",status="200"} 1"#)
        );
    }

    #[test]
    fn test_histogram_observe() {
        let mut registry = Registry::default();
        let metrics = Metrics::new(&mut registry, Mode::Server);

        metrics
            .http_request_duration_seconds
            .as_ref()
            .unwrap()
            .get_or_create(&HttpDurationLabels {
                method: "GET".to_string(),
            })
            .observe(0.042);

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();
        assert!(buf.contains("trivy_collector_http_request_duration_seconds_count{"));
    }

    #[test]
    fn test_encoding_has_eof() {
        let mut registry = Registry::default();
        let _metrics = Metrics::new(&mut registry, Mode::Server);

        let mut buf = String::new();
        encode(&mut buf, &registry).unwrap();
        assert!(buf.ends_with("# EOF\n"), "missing EOF marker");
    }
}
