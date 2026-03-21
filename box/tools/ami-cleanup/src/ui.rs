use std::collections::HashSet;

use crate::app::{AmiStatus, App, AppMode, SortField, SortOrder};
use crate::cli;
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Clear, Paragraph, Row, Table},
    Frame,
};

pub fn draw(frame: &mut Frame, app: &mut App) {
    match app.mode {
        AppMode::SelectOwner | AppMode::SelectConsumers => draw_profile_select(frame, app),
        AppMode::Scanning => draw_scanning(frame, app),
        _ => draw_main(frame, app),
    }
}

fn draw_profile_select(frame: &mut Frame, app: &mut App) {
    let is_owner = app.mode == AppMode::SelectOwner;
    let ps = &mut app.profile_selector;

    let chunks = Layout::vertical([
        Constraint::Length(3), // header
        Constraint::Min(5),    // list
        Constraint::Length(1), // help
    ])
    .split(frame.area());

    // Header
    let subtitle = if is_owner {
        " Select Owner Profile (AMI source) "
    } else {
        " Select Consumer Profiles (AMI usage check) "
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .title(build_title())
        .title_bottom(subtitle);

    let desc = if is_owner {
        "Choose the AWS profile that owns the AMIs"
    } else {
        let owner = ps.owner_profile.as_deref().unwrap_or("?");
        &format!("Owner: {owner}  |  Select profiles that use these AMIs (Space to toggle, Enter to proceed)")
    };
    // Need to handle the lifetime issue with format!
    let desc_line = if is_owner {
        Line::from(vec![Span::styled(
            format!(" {desc}"),
            Style::default().fg(Color::Yellow),
        )])
    } else {
        let owner = ps.owner_profile.as_deref().unwrap_or("?");
        Line::from(vec![
            Span::styled(" Owner: ", Style::default().fg(Color::DarkGray)),
            Span::styled(owner.to_string(), Style::default().fg(Color::Cyan)),
            Span::styled(
                "  |  Space to toggle, Enter to proceed",
                Style::default().fg(Color::Yellow),
            ),
        ])
    };
    let paragraph = Paragraph::new(desc_line).block(block);
    frame.render_widget(paragraph, chunks[0]);

    // Profile list
    let block = Block::default().borders(Borders::ALL).title(" Profiles ");
    let inner = block.inner(chunks[1]);
    frame.render_widget(block, chunks[1]);

    let visible_rows = inner.height as usize;
    ps.adjust_scroll(visible_rows);

    let lines: Vec<Line> = ps
        .profiles
        .iter()
        .enumerate()
        .skip(ps.scroll_offset)
        .take(visible_rows)
        .map(|(i, name)| {
            let is_cursor = i == ps.cursor;
            let is_owner_profile = ps.owner_profile.as_deref() == Some(name.as_str());

            let prefix = if is_owner {
                if is_cursor { " > " } else { "   " }.to_string()
            } else if is_owner_profile {
                " * ".to_string()
            } else if ps.selected[i] {
                " [x] ".to_string()
            } else {
                " [ ] ".to_string()
            };

            let suffix = if !is_owner && is_owner_profile {
                " (owner)"
            } else {
                ""
            };

            let style = if is_cursor {
                Style::default()
                    .bg(Color::DarkGray)
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD)
            } else if is_owner_profile && !is_owner {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default()
            };

            Line::from(vec![Span::styled(format!("{prefix}{name}{suffix}"), style)])
        })
        .collect();

    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, inner);

    // Help
    let help_text = if is_owner {
        " j/k Navigate  Enter Select  q Quit"
    } else {
        " j/k Navigate  Space Toggle  Enter Start scan  q Quit"
    };
    let help = Paragraph::new(Line::from(help_text)).style(Style::default().fg(Color::DarkGray));
    frame.render_widget(help, chunks[2]);
}

