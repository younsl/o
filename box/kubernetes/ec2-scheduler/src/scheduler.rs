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
}
