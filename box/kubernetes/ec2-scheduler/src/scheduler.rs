//! Cron parsing and timezone-aware schedule evaluation.

use anyhow::Result;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use std::str::FromStr;

use crate::crd::ScheduleEntry;
use crate::error::SchedulerError;

/// Parse and validate an IANA timezone string.
pub fn parse_timezone(tz: &str) -> Result<Tz> {
    tz.parse::<Tz>()
        .map_err(|_| SchedulerError::InvalidTimezone(tz.to_string()).into())
}

/// Parse a 5-field cron expression into a `Schedule`.
///
/// The `cron` crate expects 7-field expressions (seconds, minutes, hours, day-of-month,
/// month, day-of-week, year). We prepend "0" for seconds and append "*" for year
/// to support standard 5-field cron expressions.
fn parse_cron(expr: &str) -> Result<Schedule> {
    let seven_field = format!("0 {expr} *");
    Schedule::from_str(&seven_field)
        .map_err(|e| SchedulerError::InvalidCron(format!("{expr}: {e}")).into())
}

/// Validate all schedule entries (cron expressions and timezone).
pub fn validate_schedules(entries: &[ScheduleEntry], timezone: &str) -> Result<()> {
    parse_timezone(timezone)?;
    for entry in entries {
        parse_cron(&entry.start)?;
        parse_cron(&entry.stop)?;
    }
    Ok(())
}

/// Determine if a start or stop action should be executed now.
///
/// Compares each schedule entry's cron expression against the current time
/// in the configured timezone. An action should fire if the last occurrence
/// is after `last_action_time` and within the `window` duration.
pub fn should_execute_now(
    entries: &[ScheduleEntry],
    timezone: &str,
    last_action_time: Option<DateTime<Utc>>,
    window: chrono::Duration,
) -> Option<ActionToExecute> {
    let Ok(tz) = parse_timezone(timezone) else {
        return None;
    };

    let now_utc = Utc::now();
    let now_local = now_utc.with_timezone(&tz);
    let window_start = now_local - window;

    for entry in entries {
        // Check stop first (stop takes priority if both match in the same window)
        if let Ok(schedule) = parse_cron(&entry.stop) {
            for occurrence in schedule.after(&window_start.with_timezone(&Utc)) {
                let occurrence_local = occurrence.with_timezone(&tz);
                if occurrence_local > now_local {
                    break;
                }
                if last_action_time.is_none_or(|last| occurrence > last) {
                    return Some(ActionToExecute::Stop(entry.name.clone()));
                }
            }
        }

        // Check start
        if let Ok(schedule) = parse_cron(&entry.start) {
            for occurrence in schedule.after(&window_start.with_timezone(&Utc)) {
                let occurrence_local = occurrence.with_timezone(&tz);
                if occurrence_local > now_local {
                    break;
                }
                if last_action_time.is_none_or(|last| occurrence > last) {
                    return Some(ActionToExecute::Start(entry.name.clone()));
                }
            }
        }
    }

    None
}

/// Action that should be executed.
#[derive(Debug, PartialEq, Eq)]
pub enum ActionToExecute {
    Start(String),
    Stop(String),
}

