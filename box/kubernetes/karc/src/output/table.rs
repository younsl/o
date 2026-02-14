//! Status table and schedule timetable rendering.
//!
//! Renders NodePool status and disruption schedule budgets as
//! kubectl-style tables with timezone-aware window display.

use std::collections::HashMap;

use colored::Colorize;
use tabled::settings::Style;
use tabled::{Table, Tabled};

use crate::k8s::nodepool::{format_budgets_summary, is_pause_budget, NodePoolInfo};

/// Row for the NodePool status table.
#[derive(Tabled)]
struct NodePoolRow {
    #[tabled(rename = "NODEPOOL")]
    nodepool: String,
    #[tabled(rename = "WEIGHT")]
    weight: String,
    #[tabled(rename = "POLICY")]
    policy: String,
    #[tabled(rename = "AFTER")]
    consolidate_after: String,
    #[tabled(rename = "BUDGETS")]
    budgets: String,
    #[tabled(rename = "NODECLAIMS")]
    nodeclaims: String,
    #[tabled(rename = "STATE")]
    state: String,
}

/// Row for the disruption schedule timetable.
#[derive(Tabled)]
struct ScheduleRow {
    #[tabled(rename = "NODEPOOL")]
    nodepool: String,
    #[tabled(rename = "WINDOW")]
    window: String,
    #[tabled(rename = "DUR")]
    duration: String,
    #[tabled(rename = "EMPTY")]
    empty: String,
    #[tabled(rename = "DRIFTED")]
    drifted: String,
    #[tabled(rename = "UNDERUTILIZED")]
    underutilized: String,
    #[tabled(rename = "EXPIRED")]
    expired: String,
    #[tabled(rename = "STATE")]
    state: String,
}

/// Print the NodePool status table and schedule timetable.
pub fn print_status(
    nodepools: &[NodePoolInfo],
    nodeclaim_counts: &HashMap<String, usize>,
    context_name: &str,
    timezone: &str,
    api_version: &str,
) {
    if nodepools.is_empty() {
        println!("No NodePools found.");
        return;
    }

    // Build status table rows
    let rows: Vec<NodePoolRow> = nodepools
        .iter()
        .map(|np| {
            let count = nodeclaim_counts.get(&np.name).copied().unwrap_or(0);

            let state = if np.is_paused {
                "Paused".red().to_string()
            } else {
                "Active".green().to_string()
            };

            let weight = np
                .weight
                .map(|w| w.to_string())
                .unwrap_or_else(|| "-".to_string());

            NodePoolRow {
                nodepool: np.name.clone(),
                weight,
                policy: np.disruption.consolidation_policy.clone(),
                consolidate_after: np.disruption.consolidate_after.clone(),
                budgets: format_budgets_summary(&np.disruption.budgets),
                nodeclaims: count.to_string(),
                state,
            }
        })
        .collect();

    let total_nodeclaims: usize = nodeclaim_counts.values().sum();
    println!(
        "{} (context: {}, {} nodepools, {} nodeclaims):",
        format!("NodePools/{}", api_version).bold(),
        context_name,
        nodepools.len(),
        total_nodeclaims
    );

    let mut table = Table::new(&rows);
    apply_table_style(&mut table);
    println!("{}", table);

    // Build schedule timetable
    let schedule_rows = build_schedule_rows(nodepools, timezone);
    if schedule_rows.is_empty() {
        return;
    }

    let tz_label = if timezone == "UTC" {
        "UTC".to_string()
    } else {
        timezone.to_string()
    };

    println!();
    println!("Disruption Schedules ({}):", tz_label.bold());

    let mut sched_table = Table::new(&schedule_rows);
    apply_table_style(&mut sched_table);
    println!("{}", sched_table);
}

