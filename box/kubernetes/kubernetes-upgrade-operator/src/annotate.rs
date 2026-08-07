//! Grafana annotations for upgrade phase visibility.
//!
//! kuo posts one point annotation the moment each phase starts, and one region
//! annotation spanning the whole run once it reaches a terminal phase. Together
//! they let a cluster operator read the phase boundaries of an upgrade straight
//! off a dashboard, next to the graphs the upgrade affected.
//!
//! Delivery is best-effort: a failed or slow Grafana is logged and never blocks
//! a reconcile, fails an upgrade, or triggers a retry. Annotations are a visual
//! aid, not an audit log; the durable record is the metrics in
//! [`crate::telemetry::metrics`] and the `EKSUpgrade` status itself.

pub mod grafana;

pub use grafana::{Annotation, Client};

use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use chrono::{DateTime, Utc};
use secrecy::SecretString;
use tracing::{info, warn};

use crate::crd::{EKSUpgradeSpec, EKSUpgradeStatus, UpgradeMode, UpgradePhase};
use crate::render;

/// Base tag dashboards subscribe to when none is configured.
const DEFAULT_TAGS: &str = "event:eks-upgrade";

/// Attempts made by the startup connectivity check before it is reported failed.
const PREFLIGHT_ATTEMPTS: u32 = 3;

/// Delay between preflight retries.
const PREFLIGHT_BACKOFF: Duration = Duration::from_secs(2);

/// Attempts made to post one annotation when the request keeps timing out.
///
/// Retries are bounded deliberately: this runs on the reconcile path, so with
/// the client's 3s timeout a hung Grafana can delay a phase transition by at
/// most about ten seconds before the marker is given up on.
const POST_ATTEMPTS: u32 = 3;

/// Delay between post retries.
const POST_BACKOFF: Duration = Duration::from_millis(500);

/// Remedy named whenever Grafana refuses the token, worded once so the startup
/// and per-annotation warnings cannot drift apart.
const TOKEN_REMEDY: &str = "Grant the service account the annotations:create permission (the Editor basic role) and confirm the token is neither expired nor revoked";

/// Remedy named when the endpoint cannot be reached at all.
const NETWORK_REMEDY: &str = "Check the GRAFANA_URL host and port, that the Grafana Service exists in the namespace the URL names (use the fully qualified name when it differs from this Pod's), and that no NetworkPolicy blocks egress from this Pod";

/// Characters of a failure message kept in an annotation body. Grafana renders
/// annotation text in a small tooltip, and the full message is already in the
/// `EKSUpgrade` status and the Slack notification.
const MAX_MESSAGE_CHARS: usize = 400;

/// Which runs are annotated.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AnnotateOn {
    /// Annotate every run (default).
    #[default]
    All,
    /// Annotate live upgrades only, keeping dry runs off dashboards.
    Upgrade,
    /// Annotate dry runs only, useful while rehearsing an upgrade.
    DryRun,
}

impl AnnotateOn {
    /// Parse the `GRAFANA_ANNOTATE_ON` value.
    fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "all" => Ok(Self::All),
            "upgrade" => Ok(Self::Upgrade),
            "dryrun" | "dry-run" | "dry_run" => Ok(Self::DryRun),
            other => {
                bail!("GRAFANA_ANNOTATE_ON must be one of all, upgrade, dryRun, got {other:?}")
            }
        }
    }

    /// Whether a run with this `dry_run` setting is annotated.
    #[must_use]
    pub const fn covers(self, dry_run: bool) -> bool {
        match self {
            Self::All => true,
            Self::Upgrade => !dry_run,
            Self::DryRun => dry_run,
        }
    }
}

impl std::fmt::Display for AnnotateOn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::All => write!(f, "all"),
            Self::Upgrade => write!(f, "upgrade"),
            Self::DryRun => write!(f, "dryRun"),
        }
    }
}

