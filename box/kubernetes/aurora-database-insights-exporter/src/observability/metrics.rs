use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use prometheus::{CounterVec, Gauge, GaugeVec, Opts, Registry, TextEncoder, core::Collector};

use crate::error::Result;
use crate::types::{InstanceLabels, MetricSnapshot, tag_key_to_label};

/// Stable PI API name labels used for `pi_api_errors_total{api=...}`.
pub const API_GET_RESOURCE_METRICS: &str = "GetResourceMetrics";
pub const API_DESCRIBE_DIMENSION_KEYS: &str = "DescribeDimensionKeys";
pub const API_GET_DIMENSION_KEY_DETAILS: &str = "GetDimensionKeyDetails";

/// Every value the `api` label can take. Used to purge counter series for removed instances.
const PI_API_NAMES: [&str; 3] = [
    API_GET_RESOURCE_METRICS,
    API_DESCRIBE_DIMENSION_KEYS,
    API_GET_DIMENSION_KEY_DETAILS,
];

/// Every value `classify_pi_error` can return. Kept in sync by `test_error_kinds_are_enumerated`.
const PI_ERROR_KINDS: [&str; 6] = [
    "throttle",
    "auth",
    "timeout",
    "not_found",
    "validation",
    "other",
];

/// A `GaugeVec` that remembers which label sets are live for each instance.
///
/// Breakdown series (wait events, top SQL, hosts, ...) change from cycle to cycle, so stale
/// combinations must be deleted. Prometheus has no partial-label removal, and scanning
/// `collect()` to find them clones every series in the vector on every instance of every
/// cycle. Tracking what was emitted turns that scan into a set difference.
pub struct TrackedGaugeVec {
    gauge: GaugeVec,
    /// resource_id -> label value tuples currently set on `gauge`.
    active: Mutex<HashMap<String, HashSet<Vec<String>>>>,
}

impl TrackedGaugeVec {
    fn new(opts: Opts, label_names: &[&str]) -> Result<Self> {
        Ok(Self {
            gauge: GaugeVec::new(opts, label_names)?,
            active: Mutex::new(HashMap::new()),
        })
    }

    fn collector(&self) -> Box<dyn Collector> {
        Box::new(self.gauge.clone())
    }

    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<String, HashSet<Vec<String>>>> {
        self.active.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Set `entries` for `key` and delete the series that key had last time but no longer does.
    fn replace(&self, key: &str, entries: Vec<(Vec<String>, f64)>) {
        let mut next: HashSet<Vec<String>> = HashSet::with_capacity(entries.len());
        for (values, value) in entries {
            let refs: Vec<&str> = values.iter().map(String::as_str).collect();
            self.gauge.with_label_values(&refs).set(value);
            next.insert(values);
        }

        let mut active = self.active();
        if let Some(previous) = active.get(key) {
            for stale in previous.difference(&next) {
                let refs: Vec<&str> = stale.iter().map(String::as_str).collect();
                let _ = self.gauge.remove_label_values(&refs);
            }
        }

        if next.is_empty() {
            active.remove(key);
        } else {
            active.insert(key.to_string(), next);
        }
    }

    /// Delete every series recorded for `key`.
    fn clear(&self, key: &str) {
        let Some(previous) = self.active().remove(key) else {
            return;
        };
        for values in &previous {
            let refs: Vec<&str> = values.iter().map(String::as_str).collect();
            let _ = self.gauge.remove_label_values(&refs);
        }
    }

    #[cfg(test)]
    fn gauge(&self) -> &GaugeVec {
        &self.gauge
    }
}

/// Render a bool as a stable Prometheus label value.
fn bool_label(b: bool) -> &'static str {
    if b { "true" } else { "false" }
}

/// Build instance label names: 5 base + N exported tag labels.
fn build_instance_label_names(exported_tags: &[String]) -> Vec<String> {
    let mut names = vec![
        "instance".to_string(),
        "resource_id".to_string(),
        "engine".to_string(),
        "region".to_string(),
        "db_cluster".to_string(),
    ];
    for tag_key in exported_tags {
        names.push(tag_key_to_label(tag_key));
    }
    names
}

/// All Prometheus metrics for adie.
pub struct Metrics {
    pub registry: Registry,
    pub registered_count: usize,

    // Instance-level (static)
    pub db_load: GaugeVec,
    pub db_load_cpu: GaugeVec,
    pub db_load_non_cpu: GaugeVec,
    pub vcpu: GaugeVec,
    pub up: GaugeVec,