/// Build schedule rows from NodePools that have scheduled budgets.
/// When no scheduled window is active for a NodePool, appends a fallback row
/// showing the default (non-scheduled) budget.
fn build_schedule_rows(nodepools: &[NodePoolInfo], timezone: &str) -> Vec<ScheduleRow> {
    let mut rows = Vec::new();

    for np in nodepools {
        let mut has_scheduled = false;
        let mut any_active = false;

        for budget in &np.disruption.budgets {
            if budget.schedule.is_none() || is_pause_budget(budget) {
                continue;
            }

            has_scheduled = true;
            let schedule = budget.schedule.as_deref().unwrap_or("");
            let duration = budget.duration.as_deref().unwrap_or("0s");
            let nodes = budget.nodes.as_deref().unwrap_or("10%");

            let window = format_cron_window(schedule, duration, timezone);
            let active = is_window_active(schedule, duration, timezone);
            if active {
                any_active = true;
            }

            let (empty, drifted, underutilized, expired) =
                format_reason_columns(nodes, &budget.reasons);

            let state = if active {
                "Active".green().to_string()
            } else {
                "-".to_string()
            };

            rows.push(ScheduleRow {
                nodepool: np.name.clone(),
                window,
                duration: duration.to_string(),
                empty,
                drifted,
                underutilized,
                expired,
                state,
            });
        }

        // When scheduled budgets exist but none are currently active,
        // show a Fallback row. If no explicit default (non-scheduled) budget exists,
        // Karpenter allows unbounded disruptions outside schedule windows.
        if has_scheduled && !any_active {
            let default_budget = np
                .disruption
                .budgets
                .iter()
                .find(|b| b.schedule.is_none() && !is_pause_budget(b));

            let (nodes, reasons) = match &default_budget {
                Some(b) => (b.nodes.as_deref().unwrap_or("10%"), b.reasons.as_slice()),
                None => ("∞", &[] as &[String]),
            };

            let (empty, drifted, underutilized, expired) = format_reason_columns(nodes, reasons);

            rows.push(ScheduleRow {
                nodepool: np.name.clone(),
                window: "Fallback".yellow().to_string(),
                duration: "-".to_string(),
                empty,
                drifted,
                underutilized,
                expired,
                state: "Active".green().to_string(),
            });
        }
    }

    rows
}

/// Format reason columns based on budget reasons.
///
/// If reasons is empty, all columns get the same value (applies to all reasons).
/// If specific reasons are listed, only those columns get the value.
fn format_reason_columns(nodes: &str, reasons: &[String]) -> (String, String, String, String) {
    if reasons.is_empty() {
        // No reasons specified = applies to all
        let val = nodes.to_string();
        return (val.clone(), val.clone(), val.clone(), val);
    }

    let has = |r: &str| reasons.iter().any(|s| s.eq_ignore_ascii_case(r));

    let fmt = |matched: bool| -> String {
        if matched {
            nodes.to_string()
        } else {
            "-".to_string()
        }
    };

    (
        fmt(has("Empty")),
        fmt(has("Drifted")),
        fmt(has("Underutilized")),
        fmt(has("Expired")),
    )
}

/// Convert a cron schedule + duration into a human-readable time window.
///
/// Examples:
///   - "0 9 * * 5" + "8h" => "Fri 09:00 - 17:00"
///   - "0 0 * * 1-5" + "2h" => "Mon-Fri 00:00 - 02:00"
///   - "0 22 * * *" + "4h" => "Daily 22:00 - 02:00"
pub fn format_cron_window(cron_expr: &str, duration: &str, timezone: &str) -> String {
    let parts: Vec<&str> = cron_expr.split_whitespace().collect();
    if parts.len() != 5 {
        return format!("{} + {}", cron_expr, duration);
    }

    let minute = parts[0].parse::<u32>().unwrap_or(0);
    let hour = parts[1].parse::<u32>().unwrap_or(0);
    let dow = parts[4]; // day of week

    let duration_hours = parse_duration_hours(duration);

    // Apply timezone offset
    let (start_hour, start_minute, tz_dow) = apply_timezone(hour, minute, dow, timezone);

    let end_total_minutes =
        (start_hour as u64) * 60 + (start_minute as u64) + (duration_hours * 60.0) as u64;
    let end_hour = (end_total_minutes / 60) % 24;
    let end_minute = end_total_minutes % 60;

    let day_label = format_dow(tz_dow);
    let start_time = format!("{:02}:{:02}", start_hour, start_minute);
    let end_time = format!("{:02}:{:02}", end_hour, end_minute);

    format!("{} {} - {}", day_label, start_time, end_time)
}