/// Operator-level Grafana annotation configuration.
pub struct Config {
    /// Grafana base URL; the annotations path is appended to it.
    pub url: String,
    /// Grafana service account token, sent as a Bearer credential.
    pub token: SecretString,
    /// Base tags merged into every annotation.
    pub tags: Vec<String>,
    /// Which runs to annotate.
    pub annotate_on: AnnotateOn,
}

impl Config {
    /// Read the configuration from the environment.
    ///
    /// Returns `Ok(None)` when annotating is disabled, which includes the case
    /// where it was switched on but the token (or URL) is missing: annotations
    /// are auxiliary to performing the upgrade, so an incomplete setup disables
    /// them with a warning rather than keeping the operator from starting.
    ///
    /// A value that is present but malformed is still an error. Silently
    /// ignoring a typo like `GRAFANA_ANNOTATE_ON=sucess` would annotate the
    /// wrong runs, which is worse than refusing to start.
    pub fn from_env() -> Result<Option<Self>> {
        if !env_flag("GRAFANA_ANNOTATION_ENABLED")? {
            return Ok(None);
        }

        let Some(url) = env_str("GRAFANA_URL") else {
            warn!(
                "Grafana annotations are enabled but GRAFANA_URL is empty, disabling annotations"
            );
            return Ok(None);
        };
        let Some(token) = env_str("GRAFANA_API_TOKEN") else {
            warn!(
                "Grafana annotations are enabled but GRAFANA_API_TOKEN is empty, disabling annotations. Set a Grafana service account token with the annotations:create permission to record upgrade phases"
            );
            return Ok(None);
        };

        let tags = parse_tags(env_str("GRAFANA_ANNOTATION_TAGS").as_deref().unwrap_or(""));
        let annotate_on = match env_str("GRAFANA_ANNOTATE_ON") {
            Some(raw) => AnnotateOn::parse(&raw)?,
            None => AnnotateOn::default(),
        };

        Ok(Some(Self {
            url,
            token: SecretString::from(token),
            tags,
            annotate_on,
        }))
    }
}

/// Posts upgrade annotations to Grafana.
///
/// Owns both the transport and the policy of what is worth marking, so the
/// controller only has to say which lifecycle moment just happened.
pub struct Annotator {
    client: Client,
    annotate_on: AnnotateOn,
}

impl Annotator {
    /// Build an annotator from configuration.
    ///
    /// Logs the resolved target and policy, so the startup log states plainly
    /// that upgrade phases will be recorded as Grafana annotations and which
    /// tags a dashboard has to subscribe to in order to see them.
    pub fn new(config: Config) -> Result<Self> {
        let client = Client::new(&config.url, config.token, config.tags)?;
        info!(
            endpoint = client.endpoint(),
            annotate_on = %config.annotate_on,
            tags = ?client.base_tags(),
            "Grafana annotations enabled, a token is configured and upgrade phase boundaries will be recorded as annotations"
        );
        Ok(Self {
            client,
            annotate_on: config.annotate_on,
        })
    }

