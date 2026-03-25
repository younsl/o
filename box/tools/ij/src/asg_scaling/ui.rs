//! TUI rendering for the ASG Scaling tab.

use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, Paragraph},
};

use super::app::{App, AppMode, InputField, RowStatus};

pub fn draw(frame: &mut Frame, app: &mut App, area: Rect, profile: &str) {
    match &app.mode {
        AppMode::Scanning => draw_scanning(frame, app, area, profile),
        AppMode::Error(msg) => draw_error(frame, &msg.clone(), area),
        AppMode::Done => draw_done(frame, app, area),
        _ => {
            draw_browse(frame, app, area, profile);
            // Draw overlays on top
            match app.mode {
                AppMode::ScaleMenu => draw_scale_menu(frame, app, area),
                AppMode::InputAbsolute => draw_input_absolute(frame, app, area),
                AppMode::Preview => draw_preview(frame, app, area),
                AppMode::Applying => draw_applying(frame, app, area),
                _ => {}
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

fn draw_scanning(frame: &mut Frame, app: &App, area: Rect, profile: &str) {
    let chunks = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(0),
    ])
    .split(area);

    let spinner = app.spinner_char();
    let elapsed = app.scan_elapsed_secs();
    let regions = &app.scan_regions_display;

    let msg = Line::from(vec![
        Span::styled(format!(" {spinner} "), Style::default().fg(Color::Yellow)),
        Span::styled(
            format!("Scanning ASGs in {regions} ({elapsed}s) (profile: {profile})"),
            Style::default().fg(Color::Yellow),
        ),
    ]);
    frame.render_widget(Paragraph::new(msg), chunks[0]);

    let hint = Line::from(Span::styled(
        "   q/Esc to quit",
        Style::default().fg(Color::DarkGray),
    ));
    frame.render_widget(Paragraph::new(hint), chunks[1]);
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

fn draw_error(frame: &mut Frame, msg: &str, area: Rect) {
    let chunks = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(0),
    ])
    .split(area);

    let err = Line::from(Span::styled(
        format!(" Error: {msg}"),
        Style::default().fg(Color::Red),
    ));
    frame.render_widget(Paragraph::new(err), chunks[0]);

    let hint = Line::from(Span::styled(
        "   q/Esc to quit",
        Style::default().fg(Color::DarkGray),
    ));
    frame.render_widget(Paragraph::new(hint), chunks[1]);
}

// ---------------------------------------------------------------------------
// Done (after apply)
// ---------------------------------------------------------------------------

fn draw_done(frame: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);

    let title = Line::from(Span::styled(
        " ASG Scaling Complete",
        Style::default()
            .fg(Color::Green)
            .add_modifier(Modifier::BOLD),
    ));
    frame.render_widget(Paragraph::new(title), chunks[0]);

    let lines: Vec<Line> = app
        .apply_logs
        .iter()
        .map(|log| Line::from(Span::raw(format!("  {log}"))))
        .collect();
    frame.render_widget(Paragraph::new(lines), chunks[1]);

    let hint = Line::from(Span::styled(
        "   Press Enter/q/Esc to exit",
        Style::default().fg(Color::DarkGray),
    ));
    frame.render_widget(Paragraph::new(hint), chunks[2]);
}

// ---------------------------------------------------------------------------
// Browse (main table view)
// ---------------------------------------------------------------------------