/// Check if the current time falls within the cron schedule window.
///
/// Compares the current time (in the given timezone) against
/// the window start (cron hour:minute) and start + duration.
/// Day-of-week matching uses the cron DOW field.
fn is_window_active(cron_expr: &str, duration: &str, timezone: &str) -> bool {
    use chrono::{Datelike, Utc};
    use chrono_tz::Tz;

    let parts: Vec<&str> = cron_expr.split_whitespace().collect();
    if parts.len() != 5 {
        return false;
    }

    let cron_minute = match parts[0].parse::<u32>() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let cron_hour = match parts[1].parse::<u32>() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let cron_dow = parts[4];

    let duration_minutes = (parse_duration_hours(duration) * 60.0) as i64;
    if duration_minutes == 0 {
        return false;
    }

    // Get current time in UTC and the cron schedule start in UTC
    let now_utc = Utc::now();

    // The cron schedule is defined in UTC; convert "now" to the display timezone
    // only for output, but the actual comparison is done in UTC.
    // Start time today in UTC
    let today_utc = now_utc.date_naive();
    let start_naive = today_utc.and_hms_opt(cron_hour, cron_minute, 0).unwrap();
    let start_utc = start_naive.and_utc();

    // Check today and yesterday (window may have started yesterday and span midnight)
    for day_offset in [0i64, -1] {
        let candidate = start_utc + chrono::Duration::days(day_offset);
        let end = candidate + chrono::Duration::minutes(duration_minutes);

        if now_utc >= candidate && now_utc < end {
            // Check day-of-week matches the candidate day
            let candidate_dow = match timezone.parse::<Tz>() {
                Ok(tz) => {
                    let local = candidate.with_timezone(&tz);
                    local.weekday().num_days_from_sunday() // 0=Sun
                }
                Err(_) => candidate.weekday().num_days_from_sunday(),
            };

            if matches_dow(cron_dow, candidate_dow) {
                return true;
            }
        }
    }

    false
}

/// Check if a weekday number matches a cron DOW field.
fn matches_dow(cron_dow: &str, weekday: u32) -> bool {
    match cron_dow {
        "*" => true,
        single if !single.contains('-') && !single.contains(',') => {
            let d = single.parse::<u32>().unwrap_or(99);
            // cron: 0 and 7 both mean Sunday
            weekday == d || (weekday == 0 && d == 7) || (weekday == 7 && d == 0)
        }
        range if range.contains('-') && !range.contains(',') => {
            let parts: Vec<&str> = range.split('-').collect();
            if parts.len() == 2 {
                let start = parts[0].parse::<u32>().unwrap_or(0);
                let end = parts[1].parse::<u32>().unwrap_or(0);
                weekday >= start && weekday <= end
            } else {
                false
            }
        }
        list => list.split(',').any(|d| {
            let d = d.trim().parse::<u32>().unwrap_or(99);
            weekday == d || (weekday == 0 && d == 7) || (weekday == 7 && d == 0)
        }),
    }
}

/// Parse duration string (e.g., "8h", "30m", "2h30m") into hours as f64.
pub fn parse_duration_hours(duration: &str) -> f64 {
    let mut hours: f64 = 0.0;
    let mut current_num = String::new();

    for ch in duration.chars() {
        if ch.is_ascii_digit() {
            current_num.push(ch);
        } else if ch == 'h' || ch == 'H' {
            hours += current_num.parse::<f64>().unwrap_or(0.0);
            current_num.clear();
        } else if ch == 'm' || ch == 'M' {
            hours += current_num.parse::<f64>().unwrap_or(0.0) / 60.0;
            current_num.clear();
        } else if ch == 'd' || ch == 'D' {
            hours += current_num.parse::<f64>().unwrap_or(0.0) * 24.0;
            current_num.clear();
        } else if ch == 's' || ch == 'S' {
            hours += current_num.parse::<f64>().unwrap_or(0.0) / 3600.0;
            current_num.clear();
        }
    }

    hours
}

/// Apply timezone offset to hour/minute/dow.
///
/// Returns (adjusted_hour, adjusted_minute, adjusted_dow_str).
fn apply_timezone<'a>(hour: u32, minute: u32, dow: &'a str, timezone: &str) -> (u32, u32, &'a str) {
    if timezone == "UTC" {
        return (hour, minute, dow);
    }

    let offset_hours = get_timezone_offset_hours(timezone);
    if offset_hours == 0 {
        return (hour, minute, dow);
    }

    let total_minutes = hour as i32 * 60 + minute as i32 + offset_hours * 60;
    let adjusted_minutes = total_minutes.rem_euclid(24 * 60);
    let new_hour = (adjusted_minutes / 60) as u32;
    let new_minute = (adjusted_minutes % 60) as u32;

    // Day shift is complex for DOW ranges; keep original for simplicity
    // since exact day math with cron DOW patterns would need full cron parsing
    (new_hour, new_minute, dow)
}