    /// Run the startup connectivity check, retrying a few times and logging the
    /// outcome. Never fatal: a persistent failure is logged so misconfiguration
    /// is visible immediately, but the operator still starts because annotations
    /// are auxiliary to performing the upgrade.
    ///
    /// A rejected token is reported once and not retried. `/api/health` does not
    /// itself require authentication, so a 401/403 here means the credential is
    /// being refused outright and a retry would only repeat it.
    pub async fn preflight(&self) {
        let endpoint = self.client.health_endpoint();
        for attempt in 1..=PREFLIGHT_ATTEMPTS {
            let started = Instant::now();
            let result = self.client.preflight().await;
            let latency_ms = started.elapsed().as_millis();

            match result {
                Ok(status) => {
                    info!(
                        endpoint,
                        status,
                        latency_ms,
                        attempt,
                        "Grafana preflight check succeeded, annotations are active"
                    );
                    return;
                }
                Err(e) if e.is_permission_denied() => {
                    warn!(
                        endpoint,
                        status = status_field(&e),
                        latency_ms,
                        remedy = TOKEN_REMEDY,
                        error = %e,
                        "Grafana rejected the API token, annotations will not be recorded"
                    );
                    return;
                }
                Err(e) if attempt < PREFLIGHT_ATTEMPTS => {
                    warn!(
                        endpoint,
                        status = status_field(&e),
                        latency_ms,
                        attempt,
                        max_attempts = PREFLIGHT_ATTEMPTS,
                        unreachable = e.is_unreachable(),
                        error = %e,
                        "Grafana preflight check failed, retrying"
                    );
                    tokio::time::sleep(PREFLIGHT_BACKOFF).await;
                }
                // Separating "could not be reached" from "answered with an
                // error" matters at startup: the first is a cluster networking
                // problem the operator cannot work around, and naming it as one
                // saves reading it as a Grafana or token fault.
                Err(e) if e.is_unreachable() => warn!(
                    endpoint,
                    status = status_field(&e),
                    latency_ms,
                    attempts = PREFLIGHT_ATTEMPTS,
                    remedy = NETWORK_REMEDY,
                    error = %e,
                    "Grafana endpoint is not reachable from this Pod, annotations will be attempted per phase but keep failing until connectivity is fixed"
                ),
                Err(e) => warn!(
                    endpoint,
                    status = status_field(&e),
                    latency_ms,
                    attempts = PREFLIGHT_ATTEMPTS,
                    error = %e,
                    "Grafana preflight check failed, annotations will still be attempted for each phase"
                ),
            }
        }
    }

    /// Mark the moment `phase` started as a point annotation.
    ///
    /// Terminal phases are skipped: the region annotation posted by
    /// [`Self::run_finished`] already covers where the run ended, and a point on
    /// top of its edge only adds clutter.
    pub async fn phase_started(
        &self,
        resource_name: &str,
        spec: &EKSUpgradeSpec,
        status: &EKSUpgradeStatus,
        phase: &UpgradePhase,
    ) {
        if !self.annotate_on.covers(spec.dry_run) || is_terminal(phase) {
            return;
        }
        let annotation = phase_annotation(resource_name, spec, status, phase, Utc::now());
        self.post(resource_name, &phase.to_string(), &annotation)
            .await;
    }

    /// Mark the whole run as a region annotation spanning start to finish.
    ///
    /// Called once the run reaches `Completed` or `Failed`, so the band Grafana
    /// draws covers exactly the window during which the cluster was being
    /// changed. `failed_phase` is the phase that was executing when the run
    /// broke; the caller supplies it because by this point `status.phase` has
    /// already been overwritten with `Failed`.
    pub async fn run_finished(
        &self,
        resource_name: &str,
        spec: &EKSUpgradeSpec,
        status: &EKSUpgradeStatus,
        failed_phase: Option<&UpgradePhase>,
    ) {
        if !self.annotate_on.covers(spec.dry_run) {
            return;
        }
        let annotation = run_annotation(resource_name, spec, status, failed_phase);
        self.post(resource_name, "run", &annotation).await;
    }

    /// Post one annotation, logging the outcome rather than propagating it.
    ///
    /// Every attempt is logged with its round trip latency and, on success, the
    /// HTTP status, so the log alone answers whether a given phase was recorded
    /// and how long Grafana took to accept it. `marker` names what was being
    /// recorded: a phase name, or `run` for the region spanning a finished run.
    ///
    /// A timeout is retried up to [`POST_ATTEMPTS`] times, since it says only
    /// that Grafana was slow at that instant. A refused token or any other
    /// status is not retried: the same request would be refused again.
    async fn post(&self, resource_name: &str, marker: &str, annotation: &Annotation) {
        for attempt in 1..=POST_ATTEMPTS {
            let started = Instant::now();
            let result = self.client.post(annotation).await;
            let latency_ms = started.elapsed().as_millis();

            match result {
                Ok(status) => {
                    info!(
                        resource = resource_name,
                        marker,
                        status,
                        latency_ms,
                        attempt,
                        text = annotation.text.as_str(),
                        tags = ?annotation.tags,
                        "Grafana annotation posted"
                    );
                    return;
                }
                Err(e) if e.is_permission_denied() => {
                    warn!(
                        resource = resource_name,
                        marker,
                        status = status_field(&e),
                        latency_ms,
                        remedy = TOKEN_REMEDY,
                        error = %e,
                        "Grafana rejected the API token, annotation not recorded"
                    );
                    return;
                }
                Err(e) if e.is_timeout() && attempt < POST_ATTEMPTS => {
                    warn!(
                        resource = resource_name,
                        marker,
                        status = status_field(&e),
                        latency_ms,
                        attempt,
                        max_attempts = POST_ATTEMPTS,
                        error = %e,
                        "Grafana annotation timed out, retrying"
                    );
                    tokio::time::sleep(POST_BACKOFF).await;
                }
                Err(e) => {
                    warn!(
                        resource = resource_name,
                        marker,
                        status = status_field(&e),
                        latency_ms,
                        attempt,
                        unreachable = e.is_unreachable(),
                        error = %e,
                        "Failed to post Grafana annotation"
                    );
                    return;
                }
            }
        }
    }
}