fn draw_scanning(frame: &mut Frame, app: &App) {
    let chunks = Layout::vertical([
        Constraint::Length(3), // header
        Constraint::Min(5),    // scan log
        Constraint::Length(1), // help
    ])
    .split(frame.area());

    // Header
    let elapsed = app.elapsed_secs();
    let block = Block::default().borders(Borders::ALL).title(build_title());
    let paragraph = Paragraph::new(Line::from(vec![
        Span::styled(
            format!(" {} ", app.header),
            Style::default().fg(Color::DarkGray),
        ),
        Span::styled(
            format!("Scanning... ({elapsed}s)"),
            Style::default().fg(Color::Yellow),
        ),
    ]))
    .block(block);
    frame.render_widget(paragraph, chunks[0]);

    // Scan log
    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Scan Progress ");
    let inner = block.inner(chunks[1]);
    frame.render_widget(block, chunks[1]);

    let max_lines = inner.height as usize;
    let start = app.scan_logs.len().saturating_sub(max_lines);
    let lines: Vec<Line> = app.scan_logs[start..]
        .iter()
        .map(|log| {
            if log.done {
                Line::from(vec![
                    Span::styled(" ✓ ", Style::default().fg(Color::Green)),
                    Span::styled(log.text.clone(), Style::default().fg(Color::Green)),
                ])
            } else {
                Line::from(vec![
                    Span::styled(
                        format!(" {} ", app.spinner_char()),
                        Style::default().fg(Color::Yellow),
                    ),
                    Span::styled(log.text.clone(), Style::default().fg(Color::Yellow)),
                ])
            }
        })
        .collect();

    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, inner);

    // Help
    let help = Paragraph::new(Line::from(" q Quit")).style(Style::default().fg(Color::DarkGray));
    frame.render_widget(help, chunks[2]);
}

fn draw_main(frame: &mut Frame, app: &mut App) {
    let chunks = Layout::vertical([
        Constraint::Length(3), // header
        Constraint::Min(5),    // table
        Constraint::Length(1), // help bar
    ])
    .split(frame.area());

    draw_header(frame, app, chunks[0]);
    draw_table(frame, app, chunks[1]);
    draw_help(frame, app, chunks[2]);

    if app.mode == AppMode::Confirm {
        draw_confirm(frame, app);
    }
}

fn draw_header(frame: &mut Frame, app: &App, area: Rect) {
    let s = &app.summary;
    let deleted = app.deleted_count();
    let failed = app.failed_count();

    let mut spans = vec![
        Span::styled(" Owned: ", Style::default().fg(Color::DarkGray)),
        Span::styled(s.total_owned.to_string(), Style::default().fg(Color::White)),
        Span::styled("  In-use: ", Style::default().fg(Color::DarkGray)),
        Span::styled(s.total_used.to_string(), Style::default().fg(Color::Green)),
        Span::styled("  Shared: ", Style::default().fg(Color::DarkGray)),
        Span::styled(
            s.total_shared.to_string(),
            Style::default().fg(Color::Yellow),
        ),
        Span::styled("  Managed: ", Style::default().fg(Color::DarkGray)),
        Span::styled(
            s.total_managed.to_string(),
            Style::default().fg(Color::Yellow),
        ),
        Span::styled("  Unused: ", Style::default().fg(Color::DarkGray)),
        Span::styled(s.total_unused.to_string(), Style::default().fg(Color::Red)),
        Span::styled(
            format!(" ({} snaps)", s.total_snapshots),
            Style::default().fg(Color::DarkGray),
        ),
    ];

    if deleted > 0 || failed > 0 {
        spans.push(Span::styled("  |  ", Style::default().fg(Color::DarkGray)));
        if deleted > 0 {
            spans.push(Span::styled(
                format!("Deleted: {deleted}"),
                Style::default().fg(Color::Green),
            ));
        }
        if failed > 0 {
            spans.push(Span::styled(
                format!("  Failed: {failed}"),
                Style::default().fg(Color::Red),
            ));
        }
    }

    let block = Block::default().borders(Borders::ALL).title(build_title());

    let paragraph = Paragraph::new(Line::from(spans)).block(block);
    frame.render_widget(paragraph, area);
}