    // Breakdown (dynamic, cycle reset)
    pub db_load_by_wait_event: TrackedGaugeVec,
    pub db_load_by_sql_tokenized: TrackedGaugeVec,
    pub sql_tokenized_info: TrackedGaugeVec,
    pub sql_tokenized_calls_per_sec: TrackedGaugeVec,
    pub sql_tokenized_avg_latency_per_call: TrackedGaugeVec,
    pub sql_tokenized_rows_per_call: TrackedGaugeVec,
    pub db_load_by_sql: TrackedGaugeVec,
    pub sql_info: TrackedGaugeVec,
    pub db_load_by_user: TrackedGaugeVec,
    pub db_load_by_host: TrackedGaugeVec,
    pub db_load_by_database: TrackedGaugeVec,

    // Exporter internal
    pub scrape_duration_seconds: Gauge,
    pub discovery_instances_total: Gauge,
    pub collection_errors_total: CounterVec,
    pub discovery_duration_seconds: Gauge,
    pub last_success_timestamp_seconds: GaugeVec,
    pub pi_api_errors_total: CounterVec,
}

/// Classify a raw PI API error message into a stable `error_kind` label value.
///
/// Keeps cardinality bounded to a fixed set regardless of SDK error text variations.
pub fn classify_pi_error(msg: &str) -> &'static str {
    let m = msg.to_ascii_lowercase();
    if m.contains("throttl") || m.contains("rate exceeded") || m.contains("toomanyrequests") {
        "throttle"
    } else if m.contains("accessdenied")
        || m.contains("unauthorized")
        || m.contains("not authorized")
        || m.contains("forbidden")
    {
        "auth"
    } else if m.contains("timeout") || m.contains("timed out") || m.contains("deadline") {
        "timeout"
    } else if m.contains("notfound") || m.contains("not found") {
        "not_found"
    } else if m.contains("validation") || m.contains("invalidparameter") {
        "validation"
    } else {
        "other"
    }
}