/// The status code to log for a failed request.
///
/// `0` stands for "no HTTP response", which is how a DNS failure, a refused
/// connection, or a timeout appears. Logging a number rather than omitting the
/// field keeps every Grafana log line, success or failure, carrying both a
/// status and a latency.
fn status_field(error: &grafana::Error) -> u16 {
    error.status_code().unwrap_or(0)
}

/// Whether a phase ends the run.
const fn is_terminal(phase: &UpgradePhase) -> bool {
    matches!(phase, UpgradePhase::Completed | UpgradePhase::Failed)
}

/// Noun for the direction of the run, so a rollback is not described as an
/// upgrade on the dashboard.
const fn flow(spec: &EKSUpgradeSpec) -> &'static str {
    match spec.upgrade_mode {
        UpgradeMode::Forward => "upgrade",
        UpgradeMode::Rollback => "rollback",
    }
}

/// Tags carried by every annotation for a given run. Flat `key:value` strings,
/// the convention dashboards filter on. Keys match the Prometheus metric labels
/// (`cluster_name`, `region`) so a dashboard variable can drive both.
fn run_tags(resource_name: &str, spec: &EKSUpgradeSpec) -> Vec<String> {
    vec![
        format!("cluster_name:{}", spec.cluster_name),
        format!("region:{}", spec.region),
        format!("resource:{resource_name}"),
        format!("mode:{}", spec.upgrade_mode),
        format!("dry_run:{}", spec.dry_run),
    ]
}

/// Build the point annotation marking the start of `phase`.
fn phase_annotation(
    resource_name: &str,
    spec: &EKSUpgradeSpec,
    status: &EKSUpgradeStatus,
    phase: &UpgradePhase,
    at: DateTime<Utc>,
) -> Annotation {
    let mut tags = run_tags(resource_name, spec);
    tags.push("kind:phase".to_string());
    tags.push(format!("phase:{phase}"));

    Annotation {
        text: format!(
            "EKS {flow} phase {phase} started on {cluster} ({path}, {mode})",
            flow = flow(spec),
            cluster = spec.cluster_name,
            path = render::upgrade_path(spec, status),
            mode = render::mode(spec),
        ),
        tags,
        time: at,
        time_end: None,
    }
}