fn draw_table(frame: &mut Frame, app: &mut App, area: Rect) {
    let title = if app.mode == AppMode::Done && app.rows.is_empty() {
        " No unused AMIs found ".to_string()
    } else {
        let sel = app.selected_count();
        let total = app.rows.len();
        let sel_gb = app.selected_size_gb();
        let total_gb = app.total_size_gb();
        let sort = app.sort_label();
        format!(" Unused AMIs ({sel}/{total} selected, {sel_gb}G/{total_gb}G){sort} ")
    };

    let block = Block::default().borders(Borders::ALL).title(title);

    let inner = block.inner(area);
    let visible_rows = inner.height.saturating_sub(1) as usize;
    app.adjust_scroll(visible_rows);

    let sort_field = app.sort_field;
    let sort_order = app.sort_order;
    let arrow = if sort_order == SortOrder::Desc {
        "↓"
    } else {
        "↑"
    };

    let header_style = Style::default()
        .fg(Color::Cyan)
        .add_modifier(Modifier::BOLD);
    let sort_style = Style::default()
        .fg(Color::Cyan)
        .bg(Color::DarkGray)
        .add_modifier(Modifier::BOLD);

    let hdr = |label: &str, field: SortField| -> Cell<'static> {
        if sort_field == field && sort_field != SortField::Default {
            Cell::from(format!("{label}{arrow}")).style(sort_style)
        } else {
            Cell::from(label.to_string()).style(header_style)
        }
    };

    let header = Row::new(vec![
        Cell::from("").style(header_style),
        hdr("AMI ID", SortField::Default),
        hdr("NAME", SortField::Name),
        hdr("AGE", SortField::Age),
        hdr("LAUNCHED", SortField::LastLaunched),
        hdr("SIZE", SortField::Size),
        Cell::from("SNAPS").style(header_style),
        Cell::from("STATUS").style(header_style),
    ]);

    // Compute bottom 25% by last_launched (oldest/never launched)
    let bottom_quartile: HashSet<usize> = if app.rows.len() >= 4 {
        let now = chrono::Utc::now();
        let mut indexed: Vec<(usize, i64)> = app
            .rows
            .iter()
            .enumerate()
            .map(|(i, row)| {
                let days_ago = row
                    .ami
                    .last_launched
                    .map(|d| (now - d).num_days())
                    .unwrap_or(i64::MAX);
                (i, days_ago)
            })
            .collect();
        indexed.sort_by(|a, b| b.1.cmp(&a.1));
        let count = ((app.rows.len() as f64) * 0.25).ceil() as usize;
        indexed.iter().take(count).map(|(i, _)| *i).collect()
    } else {
        HashSet::new()
    };

    let rows: Vec<Row> = app
        .rows
        .iter()
        .enumerate()
        .skip(app.scroll_offset)
        .take(visible_rows)
        .map(|(i, row)| {
            let check = if row.selected { "x" } else { "_" };
            let age = row
                .ami
                .creation_date
                .map(format_elapsed)
                .unwrap_or_else(|| "-".to_string());
            let launched = row
                .ami
                .last_launched
                .map(format_elapsed)
                .unwrap_or_else(|| "never".to_string());
            let snaps = row.ami.snapshot_ids.len().to_string();
            let status = match &row.status {
                AmiStatus::Pending => String::new(),
                AmiStatus::Deleting => "deleting..".to_string(),
                AmiStatus::Deleted => "deleted".to_string(),
                AmiStatus::Failed(e) => {
                    let short = if e.len() > 30 { &e[..30] } else { e };
                    format!("FAIL: {short}")
                }
            };

            let is_bottom_quartile = bottom_quartile.contains(&i);

            let style = if i == app.cursor {
                Style::default()
                    .bg(Color::DarkGray)
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD)
            } else {
                match &row.status {
                    AmiStatus::Deleted => Style::default().fg(Color::Green),
                    AmiStatus::Failed(_) => Style::default().fg(Color::Red),
                    AmiStatus::Deleting => Style::default().fg(Color::Yellow),
                    AmiStatus::Pending if is_bottom_quartile => {
                        Style::default().fg(Color::Rgb(255, 140, 0))
                    }
                    AmiStatus::Pending => Style::default(),
                }
            };

            let size = format!("{}G", row.ami.size_gb);

            let name = if row.ami.shared {
                format!("[S] {}", truncate(&row.ami.name, 40))
            } else {
                truncate(&row.ami.name, 44)
            };

            let cell = |text: String, field: SortField| -> Cell<'static> {
                if sort_field == field && sort_field != SortField::Default && i != app.cursor {
                    Cell::from(text).style(style.bg(Color::Rgb(30, 30, 50)))
                } else {
                    Cell::from(text).style(style)
                }
            };

            Row::new(vec![
                Cell::from(check.to_string()).style(style),
                Cell::from(row.ami.ami_id.clone()).style(style),
                cell(name, SortField::Name),
                cell(age, SortField::Age),
                cell(launched, SortField::LastLaunched),
                cell(size, SortField::Size),
                Cell::from(snaps).style(style),
                Cell::from(status).style(style),
            ])
        })
        .collect();

    let widths = [
        Constraint::Length(2),
        Constraint::Length(23),
        Constraint::Min(24),
        Constraint::Length(6),
        Constraint::Length(8),
        Constraint::Length(6),
        Constraint::Length(5),
        Constraint::Length(35),
    ];

    let table = Table::new(rows, widths).header(header).block(block);
    frame.render_widget(table, area);
}

