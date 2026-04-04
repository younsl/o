use prometheus::{core::Collector, CounterVec, Gauge, GaugeVec, Opts, Registry, TextEncoder};

use crate::types::{tag_key_to_label, InstanceLabels, MetricSnapshot};

/// Build instance label names: 5 base + N exported tag labels.
fn build_instance_label_names(exported_tags: &[String]) -> Vec<String> {
    let mut names = vec![
        "instance".to_string(),
        "resource_id".to_string(),
        "engine".to_string(),
        "region".to_string(),
        "cluster".to_string(),
    ];
    for tag_key in exported_tags {
        names.push(tag_key_to_label(tag_key));
    }
    names
}

/// All Prometheus metrics for adie.
pub struct Metrics {
    pub registry: Registry,

    // Instance-level (static)
    pub db_load: GaugeVec,
    pub db_load_cpu: GaugeVec,
    pub db_load_non_cpu: GaugeVec,
    pub vcpu: GaugeVec,
    pub up: GaugeVec,

    // Breakdown (dynamic, cycle reset)
    pub db_load_by_wait_event: GaugeVec,
    pub db_load_by_sql: GaugeVec,
    pub db_load_by_user: GaugeVec,
    pub db_load_by_host: GaugeVec,
    pub sql_info: GaugeVec,

    // Exporter internal
    pub scrape_duration_seconds: Gauge,
    pub discovery_instances_total: Gauge,
    pub collection_errors_total: CounterVec,
    pub discovery_duration_seconds: Gauge,
}