/// Build the region annotation spanning the finished run.
fn run_annotation(
    resource_name: &str,
    spec: &EKSUpgradeSpec,
    status: &EKSUpgradeStatus,
    failed_phase: Option<&UpgradePhase>,
) -> Annotation {
    let failed = status.phase == Some(UpgradePhase::Failed);

    let mut tags = run_tags(resource_name, spec);
    tags.push("kind:upgrade".to_string());
    tags.push(format!(
        "result:{}",
        if failed { "failure" } else { "success" }
    ));
    if failed && let Some(phase) = failed_phase.filter(|p| !is_terminal(p)) {
        tags.push(format!("failed_phase:{phase}"));
    }

    // A run that somehow reached a terminal phase without timestamps still gets
    // a marker at the current instant rather than none at all.
    let end = status.completed_at.unwrap_or_else(Utc::now);
    let start = status.started_at.unwrap_or(end);

    // "failed during UpgradingNodeGroups ... after 12m 3s: <cause>" reads the
    // same way as the Slack failure notification, so the two agree on a glance.
    let (outcome, preposition) = if failed {
        (
            failed_phase
                .filter(|p| !is_terminal(p))
                .map_or_else(|| "failed".to_string(), |p| format!("failed during {p}")),
            "after",
        )
    } else {
        ("completed".to_string(), "in")
    };

    let cause = if failed {
        status
            .message
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map_or_else(String::new, |m| format!(": {}", truncate_chars(m)))
    } else {
        String::new()
    };

    Annotation {
        text: format!(
            "EKS {flow} {outcome} on {cluster} ({path}, {mode}) {preposition} {duration}{cause}",
            flow = flow(spec),
            cluster = spec.cluster_name,
            path = render::upgrade_path(spec, status),
            mode = render::mode(spec),
            duration = render::duration(start, end),
        ),
        tags,
        time: start,
        time_end: Some(end),
    }
}

/// Shorten a message to [`MAX_MESSAGE_CHARS`] characters, marking the cut.
fn truncate_chars(s: &str) -> String {
    if s.chars().count() <= MAX_MESSAGE_CHARS {
        return s.to_string();
    }
    let kept: String = s.chars().take(MAX_MESSAGE_CHARS).collect();
    format!("{kept}...")
}

/// Read a non-empty environment variable.
fn env_str(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Read a boolean environment variable, defaulting to false when unset.
///
/// An unrecognised value is an error rather than a false: a typo that silently
/// disabled annotating would be invisible until someone went looking for
/// markers that were never posted.
fn env_flag(key: &str) -> Result<bool> {
    match env_str(key) {
        None => Ok(false),
        Some(raw) => match raw.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Ok(true),
            "false" | "0" | "no" => Ok(false),
            other => bail!("{key} must be a boolean, got {other:?}"),
        },
    }
}

