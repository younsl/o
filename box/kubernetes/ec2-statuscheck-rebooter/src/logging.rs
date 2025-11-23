use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

pub fn init(log_format: &str, log_level: &str) {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(log_level));

    let format = normalize_log_format(log_format);

    if format == "json" {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(
                tracing_subscriber::fmt::layer()
                    .json()
                    .flatten_event(true)
                    .with_timer(tracing_subscriber::fmt::time::UtcTime::rfc_3339()),
            )
            .init();
    } else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer().compact())
            .init();
    }

    log_initialization(format, log_level);
}

fn normalize_log_format(format: &str) -> &str {
    match format.to_lowercase().as_str() {
        "json" => "json",
        "pretty" | "compact" | "text" => "pretty",
        _ => {
            eprintln!(
                "WARN: Invalid log format '{}', defaulting to 'json'. Valid options: json, pretty",
                format
            );
            "json"
        }
    }
}

fn log_initialization(format: &str, level: &str) {
    tracing::debug!(
        log_format = format,
        log_level = level,
        "Logging system initialized"
    );
}