impl Metrics {
    pub fn new(exported_tags: &[String]) -> Result<Self> {
        let registry = Registry::new();

        let inst_labels = build_instance_label_names(exported_tags);
        let inst_label_refs: Vec<&str> = inst_labels.iter().map(|s| s.as_str()).collect();

        // Breakdown labels: instance labels + extra dimension labels
        let wait_event_labels = {
            let mut v = inst_labels.clone();
            v.push("wait_event".to_string());
            v.push("wait_event_type".to_string());
            v
        };
        let we_refs: Vec<&str> = wait_event_labels.iter().map(|s| s.as_str()).collect();

        let sql_tokenized_labels = {
            let mut v = inst_labels.clone();
            v.push("sql_tokenized_id".to_string());
            v
        };
        let st_refs: Vec<&str> = sql_tokenized_labels.iter().map(|s| s.as_str()).collect();

        let sql_tokenized_info_labels = {
            let mut v = inst_labels.clone();
            v.extend([
                "sql_tokenized_id".to_string(),
                "sql_tokenized_text".to_string(),
                "sql_tokenized_text_truncated".to_string(),
            ]);
            v
        };
        let sti_refs: Vec<&str> = sql_tokenized_info_labels
            .iter()
            .map(|s| s.as_str())
            .collect();

        let sql_labels = {
            let mut v = inst_labels.clone();
            v.push("sql_id".to_string());
            v
        };
        let sql_refs: Vec<&str> = sql_labels.iter().map(|s| s.as_str()).collect();

        let user_labels = {
            let mut v = inst_labels.clone();
            v.push("db_user".to_string());
            v
        };
        let user_refs: Vec<&str> = user_labels.iter().map(|s| s.as_str()).collect();

        let host_labels = {
            let mut v = inst_labels.clone();
            v.push("client_host".to_string());
            v
        };
        let host_refs: Vec<&str> = host_labels.iter().map(|s| s.as_str()).collect();

        let db_labels = {
            let mut v = inst_labels.clone();
            v.push("db_name".to_string());
            v
        };
        let db_refs: Vec<&str> = db_labels.iter().map(|s| s.as_str()).collect();

        let sql_info_labels = {
            let mut v = inst_labels.clone();
            v.extend([
                "sql_id".to_string(),
                "sql_text".to_string(),
                "sql_full_text".to_string(),
                "sql_text_truncated".to_string(),
            ]);
            v
        };
        let si_refs: Vec<&str> = sql_info_labels.iter().map(|s| s.as_str()).collect();

        let db_load = GaugeVec::new(
            Opts::new(
                "aurora_dbinsights_db_load",
                "DB Load (Average Active Sessions)",
            ),
            &inst_label_refs,
        )?;

        let db_load_cpu = GaugeVec::new(
            Opts::new("aurora_dbinsights_db_load_cpu", "CPU-attributed DB Load"),
            &inst_label_refs,
        )?;

        let db_load_non_cpu = GaugeVec::new(
            Opts::new("aurora_dbinsights_db_load_non_cpu", "Non-CPU DB Load"),
            &inst_label_refs,
        )?;

        let vcpu = GaugeVec::new(
            Opts::new("aurora_dbinsights_vcpu", "Number of vCPUs"),
            &inst_label_refs,
        )?;

        let up = GaugeVec::new(
            Opts::new(
                "aurora_dbinsights_up",
                "Whether metrics collection succeeded (1=ok, 0=error)",
            ),
            &inst_label_refs,
        )?;

        let db_load_by_wait_event = TrackedGaugeVec::new(
            Opts::new(
                "aurora_dbinsights_db_load_by_wait_event",
                "DB Load by wait event",
            ),
            &we_refs,
        )?;

        let db_load_by_sql_tokenized = TrackedGaugeVec::new(
            Opts::new(
                "aurora_dbinsights_db_load_by_sql_tokenized",
                "DB Load by top tokenized SQL pattern",
            ),
            &st_refs,
        )?;

        let sql_tokenized_info = TrackedGaugeVec::new(
            Opts::new(
                "aurora_dbinsights_sql_tokenized_info",
                "Tokenized SQL text info metric (value always 1)",
            ),
            &sti_refs,
        )?;

        let sql_tokenized_calls_per_sec = TrackedGaugeVec::new(
            Opts::new(
                "aurora_dbinsights_sql_tokenized_calls_per_sec",
                "Calls per second for top tokenized SQL (Aurora PostgreSQL only, from pg_stat_statements)",
            ),
            &st_refs,
        )?;

        let sql_tokenized_avg_latency_per_call = TrackedGaugeVec::new(
            Opts::new(
                "aurora_dbinsights_sql_tokenized_avg_latency_per_call",
                "Average latency per call in ms for top tokenized SQL (Aurora PostgreSQL only, from pg_stat_statements)",
            ),
            &st_refs,
        )?;

        let sql_tokenized_rows_per_call = TrackedGaugeVec::new(
            Opts::new(
                "aurora_dbinsights_sql_tokenized_rows_per_call",
                "Average rows per call for top tokenized SQL (Aurora PostgreSQL only, from pg_stat_statements)",
            ),
            &st_refs,
        )?;

        let db_load_by_sql = TrackedGaugeVec::new(
            Opts::new(
                "aurora_dbinsights_db_load_by_sql",
                "DB Load by top SQL (actual statements)",
            ),
            &sql_refs,
        )?;

        let db_load_by_user = TrackedGaugeVec::new(
            Opts::new(
                "aurora_dbinsights_db_load_by_user",
                "DB Load by database user",
            ),
            &user_refs,
        )?;

        let db_load_by_host = TrackedGaugeVec::new(
            Opts::new(
                "aurora_dbinsights_db_load_by_host",
                "DB Load by client host",
            ),
            &host_refs,
        )?;

        let db_load_by_database = TrackedGaugeVec::new(
            Opts::new(
                "aurora_dbinsights_db_load_by_database",
                "DB Load by database schema",
            ),
            &db_refs,
        )?;

        let sql_info = TrackedGaugeVec::new(
            Opts::new(
                "aurora_dbinsights_sql_info",
                "SQL text info metric (value always 1). sql_full_text is capped at 1024 bytes",
            ),
            &si_refs,
        )?;

        let scrape_duration_seconds = Gauge::new(
            "aurora_dbinsights_scrape_duration_seconds",
            "Duration of the last collection cycle in seconds",
        )?;

        let discovery_instances_total = Gauge::new(
            "aurora_dbinsights_discovery_instances_total",
            "Number of currently discovered Aurora instances",
        )?;

        let collection_errors_total = CounterVec::new(
            Opts::new(
                "aurora_dbinsights_collection_errors_total",
                "Total number of PI API collection errors",
            ),
            &["instance"],
        )?;

        let discovery_duration_seconds = Gauge::new(
            "aurora_dbinsights_discovery_duration_seconds",
            "Duration of the last discovery cycle in seconds",
        )?;

        let last_success_timestamp_seconds = GaugeVec::new(
            Opts::new(
                "aurora_dbinsights_last_success_timestamp_seconds",
                "Unix timestamp (seconds) of the last successful metric collection per instance",
            ),
            &inst_label_refs,
        )?;

        let pi_api_errors_total = CounterVec::new(
            Opts::new(
                "aurora_dbinsights_pi_api_errors_total",
                "Total Performance Insights API call errors, labeled by API and error kind",
            ),
            &["instance", "api", "error_kind"],
        )?;

        // Register all metrics
        let collectors: Vec<Box<dyn Collector>> = vec![
            Box::new(db_load.clone()),
            Box::new(db_load_cpu.clone()),
            Box::new(db_load_non_cpu.clone()),
            Box::new(vcpu.clone()),
            Box::new(up.clone()),
            db_load_by_wait_event.collector(),
            db_load_by_sql_tokenized.collector(),
            sql_tokenized_info.collector(),
            sql_tokenized_calls_per_sec.collector(),
            sql_tokenized_avg_latency_per_call.collector(),
            sql_tokenized_rows_per_call.collector(),
            db_load_by_sql.collector(),
            sql_info.collector(),
            db_load_by_user.collector(),
            db_load_by_host.collector(),
            db_load_by_database.collector(),
            Box::new(scrape_duration_seconds.clone()),
            Box::new(discovery_instances_total.clone()),
            Box::new(collection_errors_total.clone()),
            Box::new(discovery_duration_seconds.clone()),
            Box::new(last_success_timestamp_seconds.clone()),
            Box::new(pi_api_errors_total.clone()),
        ];

        let registered_count = collectors.len();
        for c in collectors {
            registry.register(c)?;
        }

        Ok(Self {
            registered_count,
            registry,
            db_load,
            db_load_cpu,
            db_load_non_cpu,
            vcpu,
            up,
            db_load_by_wait_event,
            db_load_by_sql_tokenized,
            sql_tokenized_info,
            sql_tokenized_calls_per_sec,
            sql_tokenized_avg_latency_per_call,
            sql_tokenized_rows_per_call,
            db_load_by_sql,
            sql_info,
            db_load_by_user,
            db_load_by_host,
            db_load_by_database,
            scrape_duration_seconds,
            discovery_instances_total,
            collection_errors_total,
            discovery_duration_seconds,
            last_success_timestamp_seconds,
            pi_api_errors_total,
        })
    }

