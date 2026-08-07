use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

pub fn init_logger(log_level: &str) {
    let filter = EnvFilter::try_new(log_level).unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .json()
                .with_current_span(true)
                .with_span_list(false)
                .with_target(true)
                .with_thread_ids(true)
                .with_thread_names(true),
        )
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_logger() {
        // This test just ensures the logger can be initialized without panicking
        // In a real scenario, we'd test the output, but that's complex with tracing
        init_logger("debug");
    }
}