fn draw_help(frame: &mut Frame, app: &App, area: Rect) {
    let chunks =
        Layout::horizontal([Constraint::Percentage(65), Constraint::Percentage(35)]).split(area);

    let keys = match app.mode {
        AppMode::SelectOwner | AppMode::SelectConsumers => "",
        AppMode::Scanning => " q Quit",
        AppMode::Browse => " j/k Navigate  Space Toggle  a Select All  s Sort  d Delete  q Quit",
        AppMode::Confirm => " y Confirm  any other key Cancel",
        AppMode::Done => " q Quit",
    };
    let help = Paragraph::new(Line::from(keys)).style(Style::default().fg(Color::DarkGray));
    frame.render_widget(help, chunks[0]);

    if app.mode == AppMode::Browse || app.mode == AppMode::Confirm {
        let monthly = app.selected_size_gb() as f64 * 0.05;
        let yearly = monthly * 12.0;

        let summary = Line::from(vec![Span::styled(
            format!("~${monthly:.2}/mo ${yearly:.0}/yr "),
            Style::default().fg(Color::Green),
        )]);
        let paragraph = Paragraph::new(summary).alignment(ratatui::layout::Alignment::Right);
        frame.render_widget(paragraph, chunks[1]);
    }
}

fn draw_confirm(frame: &mut Frame, app: &App) {
    let width = 50u16;
    let height = 5u16;
    let area = centered_rect(width, height, frame.area());

    frame.render_widget(Clear, area);

    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Confirm Delete ")
        .style(Style::default().fg(Color::Yellow));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = vec![
        Line::from(""),
        Line::from(vec![
            Span::raw("  Delete "),
            Span::styled(
                format!("{}", app.selected_count()),
                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            ),
            Span::raw(" AMI(s) + "),
            Span::styled(
                format!("{}", app.selected_snapshot_count()),
                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            ),
            Span::raw(" snapshot(s)?  [y/N]"),
        ]),
    ];

    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, inner);
}

fn centered_rect(width: u16, height: u16, area: Rect) -> Rect {
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = area.y + area.height.saturating_sub(height) / 2;
    Rect::new(x, y, width.min(area.width), height.min(area.height))
}

fn build_title() -> String {
    format!(" {} v{} ({}) ", cli::APP_NAME, cli::VERSION, cli::COMMIT)
}

fn format_elapsed(dt: chrono::DateTime<chrono::Utc>) -> String {
    let dur = chrono::Utc::now() - dt;
    let days = dur.num_days();
    if days >= 1 {
        format!("{days}d")
    } else {
        format!("{}h", dur.num_hours())
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() > max {
        format!("{}...", &s[..max - 3])
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use ratatui::layout::Rect;

    #[test]
    fn test_format_elapsed_days() {
        let dt = Utc::now() - Duration::days(5);
        assert_eq!(format_elapsed(dt), "5d");
    }

    #[test]
    fn test_format_elapsed_hours() {
        let dt = Utc::now() - Duration::hours(12);
        assert_eq!(format_elapsed(dt), "12h");
    }

    #[test]
    fn test_format_elapsed_zero_hours() {
        let dt = Utc::now() - Duration::minutes(30);
        assert_eq!(format_elapsed(dt), "0h");
    }

    #[test]
    fn test_format_elapsed_large_days() {
        let dt = Utc::now() - Duration::days(365);
        assert_eq!(format_elapsed(dt), "365d");
    }

    #[test]
    fn test_truncate_short_string() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_exact_length() {
        assert_eq!(truncate("hello", 5), "hello");
    }

    #[test]
    fn test_truncate_long_string() {
        assert_eq!(truncate("hello world", 8), "hello...");
    }

    #[test]
    fn test_truncate_very_short_max() {
        assert_eq!(truncate("hello", 4), "h...");
    }

    #[test]
    fn test_centered_rect() {
        let area = Rect::new(0, 0, 100, 50);
        let result = centered_rect(50, 10, area);
        assert_eq!(result.x, 25);
        assert_eq!(result.y, 20);
        assert_eq!(result.width, 50);
        assert_eq!(result.height, 10);
    }

    #[test]
    fn test_centered_rect_larger_than_area() {
        let area = Rect::new(0, 0, 30, 20);
        let result = centered_rect(50, 30, area);
        assert_eq!(result.x, 0);
        assert_eq!(result.y, 0);
        assert_eq!(result.width, 30);
        assert_eq!(result.height, 20);
    }

    #[test]
    fn test_centered_rect_with_offset() {
        let area = Rect::new(10, 5, 100, 50);
        let result = centered_rect(20, 10, area);
        assert_eq!(result.x, 50);
        assert_eq!(result.y, 25);
        assert_eq!(result.width, 20);
        assert_eq!(result.height, 10);
    }
}