/// Get UTC offset in whole hours for common timezones.
///
/// Uses chrono-tz for accurate timezone resolution.
fn get_timezone_offset_hours(timezone: &str) -> i32 {
    use chrono::{Offset, Utc};
    use chrono_tz::Tz;

    match timezone.parse::<Tz>() {
        Ok(tz) => {
            let now = Utc::now().with_timezone(&tz);
            let offset_secs = now.offset().fix().local_minus_utc();
            offset_secs / 3600
        }
        Err(_) => 0,
    }
}

/// Format day-of-week cron field into human-readable label.
fn format_dow(dow: &str) -> String {
    match dow {
        "*" => "Daily".to_string(),
        "0" => "Sun".to_string(),
        "1" => "Mon".to_string(),
        "2" => "Tue".to_string(),
        "3" => "Wed".to_string(),
        "4" => "Thu".to_string(),
        "5" => "Fri".to_string(),
        "6" => "Sat".to_string(),
        "7" => "Sun".to_string(),
        "1-5" => "Mon-Fri".to_string(),
        "0-6" | "0-7" => "Daily".to_string(),
        range if range.contains('-') => {
            let parts: Vec<&str> = range.split('-').collect();
            if parts.len() == 2 {
                let start = dow_name(parts[0]);
                let end = dow_name(parts[1]);
                format!("{}-{}", start, end)
            } else {
                dow.to_string()
            }
        }
        list if list.contains(',') => {
            let names: Vec<String> = list.split(',').map(|d| dow_name(d.trim())).collect();
            names.join(",")
        }
        _ => dow.to_string(),
    }
}

/// Convert a single day-of-week number to its 3-letter abbreviation.
fn dow_name(d: &str) -> String {
    match d {
        "0" | "7" => "Sun".to_string(),
        "1" => "Mon".to_string(),
        "2" => "Tue".to_string(),
        "3" => "Wed".to_string(),
        "4" => "Thu".to_string(),
        "5" => "Fri".to_string(),
        "6" => "Sat".to_string(),
        _ => d.to_string(),
    }
}