fn draw_browse(frame: &mut Frame, app: &App, area: Rect, profile: &str) {
    let chunks = Layout::vertical([
        Constraint::Length(1), // Search line
        Constraint::Length(1), // Header
        Constraint::Min(1),    // List
        Constraint::Length(1), // Help bar
    ])
    .split(area);

    // Search line
    let filtered = app.filtered_indices.len();
    let total = app.rows.len();
    let selected = app.selected_count();

    let search_line = Line::from(vec![
        Span::styled("Profile: ", Style::default().fg(Color::White)),
        Span::styled(format!("{profile} "), Style::default().fg(Color::Cyan)),
        Span::styled("| ", Style::default().fg(Color::DarkGray)),
        Span::styled(
            format!("[{filtered}/{total}] "),
            Style::default().fg(Color::Yellow),
        ),
        if selected > 0 {
            Span::styled(
                format!("({selected} selected) "),
                Style::default().fg(Color::Green),
            )
        } else {
            Span::raw("")
        },
        Span::styled("> ", Style::default().fg(Color::Green)),
        Span::raw(&app.query),
    ]);
    frame.render_widget(Paragraph::new(search_line), chunks[0]);

    // Cursor position
    let prefix_len = format!(
        "Profile: {profile} | [{filtered}/{total}] {}> ",
        if selected > 0 {
            format!("({selected} selected) ")
        } else {
            String::new()
        }
    )
    .len();
    let cursor_x = chunks[0].x + prefix_len as u16 + app.query.len() as u16;
    frame.set_cursor_position((cursor_x, chunks[0].y));

    // Header — prefix width must match row prefix: cursor(2) + checkbox(4) = 6 chars
    let header_style = Style::default()
        .fg(Color::White)
        .add_modifier(Modifier::BOLD);
    let sort_style = Style::default()
        .fg(Color::Cyan)
        .bg(Color::DarkGray)
        .add_modifier(Modifier::BOLD);

    let mut header_spans = vec![Span::styled("      ", header_style)];
    let cols = app.widths.header_columns(app.sort_field, app.sort_order);
    for (i, (text, is_sorted)) in cols.iter().enumerate() {
        let style = if *is_sorted { sort_style } else { header_style };
        header_spans.push(Span::styled(text.clone(), style));
        if i + 1 < cols.len() {
            header_spans.push(Span::styled("  ", header_style));
        }
    }
    frame.render_widget(Paragraph::new(Line::from(header_spans)), chunks[1]);

    // List — each row: cursor(2) + checkbox(4) + content
    let list_items: Vec<ListItem> = app
        .filtered_indices
        .iter()
        .enumerate()
        .map(|(i, &(idx, _))| {
            let row = &app.rows[idx];
            let cursor_mark = if i == app.cursor { "> " } else { "  " };
            let checkbox = if row.selected { "[x] " } else { "[ ] " };
            let content = &app.items[idx];

            let status_marker = match &row.status {
                RowStatus::Applied => " [OK]",
                RowStatus::Failed(_) => " [FAIL]",
                _ => "",
            };

            let style = if i == app.cursor {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else if row.selected {
                Style::default().fg(Color::Green)
            } else {
                match &row.status {
                    RowStatus::Applied => Style::default().fg(Color::DarkGray),
                    RowStatus::Failed(_) => Style::default().fg(Color::Red),
                    _ => Style::default(),
                }
            };

            ListItem::new(Line::from(Span::styled(
                format!("{cursor_mark}{checkbox}{content}{status_marker}"),
                style,
            )))
        })
        .collect();

    let list = List::new(list_items);
    frame.render_widget(list, chunks[2]);

    // Help bar
    let help = Line::from(vec![
        Span::styled(" Space", Style::default().fg(Color::Yellow)),
        Span::styled(": toggle | ", Style::default().fg(Color::DarkGray)),
        Span::styled("a", Style::default().fg(Color::Yellow)),
        Span::styled(": select all | ", Style::default().fg(Color::DarkGray)),
        Span::styled("o", Style::default().fg(Color::Yellow)),
        Span::styled(": sort | ", Style::default().fg(Color::DarkGray)),
        Span::styled("s", Style::default().fg(Color::Yellow)),
        Span::styled(": scale | ", Style::default().fg(Color::DarkGray)),
        Span::styled("q", Style::default().fg(Color::Yellow)),
        Span::styled(": quit", Style::default().fg(Color::DarkGray)),
    ]);
    frame.render_widget(Paragraph::new(help), chunks[3]);
}

// ---------------------------------------------------------------------------
// Scale menu overlay
// ---------------------------------------------------------------------------

fn draw_scale_menu(frame: &mut Frame, app: &App, area: Rect) {
    let selected = app.selected_count();
    let width = 36u16;
    let height = 9u16;
    let popup = centered_rect(width, height, area);

    frame.render_widget(Clear, popup);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .title(format!(" Scale {selected} ASG(s) "))
        .title_style(
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )
        .style(Style::default().bg(Color::Black));

    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    let lines = vec![
        Line::raw(""),
        Line::from(vec![
            Span::styled("  [2] ", Style::default().fg(Color::Yellow)),
            Span::raw("x2 (double)"),
        ]),
        Line::from(vec![
            Span::styled("  [3] ", Style::default().fg(Color::Yellow)),
            Span::raw("x3 (triple)"),
        ]),
        Line::from(vec![
            Span::styled("  [v] ", Style::default().fg(Color::Yellow)),
            Span::raw("Set absolute values"),
        ]),
        Line::raw(""),
        Line::from(Span::styled(
            "  Esc: cancel",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    frame.render_widget(Paragraph::new(lines), inner);
}

// ---------------------------------------------------------------------------
// Input absolute overlay
// ---------------------------------------------------------------------------

fn draw_input_absolute(frame: &mut Frame, app: &App, area: Rect) {
    let width = 36u16;
    let height = 10u16;
    let popup = centered_rect(width, height, area);

    frame.render_widget(Clear, popup);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .title(" Set Absolute Values ")
        .title_style(
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )
        .style(Style::default().bg(Color::Black));

    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    let fields = [
        (InputField::Min, &app.input_min),
        (InputField::Max, &app.input_max),
        (InputField::Desired, &app.input_desired),
    ];

    let mut lines = vec![Line::raw("")];
    for (field, value) in &fields {
        let is_active = *field == app.input_field;
        let label_style = if is_active {
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White)
        };
        let cursor = if is_active { "_" } else { "" };
        lines.push(Line::from(vec![
            Span::styled(format!("  {:>7}:  ", field.label()), label_style),
            Span::styled(format!("{value}{cursor}"), Style::default().fg(Color::Cyan)),
        ]));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "  Tab: next | Enter: apply | Esc: back",
        Style::default().fg(Color::DarkGray),
    )));

    frame.render_widget(Paragraph::new(lines), inner);
}

// ---------------------------------------------------------------------------
// Preview overlay (before/after + "yes" confirmation)
// ---------------------------------------------------------------------------

fn draw_preview(frame: &mut Frame, app: &App, area: Rect) {
    let selected: Vec<_> = app
        .rows
        .iter()
        .filter(|r| r.selected && r.has_changes())
        .collect();

    // Compute column widths from actual content
    let name_w = selected
        .iter()
        .map(|r| r.info.name.len())
        .max()
        .unwrap_or(3)
        .max(3);

    // Pre-format change strings to measure widths
    let change_rows: Vec<(String, String, String)> = selected
        .iter()
        .map(|r| {
            (
                format_change(r.info.min_size, r.new_min.unwrap_or(r.info.min_size)),
                format_change(r.info.max_size, r.new_max.unwrap_or(r.info.max_size)),
                format_change(
                    r.info.desired_capacity,
                    r.new_desired.unwrap_or(r.info.desired_capacity),
                ),
            )
        })
        .collect();

    let min_w = change_rows
        .iter()
        .map(|(s, _, _)| s.len())
        .max()
        .unwrap_or(3)
        .max(3);
    let max_w = change_rows
        .iter()
        .map(|(_, s, _)| s.len())
        .max()
        .unwrap_or(3)
        .max(3);
    let des_w = change_rows
        .iter()
        .map(|(_, _, s)| s.len())
        .max()
        .unwrap_or(7)
        .max(7);

    // content width: "  " + name + "  " + min + "  " + max + "  " + desired + padding
    let content_w = 2 + name_w + 2 + min_w + 2 + max_w + 2 + des_w + 2;
    let confirm_line_w = "  Type \"yes\" to apply: yes_".len();
    let min_width = content_w.max(confirm_line_w) + 4; // +4 for border

    let row_count = selected.len();
    let height = (row_count as u16 + 8).min(area.height.saturating_sub(4));
    let width = (min_width as u16).max(40).min(area.width.saturating_sub(4));
    let popup = centered_rect(width, height, area);

    frame.render_widget(Clear, popup);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .title(format!(" Preview Changes ({}) ", app.preview_label))
        .title_style(
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )
        .style(Style::default().bg(Color::Black));

    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    let mut lines = Vec::new();

    // Header
    lines.push(Line::from(vec![Span::styled(
        format!(
            "  {:<name_w$}  {:<min_w$}  {:<max_w$}  {:<des_w$}",
            "ASG", "MIN", "MAX", "DESIRED",
        ),
        Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    )]));

    // Rows
    for (row, (min_str, max_str, des_str)) in selected.iter().zip(change_rows.iter()) {
        lines.push(Line::from(Span::raw(format!(
            "  {:<name_w$}  {:<min_w$}  {:<max_w$}  {:<des_w$}",
            row.info.name, min_str, max_str, des_str,
        ))));
    }

    lines.push(Line::raw(""));

    // Confirm input
    if app.confirm_error {
        lines.push(Line::from(Span::styled(
            "  Type \"yes\" to confirm. Try again.",
            Style::default().fg(Color::Red),
        )));
    }
    lines.push(Line::from(vec![
        Span::styled(
            "  Type \"yes\" to apply: ",
            Style::default().fg(Color::Yellow),
        ),
        Span::styled(
            format!("{}_", app.confirm_input),
            Style::default().fg(Color::Cyan),
        ),
    ]));
    lines.push(Line::from(Span::styled(
        "  Esc: cancel",
        Style::default().fg(Color::DarkGray),
    )));

    frame.render_widget(Paragraph::new(lines), inner);
}

fn format_change(old: i32, new: i32) -> String {
    if old == new {
        format!("{old}")
    } else {
        format!("{old} → {new}")
    }
}

// ---------------------------------------------------------------------------
// Applying overlay
// ---------------------------------------------------------------------------

fn draw_applying(frame: &mut Frame, app: &App, area: Rect) {
    let log_count = app.apply_logs.len();
    let height = (log_count as u16 + 5).min(area.height.saturating_sub(4));
    let width = 60u16.min(area.width.saturating_sub(4));
    let popup = centered_rect(width, height, area);

    frame.render_widget(Clear, popup);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .title(" Applying Changes ")
        .title_style(
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )
        .style(Style::default().bg(Color::Black));

    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    let spinner = app.spinner_char();
    let mut lines: Vec<Line> = app
        .apply_logs
        .iter()
        .map(|log| Line::from(Span::raw(format!("  {log}"))))
        .collect();

    lines.push(Line::from(Span::styled(
        format!("  {spinner} Applying..."),
        Style::default().fg(Color::Yellow),
    )));

    frame.render_widget(Paragraph::new(lines), inner);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn centered_rect(width: u16, height: u16, area: Rect) -> Rect {
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = area.y + area.height.saturating_sub(height) / 2;
    Rect::new(x, y, width.min(area.width), height.min(area.height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asg_scaling::app::{AsgRow, ColWidths};
    use crate::asg_scaling::aws::AsgInfo;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn make_app() -> App {
        let mut app = App::new_scanning("us-east-1".into());
        app.load_results(vec![
            AsgInfo {
                name: "web-asg".into(),
                min_size: 2,
                max_size: 10,
                desired_capacity: 4,
                instances_count: 4,
                region: "us-east-1".into(),
            },
            AsgInfo {
                name: "api-asg".into(),
                min_size: 1,
                max_size: 5,
                desired_capacity: 2,
                instances_count: 2,
                region: "us-east-1".into(),
            },
        ]);
        app
    }

    #[test]
    fn draw_browse_no_panic() {
        let mut app = make_app();
        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| draw(f, &mut app, f.area(), "test"))
            .unwrap();
    }

    #[test]
    fn draw_scanning_no_panic() {
        let mut app = App::new_scanning("us-east-1".into());
        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| draw(f, &mut app, f.area(), "test"))
            .unwrap();
    }

    #[test]
    fn draw_scale_menu_no_panic() {
        let mut app = make_app();
        app.rows[0].selected = true;
        app.mode = AppMode::ScaleMenu;
        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| draw(f, &mut app, f.area(), "test"))
            .unwrap();
    }

    #[test]
    fn draw_preview_no_panic() {
        let mut app = make_app();
        app.rows[0].selected = true;
        app.rows[0].apply_multiplier(2);
        app.preview_label = "x2".into();
        app.mode = AppMode::Preview;
        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| draw(f, &mut app, f.area(), "test"))
            .unwrap();
    }

    #[test]
    fn draw_input_absolute_no_panic() {
        let mut app = make_app();
        app.mode = AppMode::InputAbsolute;
        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| draw(f, &mut app, f.area(), "test"))
            .unwrap();
    }

    #[test]
    fn draw_done_no_panic() {
        let mut app = make_app();
        app.mode = AppMode::Done;
        app.apply_logs = vec!["web-asg: OK".into(), "api-asg: OK".into()];
        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| draw(f, &mut app, f.area(), "test"))
            .unwrap();
    }

    #[test]
    fn draw_error_no_panic() {
        let mut app = App::new_scanning("us-east-1".into());
        app.mode = AppMode::Error("test error".into());
        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| draw(f, &mut app, f.area(), "test"))
            .unwrap();
    }

    #[test]
    fn format_change_same() {
        assert_eq!(format_change(5, 5), "5");
    }

    #[test]
    fn format_change_different() {
        assert_eq!(format_change(2, 4), "2 → 4");
    }

    #[test]
    fn centered_rect_fits() {
        let area = Rect::new(0, 0, 100, 50);
        let r = centered_rect(40, 20, area);
        assert_eq!(r.x, 30);
        assert_eq!(r.y, 15);
        assert_eq!(r.width, 40);
        assert_eq!(r.height, 20);
    }
}
