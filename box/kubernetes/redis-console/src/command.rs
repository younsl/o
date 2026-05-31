//! REPL command parsing.
//!
//! Parsing is kept separate from execution so the dispatch logic can be unit
//! tested without a terminal or a live Redis connection.

/// A parsed REPL command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Show the help message.
    Help,
    /// List clusters with health status.
    List,
    /// Connect to a cluster by id or alias. `None` when no argument was given.
    Connect(Option<String>),
    /// Show server info for the connected cluster.
    Info,
    /// Disconnect (if connected) or quit.
    Quit,
    /// A raw Redis command line to run against the connected cluster.
    Redis(String),
    /// Blank input.
    Empty,
}

/// Parse a raw input line into a [`Command`].
#[must_use]
pub fn parse(line: &str) -> Command {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Command::Empty;
    }

    let mut parts = trimmed.split_whitespace();
    let keyword = parts.next().unwrap_or_default().to_lowercase();

    match keyword.as_str() {
        "help" | "h" => Command::Help,
        "list" | "ls" | "l" => Command::List,
        "connect" | "c" => Command::Connect(parts.next().map(ToString::to_string)),
        "info" => Command::Info,
        "quit" | "exit" | "q" => Command::Quit,
        _ => Command::Redis(trimmed.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_empty_and_whitespace() {
        assert_eq!(parse(""), Command::Empty);
        assert_eq!(parse("   \t  "), Command::Empty);
    }

    #[test]
    fn parses_help_aliases() {
        assert_eq!(parse("help"), Command::Help);
        assert_eq!(parse("h"), Command::Help);
        assert_eq!(parse("  HELP  "), Command::Help);
    }

    #[test]
    fn parses_list_aliases() {
        for input in ["list", "ls", "l", "LS"] {
            assert_eq!(parse(input), Command::List);
        }
    }

    #[test]
    fn parses_connect_with_and_without_arg() {
        assert_eq!(parse("connect"), Command::Connect(None));
        assert_eq!(parse("c"), Command::Connect(None));
        assert_eq!(
            parse("connect prod"),
            Command::Connect(Some("prod".to_string()))
        );
        assert_eq!(parse("c 2"), Command::Connect(Some("2".to_string())));
    }

    #[test]
    fn parses_info_and_quit_aliases() {
        assert_eq!(parse("info"), Command::Info);
        for input in ["quit", "exit", "q", "QUIT"] {
            assert_eq!(parse(input), Command::Quit);
        }
    }

    #[test]
    fn unknown_keyword_becomes_redis_command() {
        assert_eq!(parse("GET foo"), Command::Redis("GET foo".to_string()));
        // The trimmed original line is preserved (not lowercased).
        assert_eq!(parse("  SET k v  "), Command::Redis("SET k v".to_string()));
    }
}