    /// Delete every breakdown series belonging to an instance.
    pub fn clear_dynamic_series(&self, resource_id: &str) {
        self.db_load_by_wait_event.clear(resource_id);
        self.db_load_by_sql_tokenized.clear(resource_id);
        self.sql_tokenized_info.clear(resource_id);
        self.sql_tokenized_calls_per_sec.clear(resource_id);
        self.sql_tokenized_avg_latency_per_call.clear(resource_id);
        self.sql_tokenized_rows_per_call.clear(resource_id);
        self.db_load_by_sql.clear(resource_id);
        self.sql_info.clear(resource_id);
        self.db_load_by_user.clear(resource_id);
        self.db_load_by_host.clear(resource_id);
        self.db_load_by_database.clear(resource_id);
    }

    /// Apply a MetricSnapshot to the Prometheus registry.
    pub fn apply_snapshot(&self, snapshot: &MetricSnapshot) {
        let base = snapshot.labels.as_vec();
        let key = snapshot.labels.resource_id.as_str();

        // Touch error counter to ensure it exists with value 0 for this instance (prevents No Data in alerting)
        let _ = self
            .collection_errors_total
            .with_label_values(&[&snapshot.labels.instance]);

        // Instance-level metrics
        self.db_load.with_label_values(&base).set(snapshot.db_load);
        self.db_load_cpu
            .with_label_values(&base)
            .set(snapshot.db_load_cpu);
        self.db_load_non_cpu
            .with_label_values(&base)
            .set(snapshot.db_load_non_cpu);
        self.vcpu
            .with_label_values(&base)
            .set(f64::from(snapshot.vcpu));
        self.up.with_label_values(&base).set(1.0);

        let now_ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        self.last_success_timestamp_seconds
            .with_label_values(&base)
            .set(now_ts);

        // Breakdown metrics: each `replace` sets the new series and drops the ones this
        // instance emitted last cycle but not this one.
        let with_extra = |extra: &[&str]| -> Vec<String> {
            let mut v = Vec::with_capacity(base.len() + extra.len());
            v.extend(base.iter().map(|s| (*s).to_string()));
            v.extend(extra.iter().map(|s| (*s).to_string()));
            v
        };

        self.db_load_by_wait_event.replace(
            key,
            snapshot
                .wait_events
                .iter()
                .map(|we| (with_extra(&[&we.wait_event, &we.wait_event_type]), we.value))
                .collect(),
        );

        self.db_load_by_sql_tokenized.replace(
            key,
            snapshot
                .top_sql_tokenized
                .iter()
                .map(|st| (with_extra(&[&st.sql_tokenized_id]), st.value))
                .collect(),
        );

        self.sql_tokenized_info.replace(
            key,
            snapshot
                .top_sql_tokenized
                .iter()
                .map(|st| {
                    (
                        with_extra(&[
                            &st.sql_tokenized_id,
                            &st.sql_tokenized_text,
                            bool_label(st.sql_tokenized_text_truncated),
                        ]),
                        1.0,
                    )
                })
                .collect(),
        );

        // AdditionalMetrics (Aurora PostgreSQL only)
        self.sql_tokenized_calls_per_sec.replace(
            key,
            snapshot
                .top_sql_tokenized
                .iter()
                .filter_map(|st| {
                    st.calls_per_sec
                        .map(|v| (with_extra(&[&st.sql_tokenized_id]), v))
                })
                .collect(),
        );

        self.sql_tokenized_avg_latency_per_call.replace(
            key,
            snapshot
                .top_sql_tokenized
                .iter()
                .filter_map(|st| {
                    st.avg_latency_per_call
                        .map(|v| (with_extra(&[&st.sql_tokenized_id]), v))
                })
                .collect(),
        );

        self.sql_tokenized_rows_per_call.replace(
            key,
            snapshot
                .top_sql_tokenized
                .iter()
                .filter_map(|st| {
                    st.rows_per_call
                        .map(|v| (with_extra(&[&st.sql_tokenized_id]), v))
                })
                .collect(),
        );

        self.db_load_by_sql.replace(
            key,
            snapshot
                .top_sql
                .iter()
                .map(|sql| (with_extra(&[&sql.sql_id]), sql.value))
                .collect(),
        );

        self.sql_info.replace(
            key,
            snapshot
                .top_sql
                .iter()
                .map(|sql| {
                    (
                        with_extra(&[
                            &sql.sql_id,
                            &sql.sql_text,
                            &sql.sql_full_text,
                            bool_label(sql.sql_text_truncated),
                        ]),
                        1.0,
                    )
                })
                .collect(),
        );

        self.db_load_by_user.replace(
            key,
            snapshot
                .users
                .iter()
                .map(|u| (with_extra(&[&u.db_user]), u.value))
                .collect(),
        );

        self.db_load_by_host.replace(
            key,
            snapshot
                .hosts
                .iter()
                .map(|h| (with_extra(&[&h.client_host]), h.value))
                .collect(),
        );

        self.db_load_by_database.replace(
            key,
            snapshot
                .databases
                .iter()
                .map(|d| (with_extra(&[&d.db_name]), d.value))
                .collect(),
        );
    }