/// Split a comma-separated tag list, falling back to the default base tag.
fn parse_tags(raw: &str) -> Vec<String> {
    let tags: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(String::from)
        .collect();
    if tags.is_empty() {
        return vec![DEFAULT_TAGS.to_string()];
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{PhaseStatuses, PlanningStatus};

    fn make_spec(dry_run: bool, mode: UpgradeMode) -> EKSUpgradeSpec {
        EKSUpgradeSpec {
            cluster_name: "my-cluster".to_string(),
            target_version: "1.36".to_string(),
            region: "ap-northeast-2".to_string(),
            upgrade_mode: mode,
            assume_role_arn: None,
            addon_versions: None,
            dry_run,
            timeouts: None,
            notification: None,
            karpenter_node_pools: None,
        }
    }

    fn make_status(phase: UpgradePhase) -> EKSUpgradeStatus {
        let start = DateTime::parse_from_rfc3339("2026-07-29T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        EKSUpgradeStatus {
            phase: Some(phase),
            current_version: Some("1.36".to_string()),
            started_at: Some(start),
            completed_at: Some(start + chrono::Duration::seconds(2730)),
            phases: PhaseStatuses {
                planning: Some(PlanningStatus {
                    source_version: Some("1.34".to_string()),
                    upgrade_path: vec!["1.35".into(), "1.36".into()],
                }),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn test_annotate_on_parse() {
        assert_eq!(AnnotateOn::parse("all").unwrap(), AnnotateOn::All);
        assert_eq!(AnnotateOn::parse(" Upgrade ").unwrap(), AnnotateOn::Upgrade);
        assert_eq!(AnnotateOn::parse("dryRun").unwrap(), AnnotateOn::DryRun);
        assert_eq!(AnnotateOn::parse("dry-run").unwrap(), AnnotateOn::DryRun);
        assert_eq!(AnnotateOn::parse("dry_run").unwrap(), AnnotateOn::DryRun);
        assert!(AnnotateOn::parse("sometimes").is_err());
    }

    #[test]
    fn test_annotate_on_covers() {
        assert!(AnnotateOn::All.covers(true));
        assert!(AnnotateOn::All.covers(false));
        assert!(AnnotateOn::Upgrade.covers(false));
        assert!(!AnnotateOn::Upgrade.covers(true));
        assert!(AnnotateOn::DryRun.covers(true));
        assert!(!AnnotateOn::DryRun.covers(false));
    }

    #[test]
    fn test_annotate_on_display_and_default() {
        assert_eq!(AnnotateOn::default(), AnnotateOn::All);
        assert_eq!(AnnotateOn::All.to_string(), "all");
        assert_eq!(AnnotateOn::Upgrade.to_string(), "upgrade");
        assert_eq!(AnnotateOn::DryRun.to_string(), "dryRun");
    }

    #[test]
    fn test_parse_tags() {
        assert_eq!(
            parse_tags("a:1, b:2"),
            ["a:1".to_string(), "b:2".to_string()]
        );
        // An empty or all-blank list falls back to the subscription default.
        assert_eq!(parse_tags(""), [DEFAULT_TAGS.to_string()]);
        assert_eq!(parse_tags(" , ,"), [DEFAULT_TAGS.to_string()]);
    }

    #[test]
    fn test_is_terminal() {
        assert!(is_terminal(&UpgradePhase::Completed));
        assert!(is_terminal(&UpgradePhase::Failed));
        assert!(!is_terminal(&UpgradePhase::UpgradingControlPlane));
        assert!(!is_terminal(&UpgradePhase::Pending));
    }

    #[test]
    fn test_flow_wording_follows_upgrade_mode() {
        assert_eq!(flow(&make_spec(false, UpgradeMode::Forward)), "upgrade");
        assert_eq!(flow(&make_spec(false, UpgradeMode::Rollback)), "rollback");
    }

    #[test]
    fn test_phase_annotation_is_a_point_with_phase_tags() {
        let spec = make_spec(false, UpgradeMode::Forward);
        let status = make_status(UpgradePhase::PreflightChecking);
        let at = Utc::now();
        let ann = phase_annotation(
            "prod-upgrade",
            &spec,
            &status,
            &UpgradePhase::PreflightChecking,
            at,
        );

        assert_eq!(ann.time, at);
        assert!(ann.time_end.is_none(), "phase markers must be points");
        assert_eq!(
            ann.text,
            "EKS upgrade phase PreflightChecking started on my-cluster (1.34 → 1.35 → 1.36, Live Upgrade)"
        );
        assert!(ann.tags.contains(&"kind:phase".to_string()));
        assert!(ann.tags.contains(&"phase:PreflightChecking".to_string()));
        assert!(ann.tags.contains(&"cluster_name:my-cluster".to_string()));
        assert!(ann.tags.contains(&"region:ap-northeast-2".to_string()));
        assert!(ann.tags.contains(&"resource:prod-upgrade".to_string()));
        assert!(ann.tags.contains(&"mode:Forward".to_string()));
        assert!(ann.tags.contains(&"dry_run:false".to_string()));
    }

    #[test]
    fn test_phase_annotation_dry_run_and_rollback_wording() {
        let spec = make_spec(true, UpgradeMode::Rollback);
        let status = make_status(UpgradePhase::RollingBackControlPlane);
        let ann = phase_annotation(
            "rb",
            &spec,
            &status,
            &UpgradePhase::RollingBackControlPlane,
            Utc::now(),
        );
        assert!(
            ann.text
                .starts_with("EKS rollback phase RollingBackControlPlane started")
        );
        assert!(ann.text.contains("Dry Run"));
        assert!(ann.tags.contains(&"dry_run:true".to_string()));
        assert!(ann.tags.contains(&"mode:Rollback".to_string()));
    }

    #[test]
    fn test_run_annotation_success_is_a_region() {
        let spec = make_spec(false, UpgradeMode::Forward);
        let status = make_status(UpgradePhase::Completed);
        let ann = run_annotation("prod-upgrade", &spec, &status, None);

        assert_eq!(ann.time, status.started_at.unwrap());
        assert_eq!(ann.time_end, status.completed_at);
        assert_eq!(
            ann.text,
            "EKS upgrade completed on my-cluster (1.34 → 1.35 → 1.36, Live Upgrade) in 45m 30s"
        );
        assert!(ann.tags.contains(&"kind:upgrade".to_string()));
        assert!(ann.tags.contains(&"result:success".to_string()));
        assert!(!ann.tags.iter().any(|t| t.starts_with("failed_phase:")));
    }

    #[test]
    fn test_run_annotation_failure_names_phase_and_cause() {
        let spec = make_spec(false, UpgradeMode::Forward);
        let mut status = make_status(UpgradePhase::Failed);
        status.message = Some("Control plane upgrade timed out".to_string());

        let ann = run_annotation(
            "prod-upgrade",
            &spec,
            &status,
            Some(&UpgradePhase::UpgradingControlPlane),
        );
        assert!(ann.tags.contains(&"result:failure".to_string()));
        assert!(
            ann.tags
                .contains(&"failed_phase:UpgradingControlPlane".to_string())
        );
        assert_eq!(
            ann.text,
            "EKS upgrade failed during UpgradingControlPlane on my-cluster \
             (1.34 → 1.35 → 1.36, Live Upgrade) after 45m 30s: Control plane upgrade timed out"
        );
    }

    #[test]
    fn test_run_annotation_failure_without_phase_or_message() {
        let spec = make_spec(false, UpgradeMode::Forward);
        let status = make_status(UpgradePhase::Failed);
        // A caller that only knows the terminal phase must not produce
        // "failed during Failed"; the phase clause is dropped instead.
        let ann = run_annotation("prod-upgrade", &spec, &status, Some(&UpgradePhase::Failed));
        assert!(ann.text.contains("EKS upgrade failed on my-cluster"));
        assert!(ann.text.ends_with("after 45m 30s"));
        assert!(!ann.tags.iter().any(|t| t.starts_with("failed_phase:")));
    }

    #[test]
    fn test_run_annotation_truncates_a_long_cause() {
        let spec = make_spec(false, UpgradeMode::Forward);
        let mut status = make_status(UpgradePhase::Failed);
        status.message = Some("e".repeat(MAX_MESSAGE_CHARS + 10));
        let ann = run_annotation("r", &spec, &status, None);
        assert!(ann.text.ends_with("..."));
    }

    #[test]
    fn test_run_annotation_without_timestamps_still_marks_something() {
        let spec = make_spec(false, UpgradeMode::Forward);
        let status = EKSUpgradeStatus {
            phase: Some(UpgradePhase::Completed),
            ..Default::default()
        };
        let ann = run_annotation("r", &spec, &status, None);
        assert_eq!(Some(ann.time), ann.time_end);
        assert!(ann.text.contains("in 0m 0s"));
    }

    /// A stub Grafana that only counts requests, used to assert which lifecycle
    /// moments actually reach the wire under a given [`AnnotateOn`].
    struct StubGrafana {
        port: u16,
        posts: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        healths: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl StubGrafana {
        async fn start(status: u16) -> Self {
            use std::sync::atomic::{AtomicUsize, Ordering};

            use axum::routing::{get, post};

            let posts = std::sync::Arc::new(AtomicUsize::new(0));
            let healths = std::sync::Arc::new(AtomicUsize::new(0));
            let code = axum::http::StatusCode::from_u16(status).unwrap();

            let on_post = {
                let posts = posts.clone();
                move || {
                    posts.fetch_add(1, Ordering::SeqCst);
                    async move { (code, "") }
                }
            };
            let on_health = {
                let healths = healths.clone();
                move || {
                    healths.fetch_add(1, Ordering::SeqCst);
                    async move { (code, "") }
                }
            };

            let app = axum::Router::new()
                .route("/api/annotations", post(on_post))
                .route("/api/health", get(on_health));

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });

            Self {
                port,
                posts,
                healths,
            }
        }

        fn annotator(&self, annotate_on: AnnotateOn) -> Annotator {
            Annotator::new(Config {
                url: format!("http://127.0.0.1:{}", self.port),
                token: SecretString::from("s3cr3t"),
                tags: vec![DEFAULT_TAGS.to_string()],
                annotate_on,
            })
            .unwrap()
        }

        fn posts(&self) -> usize {
            self.posts.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn healths(&self) -> usize {
            self.healths.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[tokio::test]
    async fn test_phase_started_posts_one_marker() {
        let stub = StubGrafana::start(200).await;
        let spec = make_spec(false, UpgradeMode::Forward);
        let status = make_status(UpgradePhase::UpgradingAddons);
        stub.annotator(AnnotateOn::All)
            .phase_started("r", &spec, &status, &UpgradePhase::UpgradingAddons)
            .await;
        assert_eq!(stub.posts(), 1);
    }

    #[tokio::test]
    async fn test_phase_started_skips_terminal_phases() {
        let stub = StubGrafana::start(200).await;
        let spec = make_spec(false, UpgradeMode::Forward);
        let status = make_status(UpgradePhase::Completed);
        let annotator = stub.annotator(AnnotateOn::All);
        annotator
            .phase_started("r", &spec, &status, &UpgradePhase::Completed)
            .await;
        annotator
            .phase_started("r", &spec, &status, &UpgradePhase::Failed)
            .await;
        // The run's region annotation already covers both, so no point markers.
        assert_eq!(stub.posts(), 0);
    }

    #[tokio::test]
    async fn test_annotate_on_gates_both_marker_kinds() {
        let stub = StubGrafana::start(200).await;
        let dry = make_spec(true, UpgradeMode::Forward);
        let live = make_spec(false, UpgradeMode::Forward);
        let status = make_status(UpgradePhase::Completed);

        // "upgrade" keeps dry runs off dashboards entirely.
        let upgrades_only = stub.annotator(AnnotateOn::Upgrade);
        upgrades_only
            .phase_started("r", &dry, &status, &UpgradePhase::Planning)
            .await;
        upgrades_only.run_finished("r", &dry, &status, None).await;
        assert_eq!(stub.posts(), 0);

        // "dryRun" is the mirror image: live runs are the ones skipped.
        let dry_only = stub.annotator(AnnotateOn::DryRun);
        dry_only
            .phase_started("r", &live, &status, &UpgradePhase::Planning)
            .await;
        dry_only.run_finished("r", &live, &status, None).await;
        assert_eq!(stub.posts(), 0);

        // The same live run is recorded once the policy covers it.
        upgrades_only.run_finished("r", &live, &status, None).await;
        assert_eq!(stub.posts(), 1);
    }

    #[tokio::test]
    async fn test_a_rejected_annotation_is_swallowed() {
        // A 403 must not panic or propagate: annotating never fails a reconcile.
        let stub = StubGrafana::start(403).await;
        let spec = make_spec(false, UpgradeMode::Forward);
        let status = make_status(UpgradePhase::Completed);
        stub.annotator(AnnotateOn::All)
            .run_finished("r", &spec, &status, None)
            .await;
        assert_eq!(stub.posts(), 1);
    }

    #[tokio::test]
    async fn test_preflight_reports_a_rejected_token_without_retrying() {
        let stub = StubGrafana::start(401).await;
        stub.annotator(AnnotateOn::All).preflight().await;
        // Retrying a refused credential would only repeat the rejection.
        assert_eq!(stub.healths(), 1);
    }

    #[tokio::test]
    async fn test_preflight_succeeds_against_a_healthy_grafana() {
        let stub = StubGrafana::start(200).await;
        stub.annotator(AnnotateOn::All).preflight().await;
        assert_eq!(stub.healths(), 1);
    }

    #[test]
    fn test_truncate_chars() {
        assert_eq!(truncate_chars("short"), "short");
        let long = "x".repeat(MAX_MESSAGE_CHARS + 50);
        let cut = truncate_chars(&long);
        assert_eq!(cut.chars().count(), MAX_MESSAGE_CHARS + 3);
        assert!(cut.ends_with("..."));
    }
}