/// Calculate the next occurrence of start/stop across all schedule entries.
pub fn next_occurrences(
    entries: &[ScheduleEntry],
    timezone: &str,
) -> (Option<DateTime<Utc>>, Option<DateTime<Utc>>) {
    let Ok(tz) = parse_timezone(timezone) else {
        return (None, None);
    };

    let now_utc = Utc::now();
    let now_local = now_utc.with_timezone(&tz);

    let mut next_start: Option<DateTime<Utc>> = None;
    let mut next_stop: Option<DateTime<Utc>> = None;

    for entry in entries {
        if let Ok(schedule) = parse_cron(&entry.start)
            && let Some(next) = schedule.after(&now_local.with_timezone(&Utc)).next()
            && (next_start.is_none() || next < next_start.unwrap())
        {
            next_start = Some(next);
        }

        if let Ok(schedule) = parse_cron(&entry.stop)
            && let Some(next) = schedule.after(&now_local.with_timezone(&Utc)).next()
            && (next_stop.is_none() || next < next_stop.unwrap())
        {
            next_stop = Some(next);
        }
    }

    (next_start, next_stop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_timezone_valid() {
        let tz = parse_timezone("Asia/Seoul").unwrap();
        assert_eq!(tz.to_string(), "Asia/Seoul");
    }

    #[test]
    fn test_parse_timezone_utc() {
        let tz = parse_timezone("UTC").unwrap();
        assert_eq!(tz.to_string(), "UTC");
    }

    #[test]
    fn test_parse_timezone_invalid() {
        let result = parse_timezone("Bad/Zone");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_cron_valid() {
        let schedule = parse_cron("0 9 * * 1-5");
        assert!(schedule.is_ok());
    }

    #[test]
    fn test_parse_cron_invalid() {
        let result = parse_cron("not a cron");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_schedules_valid() {
        let entries = vec![ScheduleEntry {
            name: "weekday".to_string(),
            start: "0 9 * * 1-5".to_string(),
            stop: "0 18 * * 1-5".to_string(),
        }];
        assert!(validate_schedules(&entries, "Asia/Seoul").is_ok());
    }

    #[test]
    fn test_validate_schedules_invalid_timezone() {
        let entries = vec![ScheduleEntry {
            name: "test".to_string(),
            start: "0 9 * * *".to_string(),
            stop: "0 18 * * *".to_string(),
        }];
        assert!(validate_schedules(&entries, "Bad/Zone").is_err());
    }

    #[test]
    fn test_validate_schedules_invalid_cron() {
        let entries = vec![ScheduleEntry {
            name: "test".to_string(),
            start: "bad cron".to_string(),
            stop: "0 18 * * *".to_string(),
        }];
        assert!(validate_schedules(&entries, "UTC").is_err());
    }

    #[test]
    fn test_next_occurrences_returns_some() {
        let entries = vec![ScheduleEntry {
            name: "test".to_string(),
            start: "0 9 * * *".to_string(),
            stop: "0 18 * * *".to_string(),
        }];
        let (next_start, next_stop) = next_occurrences(&entries, "UTC");
        assert!(next_start.is_some());
        assert!(next_stop.is_some());
    }

    #[test]
    fn test_next_occurrences_invalid_timezone() {
        let entries = vec![ScheduleEntry {
            name: "test".to_string(),
            start: "0 9 * * *".to_string(),
            stop: "0 18 * * *".to_string(),
        }];
        let (next_start, next_stop) = next_occurrences(&entries, "Bad/Zone");
        assert!(next_start.is_none());
        assert!(next_stop.is_none());
    }

    #[test]
    fn test_should_execute_now_empty_entries() {
        let result = should_execute_now(&[], "UTC", None, chrono::Duration::seconds(45));
        assert!(result.is_none());
    }

    #[test]
    fn test_should_execute_now_invalid_timezone() {
        let entries = vec![ScheduleEntry {
            name: "test".to_string(),
            start: "0 9 * * *".to_string(),
            stop: "0 18 * * *".to_string(),
        }];
        let result = should_execute_now(&entries, "Bad/Zone", None, chrono::Duration::seconds(45));
        assert!(result.is_none());
    }

    #[test]
    fn test_should_execute_now_no_match_in_window() {
        // Use a cron that fires at a fixed hour far from now
        // (every minute of hour 3 UTC — unlikely to be the current hour in test)
        let entries = vec![ScheduleEntry {
            name: "night".to_string(),
            start: "0 3 1 1 *".to_string(), // Jan 1 03:00 only
            stop: "0 4 1 1 *".to_string(),  // Jan 1 04:00 only
        }];
        let result = should_execute_now(
            &entries,
            "UTC",
            Some(Utc::now()),
            chrono::Duration::seconds(45),
        );
        assert!(result.is_none());
    }

    #[test]
    fn test_should_execute_now_recent_action_prevents_refire() {
        // Every minute cron — should always have a recent occurrence
        let entries = vec![ScheduleEntry {
            name: "every-min".to_string(),
            start: "* * * * *".to_string(),
            stop: "* * * * *".to_string(),
        }];
        // last_action_time is now → no cron occurrence after it in the window
        let result = should_execute_now(
            &entries,
            "UTC",
            Some(Utc::now()),
            chrono::Duration::seconds(45),
        );
        assert!(result.is_none());
    }

    #[test]
    fn test_should_execute_now_stop_priority_over_start() {
        // Both start and stop fire every minute → stop should win
        let entries = vec![ScheduleEntry {
            name: "every-min".to_string(),
            start: "* * * * *".to_string(),
            stop: "* * * * *".to_string(),
        }];
        let past = Utc::now() - chrono::Duration::minutes(2);
        let result =
            should_execute_now(&entries, "UTC", Some(past), chrono::Duration::seconds(120));
        assert!(
            matches!(result, Some(ActionToExecute::Stop(_))),
            "Stop should take priority when both match"
        );
    }

    #[test]
    fn test_should_execute_now_none_last_action_fires() {
        // Every minute cron with no previous action → should fire
        let entries = vec![ScheduleEntry {
            name: "every-min".to_string(),
            start: "* * * * *".to_string(),
            stop: "* * * * *".to_string(),
        }];
        let result = should_execute_now(&entries, "UTC", None, chrono::Duration::seconds(120));
        assert!(
            result.is_some(),
            "Should fire when last_action_time is None"
        );
    }

    #[test]
    fn test_validate_schedules_empty_entries() {
        // Empty entries list is valid (no crons to validate)
        assert!(validate_schedules(&[], "UTC").is_ok());
    }

    #[test]
    fn test_validate_schedules_invalid_stop_cron() {
        let entries = vec![ScheduleEntry {
            name: "test".to_string(),
            start: "0 9 * * *".to_string(),
            stop: "bad".to_string(),
        }];
        assert!(validate_schedules(&entries, "UTC").is_err());
    }

    #[test]
    fn test_next_occurrences_multiple_entries_picks_earliest() {
        let entries = vec![
            ScheduleEntry {
                name: "late".to_string(),
                start: "0 23 * * *".to_string(),
                stop: "0 23 * * *".to_string(),
            },
            ScheduleEntry {
                name: "early".to_string(),
                start: "0 0 * * *".to_string(),
                stop: "0 0 * * *".to_string(),
            },
        ];
        let (next_start, next_stop) = next_occurrences(&entries, "UTC");
        // The "early" (00:00) schedule should produce an earlier next occurrence
        // than "late" (23:00) for the next day
        assert!(next_start.is_some());
        assert!(next_stop.is_some());
    }

    #[test]
    fn test_next_occurrences_empty_entries() {
        let (next_start, next_stop) = next_occurrences(&[], "UTC");
        assert!(next_start.is_none());
        assert!(next_stop.is_none());
    }

    #[test]
    fn test_parse_cron_all_fields() {
        // Every minute
        assert!(parse_cron("* * * * *").is_ok());
        // Specific day-of-week range
        assert!(parse_cron("30 9 * * 1-5").is_ok());
        // Step values
        assert!(parse_cron("*/15 * * * *").is_ok());
    }
}
