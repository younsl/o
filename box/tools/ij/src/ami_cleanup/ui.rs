use std::collections::HashSet;

use super::app::{AmiStatus, App, AppMode, SortField, SortOrder};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Clear, Paragraph, Row, Table},
};

pub fn draw(frame: &mut Frame, app: &mut App, area: Rect) {
    match app.mode {
        AppMode::SelectOwner | AppMode::SelectConsumers => draw_profile_select(frame, app, area),
        AppMode::Scanning => draw_scanning(frame, app, area),
        _ => draw_main(frame, app, area),
    }
}

fn draw_profile_select(frame: &mut Frame, app: &mut App, area: Rect) {
    let is_owner = app.mode == AppMode::SelectOwner;
    let ps = &mut app.profile_selector;

    let chunks = Layout::vertical([
        Constraint::Length(1), // description
        Constraint::Min(5),    // list
        Constraint::Length(1), // help
    ])
    .split(area);

    // Description line
    let desc_line = if is_owner {
        Line::from(vec![Span::styled(
            " Select Owner Profile (AMI source)",
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
    frame.render_widget(Paragraph::new(desc_line), chunks[0]);

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

fn draw_scanning(frame: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::vertical([
        Constraint::Length(1), // header
        Constraint::Min(5),    // scan log
        Constraint::Length(1), // help
    ])
    .split(area);

    // Header line
    let elapsed = app.elapsed_secs();
    let header = Line::from(vec![
        Span::styled(
            format!(" {} ", app.header),
            Style::default().fg(Color::DarkGray),
        ),
        Span::styled(
            format!("Scanning... ({elapsed}s)"),
            Style::default().fg(Color::Yellow),
        ),
    ]);
    frame.render_widget(Paragraph::new(header), chunks[0]);

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

fn draw_main(frame: &mut Frame, app: &mut App, area: Rect) {
    let chunks = Layout::vertical([
        Constraint::Length(1), // header
        Constraint::Min(5),    // table
        Constraint::Length(1), // help bar
    ])
    .split(area);

    draw_header(frame, app, chunks[0]);
    draw_table(frame, app, chunks[1]);
    draw_help(frame, app, chunks[2]);

    if app.mode == AppMode::Confirm {
        draw_confirm(frame, app, area);
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

    let paragraph = Paragraph::new(Line::from(spans));
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
        indexed.sort_by_key(|b| std::cmp::Reverse(b.1));
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

fn draw_confirm(frame: &mut Frame, app: &App, parent_area: Rect) {
    let width = 50u16;
    let height = 5u16;
    let area = centered_rect(width, height, parent_area);

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
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    use super::super::ami::OwnedAmi;
    use super::super::app::{AmiRow, ScanSummary};

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

    // -- Helper functions for draw tests --

    fn make_test_ami(
        id: &str,
        name: &str,
        size_gb: i64,
        snap_count: usize,
        shared: bool,
    ) -> OwnedAmi {
        OwnedAmi {
            ami_id: id.to_string(),
            name: name.to_string(),
            creation_date: Some(Utc::now() - Duration::days(30)),
            last_launched: Some(Utc::now() - Duration::days(10)),
            snapshot_ids: (0..snap_count).map(|i| format!("snap-{id}-{i}")).collect(),
            size_gb,
            shared,
            managed: false,
        }
    }

    fn make_row(
        id: &str,
        name: &str,
        size_gb: i64,
        snaps: usize,
        status: AmiStatus,
        selected: bool,
    ) -> AmiRow {
        AmiRow {
            region: "us-east-1".to_string(),
            ami: make_test_ami(id, name, size_gb, snaps, false),
            age_days: Some(30),
            selected,
            status,
        }
    }

    fn browse_app(rows: Vec<AmiRow>) -> App {
        let mut app = App::new_scanning("123456789012 (profile: test)".into());
        app.mode = AppMode::Browse;
        let total_unused = rows.len();
        let total_snapshots: usize = rows.iter().map(|r| r.ami.snapshot_ids.len()).sum();
        app.rows = rows;
        app.summary = ScanSummary {
            total_owned: 10,
            total_used: 5,
            total_shared: 1,
            total_managed: 1,
            total_unused,
            total_snapshots,
        };
        app
    }

    // -- draw: SelectOwner mode --

    #[test]
    fn test_draw_select_owner_mode() {
        let mut app = App::new_select_profile(vec!["prod".into(), "dev".into(), "staging".into()]);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_select_owner_cursor_moved() {
        let mut app = App::new_select_profile(vec!["prod".into(), "dev".into(), "staging".into()]);
        app.profile_selector.cursor = 2;
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    // -- draw: SelectConsumers mode --

    #[test]
    fn test_draw_select_consumers_mode() {
        let mut app = App::new_select_profile(vec!["prod".into(), "dev".into(), "staging".into()]);
        app.profile_selector.owner_profile = Some("prod".into());
        app.profile_selector.selected[1] = true;
        app.mode = AppMode::SelectConsumers;
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_select_consumers_cursor_on_owner() {
        let mut app = App::new_select_profile(vec!["prod".into(), "dev".into()]);
        app.profile_selector.owner_profile = Some("prod".into());
        app.profile_selector.cursor = 0;
        app.mode = AppMode::SelectConsumers;
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_select_consumers_owner_not_cursor() {
        let mut app = App::new_select_profile(vec!["prod".into(), "dev".into(), "staging".into()]);
        app.profile_selector.owner_profile = Some("prod".into());
        app.profile_selector.cursor = 1;
        app.mode = AppMode::SelectConsumers;
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    // -- draw: Scanning mode --

    #[test]
    fn test_draw_scanning_mode() {
        let mut app = App::new_scanning("test-account".into());
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_scanning_with_mixed_logs() {
        let mut app = App::new_scanning("test-account".into());
        app.add_scan_log("Step 1 done".into());
        app.finish_scan_log("Step 1 completed".into());
        app.add_scan_log("Step 2 in progress".into());
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    // -- draw: Browse mode --

    #[test]
    fn test_draw_browse_with_rows() {
        let rows = vec![
            make_row("ami-1", "test-ami-1", 8, 2, AmiStatus::Pending, false),
            make_row("ami-2", "test-ami-2", 16, 1, AmiStatus::Pending, true),
            make_row("ami-3", "deleted-ami", 8, 1, AmiStatus::Deleted, false),
            make_row(
                "ami-4",
                "failed-ami",
                4,
                0,
                AmiStatus::Failed("access denied".into()),
                false,
            ),
            make_row("ami-5", "deleting-ami", 10, 1, AmiStatus::Deleting, true),
        ];
        let mut app = browse_app(rows);
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_browse_bottom_quartile() {
        let now = Utc::now();
        let mut rows = vec![
            make_row("ami-1", "recent", 8, 1, AmiStatus::Pending, false),
            make_row("ami-2", "medium", 8, 1, AmiStatus::Pending, false),
            make_row("ami-3", "old", 8, 1, AmiStatus::Pending, false),
            make_row("ami-4", "ancient", 8, 1, AmiStatus::Pending, false),
            make_row("ami-5", "never-launched", 8, 1, AmiStatus::Pending, false),
        ];
        rows[0].ami.last_launched = Some(now - Duration::days(1));
        rows[1].ami.last_launched = Some(now - Duration::days(30));
        rows[2].ami.last_launched = Some(now - Duration::days(90));
        rows[3].ami.last_launched = Some(now - Duration::days(365));
        rows[4].ami.last_launched = None;
        let mut app = browse_app(rows);
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_browse_shared_ami() {
        let rows = vec![AmiRow {
            region: "us-east-1".into(),
            ami: make_test_ami("ami-1", "shared-test-ami", 8, 2, true),
            age_days: Some(30),
            selected: false,
            status: AmiStatus::Pending,
        }];
        let mut app = browse_app(rows);
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_browse_sorted_by_age() {
        let rows = vec![
            make_row("ami-1", "test", 8, 1, AmiStatus::Pending, false),
            make_row("ami-2", "test2", 16, 1, AmiStatus::Pending, false),
        ];
        let mut app = browse_app(rows);
        app.sort_field = SortField::Age;
        app.sort_order = SortOrder::Desc;
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_browse_sorted_by_name_asc() {
        let rows = vec![
            make_row("ami-1", "alpha", 8, 1, AmiStatus::Pending, false),
            make_row("ami-2", "beta", 16, 1, AmiStatus::Pending, false),
        ];
        let mut app = browse_app(rows);
        app.sort_field = SortField::Name;
        app.sort_order = SortOrder::Asc;
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_browse_sorted_by_size() {
        let rows = vec![
            make_row("ami-1", "small", 4, 1, AmiStatus::Pending, false),
            make_row("ami-2", "large", 100, 1, AmiStatus::Pending, false),
        ];
        let mut app = browse_app(rows);
        app.sort_field = SortField::Size;
        app.sort_order = SortOrder::Desc;
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_browse_sorted_by_last_launched() {
        let rows = vec![
            make_row("ami-1", "test", 8, 1, AmiStatus::Pending, false),
            make_row("ami-2", "test2", 16, 1, AmiStatus::Pending, false),
        ];
        let mut app = browse_app(rows);
        app.sort_field = SortField::LastLaunched;
        app.sort_order = SortOrder::Asc;
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    // -- draw: header with deletions --

    #[test]
    fn test_draw_header_with_deletions() {
        let rows = vec![
            make_row("ami-1", "test", 8, 1, AmiStatus::Deleted, false),
            make_row(
                "ami-2",
                "test2",
                16,
                1,
                AmiStatus::Failed("err".into()),
                false,
            ),
            make_row("ami-3", "test3", 4, 1, AmiStatus::Pending, true),
        ];
        let mut app = browse_app(rows);
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_header_deleted_only() {
        let rows = vec![make_row("ami-1", "test", 8, 1, AmiStatus::Deleted, false)];
        let mut app = browse_app(rows);
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    // -- draw: Confirm mode --

    #[test]
    fn test_draw_confirm_mode() {
        let rows = vec![
            make_row("ami-1", "test", 8, 2, AmiStatus::Pending, true),
            make_row("ami-2", "test2", 16, 1, AmiStatus::Pending, true),
        ];
        let mut app = browse_app(rows);
        app.mode = AppMode::Confirm;
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    // -- draw: Done mode --

    #[test]
    fn test_draw_done_empty() {
        let mut app = browse_app(vec![]);
        app.mode = AppMode::Done;
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    // -- draw: edge cases --

    #[test]
    fn test_draw_browse_failed_long_error() {
        let rows = vec![make_row(
            "ami-1",
            "test",
            8,
            1,
            AmiStatus::Failed(
                "This is a very long error message that exceeds thirty characters easily".into(),
            ),
            false,
        )];
        let mut app = browse_app(rows);
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_browse_no_creation_date() {
        let mut ami = make_test_ami("ami-1", "no-date", 8, 1, false);
        ami.creation_date = None;
        ami.last_launched = None;
        let rows = vec![AmiRow {
            region: "us-east-1".into(),
            ami,
            age_days: None,
            selected: false,
            status: AmiStatus::Pending,
        }];
        let mut app = browse_app(rows);
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_browse_long_name_truncated() {
        let rows = vec![make_row(
            "ami-1",
            "this-is-a-very-long-ami-name-that-should-be-truncated-at-some-point",
            8,
            1,
            AmiStatus::Pending,
            false,
        )];
        let mut app = browse_app(rows);
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_browse_cursor_on_row() {
        let rows = vec![
            make_row("ami-1", "first", 8, 1, AmiStatus::Pending, false),
            make_row("ami-2", "second", 16, 1, AmiStatus::Pending, false),
        ];
        let mut app = browse_app(rows);
        app.cursor = 1;
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }

    #[test]
    fn test_draw_browse_cursor_on_sorted_column() {
        let rows = vec![
            make_row("ami-1", "first", 8, 1, AmiStatus::Pending, false),
            make_row("ami-2", "second", 16, 1, AmiStatus::Pending, false),
        ];
        let mut app = browse_app(rows);
        app.cursor = 0;
        app.sort_field = SortField::Age;
        app.sort_order = SortOrder::Asc;
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut app, f.area())).unwrap();
    }
}
