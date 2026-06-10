use clap::{Args, Parser, Subcommand};
use secrecy::SecretString;

/// Polls the AWS Health API and forwards events to Slack.
#[derive(Debug, Parser)]
#[command(name = "aws-health-event-notifier", version, about)]
pub struct Cli {
    #[command(flatten)]
    pub slack: SlackArgs,

    #[command(flatten)]
    pub logging: LoggingArgs,

    /// Subcommand. Defaults to `run` (poll daemon) when omitted.
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run the poll daemon (default).
    Run(Box<RunArgs>),
    /// Interactively pick recent AWS Health events and send them to Slack.
    /// Bypasses dedup and category/service filters — operator decides.
    Send(Box<SendArgs>),
}

#[derive(Debug, Args)]
#[allow(clippy::struct_field_names)] // env-var-derived prefix
pub struct SlackArgs {
    /// Slack Incoming Webhook URL.
    #[arg(long, env = "SLACK_WEBHOOK_URL")]
    pub slack_webhook_url: SecretString,

    /// Default Slack channel override.
    #[arg(long, env = "SLACK_CHANNEL")]
    pub slack_channel: Option<String>,

    /// Username shown in Slack messages.
    #[arg(
        long,
        env = "SLACK_USERNAME",
        default_value = "AWS Health Event Notifier"
    )]
    pub slack_username: String,

    /// Emoji used as the bot avatar.
    #[arg(long, env = "SLACK_ICON_EMOJI", default_value = ":cloud:")]
    pub slack_icon_emoji: String,

    /// Slack request timeout in seconds.
    #[arg(long, env = "SLACK_TIMEOUT_SECS", default_value_t = 10)]
    pub slack_timeout_secs: u64,
}

#[derive(Debug, Args)]
pub struct LoggingArgs {
    /// Log level filter.
    #[arg(long, env = "LOG_LEVEL", default_value = "info", global = true)]
    pub log_level: String,

    /// Emit logs as JSON.
    #[arg(long, env = "LOG_JSON", default_value_t = false, global = true)]
    pub log_json: bool,
}

#[derive(Debug, Args)]
pub struct RunArgs {
    /// Bind address for the admin (health + metrics) HTTP server.
    #[arg(long, env = "ADMIN_ADDR", default_value = "0.0.0.0:8081")]
    pub admin_addr: String,

    #[command(flatten)]
    pub k8s: K8sArgs,

    /// Poll interval against the AWS Health API.
    #[arg(long, env = "POLL_INTERVAL_SECS", default_value_t = 60)]
    pub poll_interval_secs: u64,

    /// Initial lookback window on cold start.
    #[arg(long, env = "INITIAL_LOOKBACK_SECS", default_value_t = 3600)]
    pub initial_lookback_secs: u64,

    /// When true, first poll only populates dedup without sending to Slack.
    #[arg(long, env = "COLD_START_SUPPRESS", default_value_t = true)]
    pub cold_start_suppress: bool,

    /// Locale passed to `DescribeEventDetails` (e.g., en, ja, zh).
    #[arg(long, env = "EVENT_LOCALE", default_value = "en")]
    pub event_locale: String,

    /// Comma-separated `eventTypeCategory` values to allow. Empty = allow all.
    #[arg(long, env = "ALLOW_CATEGORIES", value_delimiter = ',', num_args = 0..)]
    pub allow_categories: Vec<String>,

    /// Comma-separated `eventTypeCategory` values to deny.
    #[arg(long, env = "DENY_CATEGORIES", value_delimiter = ',', num_args = 0..)]
    pub deny_categories: Vec<String>,

    /// Comma-separated AWS service codes to allow (case-insensitive).
    #[arg(long, env = "ALLOW_SERVICES", value_delimiter = ',', num_args = 0..)]
    pub allow_services: Vec<String>,

    /// Comma-separated AWS service codes to deny.
    #[arg(long, env = "DENY_SERVICES", value_delimiter = ',', num_args = 0..)]
    pub deny_services: Vec<String>,

    /// Comma-separated `SERVICE/EVENT_TYPE_CODE` pairs to allow
    /// (case-insensitive). Empty = allow all.
    #[arg(long, env = "ALLOW_EVENT_CODES", value_delimiter = ',', num_args = 0..)]
    pub allow_event_codes: Vec<String>,

    /// Comma-separated `SERVICE/EVENT_TYPE_CODE` pairs to deny (wins over
    /// allow). Drops a specific event type without denying its whole service,
    /// e.g. `VPN/AWS_VPN_REDUNDANCY_LOSS` while still receiving other VPN events.
    #[arg(long, env = "DENY_EVENT_CODES", value_delimiter = ',', num_args = 0..)]
    pub deny_event_codes: Vec<String>,

    /// Reminder offsets in hours before `startTime`. Each event whose
    /// `startTime - now` crosses one of these thresholds triggers a Slack
    /// reminder (separate from the initial notification). Empty disables.
    /// Default: 24h.
    #[arg(
        long,
        env = "REMINDER_OFFSETS_HOURS",
        value_delimiter = ',',
        num_args = 0..,
        default_value = "24"
    )]
    pub reminder_offsets_hours: Vec<u32>,
}

/// Kubernetes Event emission. Always on when running in-cluster: it activates
/// automatically once the pod identity is present (injected via the Downward
/// API). Outside a pod (e.g. the `send` subcommand) it is simply skipped.
#[derive(Debug, Args)]
#[allow(clippy::struct_field_names)] // env-var-derived prefix
pub struct K8sArgs {
    /// Notifier pod name (Downward API `metadata.name`). Used as the Event
    /// `involvedObject` and `reportingInstance`. Emission is skipped if unset.
    #[arg(long, env = "POD_NAME")]
    pub pod_name: Option<String>,

    /// Notifier pod namespace (Downward API `metadata.namespace`). The Event
    /// is created in this namespace. Emission is skipped if unset.
    #[arg(long, env = "POD_NAMESPACE")]
    pub pod_namespace: Option<String>,

    /// Notifier pod UID (Downward API `metadata.uid`). Optional — improves
    /// `involvedObject` matching in `kubectl describe`.
    #[arg(long, env = "POD_UID")]
    pub pod_uid: Option<String>,
}

#[derive(Debug, Args)]
pub struct SendArgs {
    /// Lookback window for the event list (hours).
    #[arg(long, default_value_t = 24)]
    pub lookback_hours: i64,

    /// Locale passed to `DescribeEventDetails` (e.g., en, ja, zh).
    #[arg(long, env = "EVENT_LOCALE", default_value = "en")]
    pub event_locale: String,

    /// Skip the interactive picker and send the given event ARN(s).
    #[arg(long, value_delimiter = ',', num_args = 1..)]
    pub arn: Vec<String>,

    /// Optional service filter when listing (e.g., EC2,RDS).
    #[arg(long, value_delimiter = ',', num_args = 0..)]
    pub service: Vec<String>,

    /// Optional category filter when listing.
    #[arg(long, value_delimiter = ',', num_args = 0..)]
    pub category: Vec<String>,

    /// Don't prompt for confirmation before sending.
    #[arg(long, default_value_t = false)]
    pub yes: bool,
}