    /// Mark an instance as down (up=0) when collection fails.
    pub fn mark_instance_down(&self, labels: &InstanceLabels) {
        let base = labels.as_vec();
        self.up.with_label_values(&base).set(0.0);
        self.collection_errors_total
            .with_label_values(&[&labels.instance])
            .inc();
    }

    /// Remove all metrics for an instance that is no longer discovered.
    pub fn remove_instance(&self, labels: &InstanceLabels) {
        let base = labels.as_vec();
        let _ = self.db_load.remove_label_values(&base);
        let _ = self.db_load_cpu.remove_label_values(&base);
        let _ = self.db_load_non_cpu.remove_label_values(&base);
        let _ = self.vcpu.remove_label_values(&base);
        let _ = self.up.remove_label_values(&base);
        let _ = self
            .last_success_timestamp_seconds
            .remove_label_values(&base);
        self.clear_dynamic_series(&labels.resource_id);

        // Counters are keyed by instance name, which the gauge cleanup above does not cover.
        // Without this they outlive the instance forever, and identifiers churn on every
        // blue/green swap or instance replacement.
        let _ = self
            .collection_errors_total
            .remove_label_values(&[&labels.instance]);
        for api in PI_API_NAMES {
            for kind in PI_ERROR_KINDS {
                let _ =
                    self.pi_api_errors_total
                        .remove_label_values(&[&labels.instance, api, kind]);
            }
        }
    }

    /// Classify and record a PI API call error. Called at each API-level failure point.
    pub fn record_pi_api_error(&self, instance: &str, api: &str, err_msg: &str) {
        let kind = classify_pi_error(err_msg);
        self.pi_api_errors_total
            .with_label_values(&[instance, api, kind])
            .inc();
    }