impl Metrics {
    pub fn new(exported_tags: &[String]) -> Self {
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

        let sql_info_labels = {
            let mut v = inst_labels.clone();
            v.extend([
                "sql_id".to_string(),
                "sql_text".to_string(),
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
        )
        .unwrap();

        let db_load_cpu = GaugeVec::new(
            Opts::new("aurora_dbinsights_db_load_cpu", "CPU-attributed DB Load"),
            &inst_label_refs,
        )
        .unwrap();

        let db_load_non_cpu = GaugeVec::new(
            Opts::new("aurora_dbinsights_db_load_non_cpu", "Non-CPU DB Load"),
            &inst_label_refs,
        )
        .unwrap();

        let vcpu = GaugeVec::new(
            Opts::new("aurora_dbinsights_vcpu", "Number of vCPUs"),
            &inst_label_refs,
        )
        .unwrap();

        let up = GaugeVec::new(
            Opts::new(
                "aurora_dbinsights_up",
                "Whether metrics collection succeeded (1=ok, 0=error)",
            ),
            &inst_label_refs,
        )
        .unwrap();

        let db_load_by_wait_event = GaugeVec::new(
            Opts::new(
                "aurora_dbinsights_db_load_by_wait_event",
                "DB Load by wait event",
            ),
            &we_refs,
        )
        .unwrap();

        let db_load_by_sql = GaugeVec::new(
            Opts::new("aurora_dbinsights_db_load_by_sql", "DB Load by top SQL"),
            &sql_refs,
        )
        .unwrap();

        let db_load_by_user = GaugeVec::new(
            Opts::new(
                "aurora_dbinsights_db_load_by_user",
                "DB Load by database user",
            ),
            &user_refs,
        )
        .unwrap();

        let db_load_by_host = GaugeVec::new(
            Opts::new(
                "aurora_dbinsights_db_load_by_host",
                "DB Load by client host",
            ),
            &host_refs,
        )
        .unwrap();

        let sql_info = GaugeVec::new(
            Opts::new(
                "aurora_dbinsights_sql_info",
                "SQL text info metric (value always 1)",
            ),
            &si_refs,
        )
        .unwrap();

        let scrape_duration_seconds = Gauge::new(
            "aurora_dbinsights_scrape_duration_seconds",
            "Duration of the last collection cycle in seconds",
        )
        .unwrap();

        let discovery_instances_total = Gauge::new(
            "aurora_dbinsights_discovery_instances_total",
            "Number of currently discovered Aurora instances",
        )
        .unwrap();

        let collection_errors_total = CounterVec::new(
            Opts::new(
                "aurora_dbinsights_collection_errors_total",
                "Total number of PI API collection errors",
            ),
            &["instance"],
        )
        .unwrap();

        let discovery_duration_seconds = Gauge::new(
            "aurora_dbinsights_discovery_duration_seconds",
            "Duration of the last discovery cycle in seconds",
        )
        .unwrap();

        // Register all metrics
        let collectors: Vec<Box<dyn Collector>> = vec![
            Box::new(db_load.clone()),
            Box::new(db_load_cpu.clone()),
            Box::new(db_load_non_cpu.clone()),
            Box::new(vcpu.clone()),
            Box::new(up.clone()),
            Box::new(db_load_by_wait_event.clone()),
            Box::new(db_load_by_sql.clone()),
            Box::new(db_load_by_user.clone()),
            Box::new(db_load_by_host.clone()),
            Box::new(sql_info.clone()),
            Box::new(scrape_duration_seconds.clone()),
            Box::new(discovery_instances_total.clone()),
            Box::new(collection_errors_total.clone()),
            Box::new(discovery_duration_seconds.clone()),
        ];

        for c in collectors {
            registry.register(c).unwrap();
        }

        Self {
            registry,
            db_load,
            db_load_cpu,
            db_load_non_cpu,
            vcpu,
            up,
            db_load_by_wait_event,
            db_load_by_sql,
            db_load_by_user,
            db_load_by_host,
            sql_info,
            scrape_duration_seconds,
            discovery_instances_total,
            collection_errors_total,
            discovery_duration_seconds,
        }
    }

    /// Reset all dynamic label metrics for a given instance before re-populating.
    pub fn reset_dynamic_labels(&self, labels: &InstanceLabels) {
        self.remove_matching_labels(&self.db_load_by_wait_event, labels);
        self.remove_matching_labels(&self.db_load_by_sql, labels);
        self.remove_matching_labels(&self.db_load_by_user, labels);
        self.remove_matching_labels(&self.db_load_by_host, labels);
        self.remove_matching_labels(&self.sql_info, labels);
    }

    /// Remove all label combinations from a GaugeVec that match the given instance labels.
    fn remove_matching_labels(&self, gauge: &GaugeVec, labels: &InstanceLabels) {
        let check_pairs: Vec<(&str, &str)> = vec![
            ("instance", &labels.instance),
            ("resource_id", &labels.resource_id),
        ];

        let descs = gauge.desc();
        let def_order: Vec<&str> = if let Some(desc) = descs.first() {
            desc.variable_labels.iter().map(|l| l.as_str()).collect()
        } else {
            return;
        };

        let metric_families = gauge.collect();
        for mf in &metric_families {
            for m in mf.get_metric() {
                let label_pairs = m.get_label();

                let matches = check_pairs.iter().all(|(name, expected)| {
                    label_pairs
                        .iter()
                        .any(|lp| lp.get_name() == *name && lp.get_value() == *expected)
                });

                if matches {
                    let values: Vec<&str> = def_order
                        .iter()
                        .map(|name| {
                            label_pairs
                                .iter()
                                .find(|lp| lp.get_name() == *name)
                                .map(|lp| lp.get_value())
                                .unwrap_or("")
                        })
                        .collect();
                    let _ = gauge.remove_label_values(&values);
                }
            }
        }
    }

    /// Apply a MetricSnapshot to the Prometheus registry.
    pub fn apply_snapshot(&self, snapshot: &MetricSnapshot) {
        let base = snapshot.labels.as_vec();

        // Reset dynamic labels first
        self.reset_dynamic_labels(&snapshot.labels);

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

        // Wait events
        for we in &snapshot.wait_events {
            let mut lv = base.clone();
            lv.push(&we.wait_event);
            lv.push(&we.wait_event_type);
            self.db_load_by_wait_event
                .with_label_values(&lv)
                .set(we.value);
        }

        // Top SQL
        for sql in &snapshot.top_sql {
            let mut lv = base.clone();
            lv.push(&sql.sql_id);
            self.db_load_by_sql.with_label_values(&lv).set(sql.value);

            let truncated_str = if sql.sql_text_truncated {
                "true"
            } else {
                "false"
            };
            let mut si_lv = base.clone();
            si_lv.push(&sql.sql_id);
            si_lv.push(&sql.sql_text);
            si_lv.push(truncated_str);
            self.sql_info.with_label_values(&si_lv).set(1.0);
        }

        // Users
        for u in &snapshot.users {
            let mut lv = base.clone();
            lv.push(&u.db_user);
            self.db_load_by_user.with_label_values(&lv).set(u.value);
        }

        // Hosts
        for h in &snapshot.hosts {
            let mut lv = base.clone();
            lv.push(&h.client_host);
            self.db_load_by_host.with_label_values(&lv).set(h.value);
        }
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
        self.reset_dynamic_labels(labels);
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
            top_sql: vec![SqlMetric {
                sql_id: "SQL123".to_string(),
                sql_text: "SELECT * FROM orders WHERE user_id = ?".to_string(),
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
        }
    }

    #[test]
    fn test_metrics_new_no_tags() {
        let m = Metrics::new(&[]);
        let output = m.encode();
        assert!(output.is_empty() || !output.contains("aurora_dbinsights_db_load{"));
    }

    #[test]
    fn test_metrics_new_with_exported_tags() {
        let tags = vec!["Team".to_string(), "Environment".to_string()];
        let m = Metrics::new(&tags);
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
        let m = Metrics::new(&[]);
        let snap = test_snapshot();
        m.apply_snapshot(&snap);

        let output = m.encode();
        assert!(output.contains("aurora_dbinsights_db_load{"));
        assert!(output.contains("aurora_dbinsights_db_load_cpu{"));
        assert!(output.contains("aurora_dbinsights_db_load_non_cpu{"));
        assert!(output.contains("aurora_dbinsights_vcpu{"));
        assert!(output.contains("aurora_dbinsights_up{"));
        assert!(output.contains("aurora_dbinsights_db_load_by_wait_event{"));
        assert!(output.contains("aurora_dbinsights_db_load_by_sql{"));
        assert!(output.contains("aurora_dbinsights_sql_info{"));
        assert!(output.contains("aurora_dbinsights_db_load_by_user{"));
        assert!(output.contains("aurora_dbinsights_db_load_by_host{"));
    }

    #[test]
    fn test_apply_snapshot_values() {
        let m = Metrics::new(&[]);
        let snap = test_snapshot();
        m.apply_snapshot(&snap);

        let base = snap.labels.as_vec();
        assert_eq!(m.db_load.with_label_values(&base).get(), 2.5);
        assert_eq!(m.db_load_cpu.with_label_values(&base).get(), 1.0);
        assert_eq!(m.db_load_non_cpu.with_label_values(&base).get(), 1.5);
        assert_eq!(m.vcpu.with_label_values(&base).get(), 4.0);
        assert_eq!(m.up.with_label_values(&base).get(), 1.0);
    }

    #[test]
    fn test_apply_snapshot_with_exported_tags() {
        let tags = vec!["Team".to_string()];
        let m = Metrics::new(&tags);

        let mut snap = test_snapshot();
        snap.labels.tag_values = vec!["platform".to_string()];
        m.apply_snapshot(&snap);

        let output = m.encode();
        assert!(output.contains("tag_team=\"platform\""));
    }

    #[test]
    fn test_mark_instance_down() {
        let m = Metrics::new(&[]);
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
        let m = Metrics::new(&[]);
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
        let m = Metrics::new(&[]);

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
        let m = Metrics::new(&[]);
        let mut snap = test_snapshot();
        snap.top_sql = vec![SqlMetric {
            sql_id: "TRUNC1".to_string(),
            sql_text: "x".repeat(200),
            sql_text_truncated: true,
            value: 3.0,
        }];
        m.apply_snapshot(&snap);
        assert!(m.encode().contains("sql_text_truncated=\"true\""));
    }

    #[test]
    fn test_internal_metrics() {
        let m = Metrics::new(&[]);
        m.scrape_duration_seconds.set(1.5);
        m.discovery_instances_total.set(3.0);
        m.discovery_duration_seconds.set(0.7);

        let output = m.encode();
        assert!(output.contains("aurora_dbinsights_scrape_duration_seconds 1.5"));
        assert!(output.contains("aurora_dbinsights_discovery_instances_total 3"));
        assert!(output.contains("aurora_dbinsights_discovery_duration_seconds 0.7"));
    }
}