/// Apply kubectl-style table formatting: no borders, no separators, 2-space column gap.
fn apply_table_style(table: &mut Table) {
    use tabled::settings::object::Columns;
    use tabled::settings::themes::Theme;
    use tabled::settings::{Modify, Padding};

    let mut theme = Theme::from_style(Style::empty());
    theme.remove_horizontal_lines();
    table.with(theme);
    table.with(Modify::new(Columns::new(..)).with(Padding::new(0, 2, 0, 0)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_duration_hours_simple() {
        assert!((parse_duration_hours("8h") - 8.0).abs() < f64::EPSILON);
        assert!((parse_duration_hours("2h") - 2.0).abs() < f64::EPSILON);
        assert!((parse_duration_hours("1h") - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_parse_duration_hours_minutes() {
        assert!((parse_duration_hours("30m") - 0.5).abs() < f64::EPSILON);
        assert!((parse_duration_hours("90m") - 1.5).abs() < f64::EPSILON);
    }

    #[test]
    fn test_parse_duration_hours_combined() {
        assert!((parse_duration_hours("2h30m") - 2.5).abs() < f64::EPSILON);
        assert!((parse_duration_hours("1h15m") - 1.25).abs() < f64::EPSILON);
    }

    #[test]
    fn test_parse_duration_hours_days() {
        assert!((parse_duration_hours("1d") - 24.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_parse_duration_hours_zero() {
        assert!((parse_duration_hours("0h")).abs() < f64::EPSILON);
        assert!((parse_duration_hours("0s")).abs() < f64::EPSILON);
    }

    #[test]
    fn test_format_dow_star() {
        assert_eq!(format_dow("*"), "Daily");
    }

    #[test]
    fn test_format_dow_single() {
        assert_eq!(format_dow("1"), "Mon");
        assert_eq!(format_dow("5"), "Fri");
        assert_eq!(format_dow("0"), "Sun");
        assert_eq!(format_dow("7"), "Sun");
    }

    #[test]
    fn test_format_dow_range() {
        assert_eq!(format_dow("1-5"), "Mon-Fri");
        assert_eq!(format_dow("2-4"), "Tue-Thu");
    }

    #[test]
    fn test_format_dow_list() {
        assert_eq!(format_dow("1,3,5"), "Mon,Wed,Fri");
    }

    #[test]
    fn test_format_cron_window_friday() {
        let window = format_cron_window("0 9 * * 5", "8h", "UTC");
        assert_eq!(window, "Fri 09:00 - 17:00");
    }

    #[test]
    fn test_format_cron_window_weekdays() {
        let window = format_cron_window("0 0 * * 1-5", "2h", "UTC");
        assert_eq!(window, "Mon-Fri 00:00 - 02:00");
    }

    #[test]
    fn test_format_cron_window_daily_overnight() {
        let window = format_cron_window("0 22 * * *", "4h", "UTC");
        assert_eq!(window, "Daily 22:00 - 02:00");
    }

    #[test]
    fn test_format_cron_window_with_minutes() {
        let window = format_cron_window("30 10 * * *", "1h30m", "UTC");
        assert_eq!(window, "Daily 10:30 - 12:00");
    }

    #[test]
    fn test_format_reason_columns_all() {
        let (e, d, u, x) = format_reason_columns("5", &[]);
        assert_eq!(e, "5");
        assert_eq!(d, "5");
        assert_eq!(u, "5");
        assert_eq!(x, "5");
    }

    #[test]
    fn test_format_reason_columns_specific() {
        let reasons = vec!["Underutilized".to_string()];
        let (e, d, u, x) = format_reason_columns("0", &reasons);
        assert_eq!(e, "-");
        assert_eq!(d, "-");
        assert_eq!(u, "0");
        assert_eq!(x, "-");
    }

    #[test]
    fn test_format_reason_columns_multiple() {
        let reasons = vec!["Empty".to_string(), "Drifted".to_string()];
        let (e, d, u, x) = format_reason_columns("3", &reasons);
        assert_eq!(e, "3");
        assert_eq!(d, "3");
        assert_eq!(u, "-");
        assert_eq!(x, "-");
    }

    #[test]
    fn test_format_reason_columns_case_insensitive() {
        let reasons = vec!["empty".to_string(), "DRIFTED".to_string()];
        let (e, d, u, x) = format_reason_columns("3", &reasons);
        assert_eq!(e, "3");
        assert_eq!(d, "3");
        assert_eq!(u, "-");
        assert_eq!(x, "-");
    }

    #[test]
    fn test_dow_name() {
        assert_eq!(dow_name("0"), "Sun");
        assert_eq!(dow_name("1"), "Mon");
        assert_eq!(dow_name("6"), "Sat");
        assert_eq!(dow_name("7"), "Sun");
    }

    #[test]
    fn test_format_cron_window_invalid() {
        let window = format_cron_window("invalid", "1h", "UTC");
        assert_eq!(window, "invalid + 1h");
    }

    #[test]
    fn test_matches_dow_star() {
        for d in 0..=6 {
            assert!(matches_dow("*", d));
        }
    }

    #[test]
    fn test_matches_dow_single() {
        assert!(matches_dow("1", 1));
        assert!(!matches_dow("1", 2));
        // 0 and 7 both mean Sunday
        assert!(matches_dow("0", 0));
        assert!(matches_dow("7", 0));
        assert!(matches_dow("0", 7));
    }

    #[test]
    fn test_matches_dow_range() {
        assert!(matches_dow("1-5", 1));
        assert!(matches_dow("1-5", 3));
        assert!(matches_dow("1-5", 5));
        assert!(!matches_dow("1-5", 0));
        assert!(!matches_dow("1-5", 6));
    }

    #[test]
    fn test_matches_dow_list() {
        assert!(matches_dow("1,3,5", 1));
        assert!(matches_dow("1,3,5", 3));
        assert!(!matches_dow("1,3,5", 2));
    }

    #[test]
    fn test_is_window_active_invalid_cron() {
        assert!(!is_window_active("invalid", "1h", "UTC"));
    }

    #[test]
    fn test_is_window_active_zero_duration() {
        assert!(!is_window_active("0 0 * * *", "0s", "UTC"));
    }
}