    /// Encode all metrics as Prometheus text format.
    pub fn encode(&self) -> String {
        let encoder = TextEncoder::new();
        let metric_families = self.registry.gather();
        encoder
            .encode_to_string(&metric_families)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;

    fn test_labels() -> InstanceLabels {
        InstanceLabels {
            instance: "test-writer".to_string(),
            resource_id: "db-TEST123".to_string(),
            engine: "aurora-mysql".to_string(),
            region: "ap-northeast-2".to_string(),
            cluster: "test-cluster".to_string(),
            tag_values: vec![],
        }
    }

    fn test_snapshot() -> MetricSnapshot {
        MetricSnapshot {
            labels: test_labels(),
            db_load: 2.5,
            db_load_cpu: 1.0,
            db_load_non_cpu: 1.5,
            vcpu: 4,
            wait_events: vec![
                WaitEventMetric {
                    wait_event: "cpu".to_string(),
                    wait_event_type: "CPU".to_string(),
                    value: 1.0,
                },
                WaitEventMetric {
                    wait_event: "io/table/sql/handler".to_string(),
                    wait_event_type: "IO".to_string(),
                    value: 0.8,
                },
            ],
            top_sql_tokenized: vec![SqlTokenizedMetric {
                sql_tokenized_id: "SQLTOK123".to_string(),
                sql_tokenized_text: "SELECT * FROM orders WHERE user_id = ?".to_string(),
                sql_tokenized_text_truncated: false,
                value: 1.5,
                calls_per_sec: None,
                avg_latency_per_call: None,
                rows_per_call: None,
            }],
            top_sql: vec![SqlMetric {
                sql_id: "SQL123".to_string(),
                sql_text: "SELECT * FROM orders WHERE user_id = 42".to_string(),
                sql_full_text: "SELECT * FROM orders WHERE user_id = 42".to_string(),
                sql_text_truncated: false,
                value: 1.5,
            }],
            users: vec![UserMetric {
                db_user: "app_user".to_string(),
                value: 2.0,
            }],
            hosts: vec![HostMetric {
                client_host: "10.0.1.100".to_string(),
                value: 1.8,
            }],
            databases: vec![DatabaseMetric {
                db_name: "orders_db".to_string(),
                value: 2.0,
            }],
        }
    }

    #[test]
    fn test_metrics_new_no_tags() {
        let m = Metrics::new(&[]).unwrap();
        let output = m.encode();
        assert!(output.is_empty() || !output.contains("aurora_dbinsights_db_load{"));
    }

    #[test]
    fn test_metrics_new_with_exported_tags() {
        let tags = vec!["Team".to_string(), "Environment".to_string()];
        let m = Metrics::new(&tags).unwrap();
        // GaugeVec should be created with tag_team, tag_environment labels
        let descs = m.db_load.desc();
        let label_names: Vec<&str> = descs[0]
            .variable_labels
            .iter()
            .map(|l| l.as_str())
            .collect();
        assert!(label_names.contains(&"tag_team"));
        assert!(label_names.contains(&"tag_environment"));
    }

    #[test]
    fn test_apply_snapshot() {
        let m = Metrics::new(&[]).unwrap();
        let snap = test_snapshot();
        m.apply_snapshot(&snap);

        let output = m.encode();
        assert!(output.contains("aurora_dbinsights_db_load{"));
        assert!(output.contains("aurora_dbinsights_db_load_cpu{"));
        assert!(output.contains("aurora_dbinsights_db_load_non_cpu{"));
        assert!(output.contains("aurora_dbinsights_vcpu{"));
        assert!(output.contains("aurora_dbinsights_up{"));
        assert!(output.contains("aurora_dbinsights_db_load_by_wait_event{"));
        assert!(output.contains("aurora_dbinsights_db_load_by_sql_tokenized{"));
        assert!(output.contains("aurora_dbinsights_sql_tokenized_info{"));
        assert!(output.contains("aurora_dbinsights_db_load_by_sql{"));
        assert!(output.contains("aurora_dbinsights_sql_info{"));
        assert!(output.contains("aurora_dbinsights_db_load_by_user{"));
        assert!(output.contains("aurora_dbinsights_db_load_by_host{"));
    }

    #[test]
    fn test_apply_snapshot_values() {
        let m = Metrics::new(&[]).unwrap();
        let snap = test_snapshot();
        m.apply_snapshot(&snap);

        let base = snap.labels.as_vec();
        assert_eq!(m.db_load.with_label_values(&base).get(), 2.5);
        assert_eq!(m.db_load_cpu.with_label_values(&base).get(), 1.0);
        assert_eq!(m.db_load_non_cpu.with_label_values(&base).get(), 1.5);
        assert_eq!(m.vcpu.with_label_values(&base).get(), 4.0);
        assert_eq!(m.up.with_label_values(&base).get(), 1.0);

        // last_success_timestamp_seconds must be populated with a plausible epoch value.
        let ts = m
            .last_success_timestamp_seconds
            .with_label_values(&base)
            .get();
        assert!(ts > 1_700_000_000.0, "timestamp not populated: {ts}");
    }

    #[test]
    fn test_classify_pi_error_kinds() {
        assert_eq!(
            classify_pi_error("ThrottlingException: Rate exceeded"),
            "throttle"
        );
        assert_eq!(classify_pi_error("TooManyRequestsException"), "throttle");
        assert_eq!(classify_pi_error("AccessDeniedException"), "auth");
        assert_eq!(classify_pi_error("User is not authorized"), "auth");
        assert_eq!(classify_pi_error("operation timed out"), "timeout");
        assert_eq!(classify_pi_error("deadline exceeded"), "timeout");
        assert_eq!(classify_pi_error("ResourceNotFoundException"), "not_found");
        assert_eq!(
            classify_pi_error("ValidationException: bad period"),
            "validation"
        );
        assert_eq!(classify_pi_error("unexpected SDK error"), "other");
    }

    #[test]
    fn test_record_pi_api_error_increments_counter() {
        let m = Metrics::new(&[]).unwrap();
        m.record_pi_api_error("test-writer", "GetResourceMetrics", "ThrottlingException");
        m.record_pi_api_error("test-writer", "GetResourceMetrics", "ThrottlingException");
        m.record_pi_api_error(
            "test-writer",
            "DescribeDimensionKeys",
            "AccessDeniedException",
        );

        let throttle = m
            .pi_api_errors_total
            .with_label_values(&["test-writer", "GetResourceMetrics", "throttle"])
            .get();
        assert_eq!(throttle, 2.0);

        let auth = m
            .pi_api_errors_total
            .with_label_values(&["test-writer", "DescribeDimensionKeys", "auth"])
            .get();
        assert_eq!(auth, 1.0);
    }

    #[test]
    fn test_remove_instance_clears_last_success_timestamp() {
        let m = Metrics::new(&[]).unwrap();
        let snap = test_snapshot();
        m.apply_snapshot(&snap);
        assert!(
            m.encode()
                .contains("aurora_dbinsights_last_success_timestamp_seconds{")
        );

        m.remove_instance(&snap.labels);
        assert!(
            !m.encode()
                .contains("aurora_dbinsights_last_success_timestamp_seconds{")
        );
    }

    #[test]
    fn test_apply_snapshot_with_exported_tags() {
        let tags = vec!["Team".to_string()];
        let m = Metrics::new(&tags).unwrap();

        let mut snap = test_snapshot();
        snap.labels.tag_values = vec!["platform".to_string()];
        m.apply_snapshot(&snap);

        let output = m.encode();
        assert!(output.contains("tag_team=\"platform\""));
    }

    #[test]
    fn test_mark_instance_down() {
        let m = Metrics::new(&[]).unwrap();
        let labels = test_labels();

        m.up.with_label_values(&labels.as_vec()).set(1.0);
        m.mark_instance_down(&labels);
        assert_eq!(m.up.with_label_values(&labels.as_vec()).get(), 0.0);

        let err_count = m
            .collection_errors_total
            .with_label_values(&[&labels.instance])
            .get();
        assert_eq!(err_count, 1.0);
    }

    #[test]
    fn test_remove_instance() {
        let m = Metrics::new(&[]).unwrap();
        let snap = test_snapshot();
        m.apply_snapshot(&snap);

        let output = m.encode();
        assert!(output.contains("test-writer"));

        m.remove_instance(&snap.labels);
        let output = m.encode();
        assert!(!output.contains("aurora_dbinsights_db_load{"));
    }

    #[test]
    fn test_cycle_reset_removes_old_dynamic_labels() {
        let m = Metrics::new(&[]).unwrap();

        let mut snap = test_snapshot();
        snap.hosts = vec![HostMetric {
            client_host: "10.0.1.100".to_string(),
            value: 1.0,
        }];
        m.apply_snapshot(&snap);
        assert!(m.encode().contains("10.0.1.100"));

        snap.hosts = vec![HostMetric {
            client_host: "10.0.2.200".to_string(),
            value: 2.0,
        }];
        m.apply_snapshot(&snap);

        let output = m.encode();
        assert!(output.contains("10.0.2.200"));
        assert!(!output.contains("10.0.1.100"));
    }

    #[test]
    fn test_sql_info_truncated_label() {
        let m = Metrics::new(&[]).unwrap();
        let mut snap = test_snapshot();
        snap.top_sql = vec![SqlMetric {
            sql_id: "TRUNC1".to_string(),
            sql_text: "x".repeat(200),
            sql_full_text: "x".repeat(300),
            sql_text_truncated: true,
            value: 3.0,
        }];
        m.apply_snapshot(&snap);
        assert!(m.encode().contains("sql_text_truncated=\"true\""));
    }

    #[test]
    fn test_apply_snapshot_postgresql_additional_metrics() {
        let m = Metrics::new(&[]).unwrap();
        let mut snap = test_snapshot();
        snap.top_sql_tokenized = vec![SqlTokenizedMetric {
            sql_tokenized_id: "PGTOK1".to_string(),
            sql_tokenized_text: "SELECT 1".to_string(),
            sql_tokenized_text_truncated: false,
            value: 1.0,
            calls_per_sec: Some(100.5),
            avg_latency_per_call: Some(2.3),
            rows_per_call: Some(5.0),
        }];
        m.apply_snapshot(&snap);

        let output = m.encode();
        assert!(output.contains("aurora_dbinsights_sql_tokenized_calls_per_sec"));
        assert!(output.contains("aurora_dbinsights_sql_tokenized_avg_latency_per_call"));
        assert!(output.contains("aurora_dbinsights_sql_tokenized_rows_per_call"));
    }

    #[test]
    fn test_apply_snapshot_mysql_no_additional_metrics() {
        let m = Metrics::new(&[]).unwrap();
        let snap = test_snapshot();
        m.apply_snapshot(&snap);

        let output = m.encode();
        assert!(!output.contains("aurora_dbinsights_sql_tokenized_calls_per_sec{"));
        assert!(!output.contains("aurora_dbinsights_sql_tokenized_avg_latency_per_call{"));
        assert!(!output.contains("aurora_dbinsights_sql_tokenized_rows_per_call{"));
    }

    #[test]
    fn test_error_kinds_are_enumerated() {
        // remove_instance purges pi_api_errors_total by iterating PI_ERROR_KINDS, so any kind
        // the classifier can emit must be listed there or its series leaks.
        let samples = [
            "ThrottlingException: Rate exceeded",
            "AccessDeniedException",
            "operation timed out",
            "ResourceNotFoundException",
            "ValidationException: bad period",
            "unexpected SDK error",
        ];
        for msg in samples {
            let kind = classify_pi_error(msg);
            assert!(
                PI_ERROR_KINDS.contains(&kind),
                "classify_pi_error returned {kind}, which remove_instance cannot purge"
            );
        }
    }

    #[test]
    fn test_remove_instance_clears_error_counters() {
        let m = Metrics::new(&[]).unwrap();
        let snap = test_snapshot();

        m.apply_snapshot(&snap);
        m.mark_instance_down(&snap.labels);
        m.record_pi_api_error(
            &snap.labels.instance,
            API_GET_RESOURCE_METRICS,
            "ThrottlingException",
        );

        let output = m.encode();
        assert!(output.contains("aurora_dbinsights_collection_errors_total{"));
        assert!(output.contains("aurora_dbinsights_pi_api_errors_total{"));

        m.remove_instance(&snap.labels);

        let output = m.encode();
        assert!(
            !output.contains("aurora_dbinsights_collection_errors_total{"),
            "error counter outlived the instance:\n{output}"
        );
        assert!(
            !output.contains("aurora_dbinsights_pi_api_errors_total{"),
            "PI error counter outlived the instance:\n{output}"
        );
    }

    #[test]
    fn test_stale_cleanup_is_scoped_to_one_instance() {
        let m = Metrics::new(&[]).unwrap();

        let mut writer = test_snapshot();
        writer.hosts = vec![HostMetric {
            client_host: "writer-host-old".to_string(),
            value: 1.0,
        }];

        let mut reader = test_snapshot();
        reader.labels.instance = "test-reader".to_string();
        reader.labels.resource_id = "db-TEST456".to_string();
        reader.hosts = vec![HostMetric {
            client_host: "reader-host".to_string(),
            value: 2.0,
        }];

        m.apply_snapshot(&writer);
        m.apply_snapshot(&reader);

        // The writer now reports a different host. Only its own stale series may disappear.
        writer.hosts = vec![HostMetric {
            client_host: "writer-host-new".to_string(),
            value: 3.0,
        }];
        m.apply_snapshot(&writer);

        let output = m.encode();
        assert!(!output.contains("writer-host-old"), "{output}");
        assert!(output.contains("writer-host-new"), "{output}");
        assert!(
            output.contains("reader-host"),
            "another instance lost its series:\n{output}"
        );

        let mut reader_lv = reader.labels.as_vec();
        reader_lv.push("reader-host");
        assert_eq!(
            m.db_load_by_host
                .gauge()
                .with_label_values(&reader_lv)
                .get(),
            2.0
        );
    }

    #[test]
    fn test_additional_metrics_removed_when_absent_next_cycle() {
        let m = Metrics::new(&[]).unwrap();
        let mut snap = test_snapshot();
        snap.top_sql_tokenized = vec![SqlTokenizedMetric {
            sql_tokenized_id: "PGTOK1".to_string(),
            sql_tokenized_text: "SELECT 1".to_string(),
            sql_tokenized_text_truncated: false,
            value: 1.0,
            calls_per_sec: Some(100.5),
            avg_latency_per_call: Some(2.3),
            rows_per_call: Some(5.0),
        }];
        m.apply_snapshot(&snap);
        assert!(
            m.encode()
                .contains("aurora_dbinsights_sql_tokenized_calls_per_sec{")
        );

        // Engine stops reporting pg_stat_statements: the series must not linger at its last value.
        snap.top_sql_tokenized[0].calls_per_sec = None;
        snap.top_sql_tokenized[0].avg_latency_per_call = None;
        snap.top_sql_tokenized[0].rows_per_call = None;
        m.apply_snapshot(&snap);

        let output = m.encode();
        assert!(
            !output.contains("aurora_dbinsights_sql_tokenized_calls_per_sec{"),
            "{output}"
        );
        assert!(
            !output.contains("aurora_dbinsights_sql_tokenized_rows_per_call{"),
            "{output}"
        );
    }

    #[test]
    fn test_internal_metrics() {
        let m = Metrics::new(&[]).unwrap();
        m.scrape_duration_seconds.set(1.5);
        m.discovery_instances_total.set(3.0);
        m.discovery_duration_seconds.set(0.7);

        let output = m.encode();
        assert!(output.contains("aurora_dbinsights_scrape_duration_seconds 1.5"));
        assert!(output.contains("aurora_dbinsights_discovery_instances_total 3"));
        assert!(output.contains("aurora_dbinsights_discovery_duration_seconds 0.7"));
    }
}
