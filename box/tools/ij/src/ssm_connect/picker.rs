//! Fuzzy picker state and rendering for EC2 instance selection.

use nucleo::{Config as NucleoConfig, Matcher, Utf32Str};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph},
    Frame,
};

use crate::config::Config;
use crate::ec2::{ColumnWidths, Instance};

use super::Overlay;

/// Fuzzy picker state.
pub(crate) struct PickerState {
    pub query: String,
    pub selected: usize,
    pub filtered_indices: Vec<(usize, u32)>, // (original_index, score)
}

impl PickerState {
    pub(crate) fn new(total: usize) -> Self {
        Self {
            query: String::new(),
            selected: 0,
            filtered_indices: (0..total).map(|i| (i, 0)).collect(),
        }
    }

    pub(crate) fn move_up(&mut self) {
        if self.filtered_indices.is_empty() {
            return;
        }
        if self.selected > 0 {
            self.selected -= 1;
        } else {
            self.selected = self.filtered_indices.len() - 1;
        }
    }

    pub(crate) fn move_down(&mut self) {
        if self.filtered_indices.is_empty() {
            return;
        }
        if self.selected + 1 < self.filtered_indices.len() {
            self.selected += 1;
        } else {
            self.selected = 0;
        }
    }

    pub(crate) fn move_page_up(&mut self, page_size: usize) {
        self.selected = self.selected.saturating_sub(page_size);
    }

    pub(crate) fn move_page_down(&mut self, page_size: usize) {
        let max = self.filtered_indices.len().saturating_sub(1);
        self.selected = (self.selected + page_size).min(max);
    }

    pub(crate) fn move_to_start(&mut self) {
        self.selected = 0;
    }

    pub(crate) fn move_to_end(&mut self) {
        self.selected = self.filtered_indices.len().saturating_sub(1);
    }

    pub(crate) fn insert_char(&mut self, c: char) {
        self.query.push(c);
    }

    pub(crate) fn delete_char(&mut self) {
        self.query.pop();
    }

    pub(crate) fn clear_query(&mut self) {
        self.query.clear();
    }
}

/// Update filtered indices based on current query.
pub(crate) fn update_filter(items: &[String], state: &mut PickerState, matcher: &mut Matcher) {
    if state.query.is_empty() {
        state.filtered_indices = (0..items.len()).map(|i| (i, 0)).collect();
    } else {
        let mut results: Vec<(usize, u32)> = Vec::new();
        let pattern = nucleo::pattern::Pattern::parse(
            &state.query,
            nucleo::pattern::CaseMatching::Smart,
            nucleo::pattern::Normalization::Smart,
        );

        for (idx, item) in items.iter().enumerate() {
            let mut buf = Vec::new();
            let haystack = Utf32Str::new(item, &mut buf);
            if let Some(score) = pattern.score(haystack, matcher) {
                results.push((idx, score));
            }
        }

        results.sort_by_key(|b| std::cmp::Reverse(b.1));
        state.filtered_indices = results;
    }

    if state.selected >= state.filtered_indices.len() {
        state.selected = state.filtered_indices.len().saturating_sub(1);
    }
}

/// Draw the instance picker into the given area.
#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_picker(
    frame: &mut Frame,
    area: Rect,
    items: &[String],
    widths: &ColumnWidths,
    config: &Config,
    state: &PickerState,
    instances: &[Instance],
    overlay: Option<&Overlay>,
    status: Option<&str>,
) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // Search line
            Constraint::Length(1), // Header
            Constraint::Min(1),    // List
            Constraint::Length(1), // Hint / status
        ])
        .split(area);

    // Search line
    let profile = config.profile_display();
    let region = config.region.as_deref().unwrap_or("all");
    let filtered = state.filtered_indices.len();
    let total = items.len();

    let search_line = Line::from(vec![
        Span::styled("Profile: ", Style::default().fg(Color::White)),
        Span::styled(format!("{} ", profile), Style::default().fg(Color::Cyan)),
        Span::styled("| ", Style::default().fg(Color::DarkGray)),
        Span::styled("Region: ", Style::default().fg(Color::White)),
        Span::styled(format!("{} ", region), Style::default().fg(Color::Cyan)),
        Span::styled(
            format!("[{}/{}] ", filtered, total),
            Style::default().fg(Color::Yellow),
        ),
        Span::styled("> ", Style::default().fg(Color::Green)),
        Span::raw(&state.query),
    ]);
    frame.render_widget(Paragraph::new(search_line), chunks[0]);

    // Set cursor position at end of query
    let cursor_x = chunks[0].x
        + format!(
            "Profile: {} | Region: {} [{}/{}] > ",
            profile, region, filtered, total
        )
        .len() as u16
        + state.query.len() as u16;
    frame.set_cursor_position((cursor_x, chunks[0].y));

    // Header
    let header = Line::from(vec![Span::styled(
        format!("  {}", widths.header()),
        Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    )]);
    frame.render_widget(Paragraph::new(header), chunks[1]);

    // List
    let list_items: Vec<ListItem> = state
        .filtered_indices
        .iter()
        .enumerate()
        .map(|(i, &(idx, _))| {
            let content = &items[idx];
            let style = if i == state.selected {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            ListItem::new(Line::from(Span::styled(content.clone(), style)))
        })
        .collect();

    let list = List::new(list_items).highlight_symbol("> ");

    let mut list_state = ListState::default();
    list_state.select(Some(state.selected));

    frame.render_stateful_widget(list, chunks[2], &mut list_state);

    // Hint / status line
    let hint_line = if let Some(msg) = status {
        Line::from(Span::styled(
            format!(" {msg}"),
            Style::default().fg(Color::Yellow),
        ))
    } else {
        Line::from(vec![
            Span::styled(" ↑↓ ", Style::default().fg(Color::DarkGray)),
            Span::styled("Move  ", Style::default().fg(Color::White)),
            Span::styled("Enter ", Style::default().fg(Color::DarkGray)),
            Span::styled("Connect  ", Style::default().fg(Color::White)),
            Span::styled("Ctrl+S ", Style::default().fg(Color::DarkGray)),
            Span::styled("Stop  ", Style::default().fg(Color::White)),
            Span::styled("Ctrl+B ", Style::default().fg(Color::DarkGray)),
            Span::styled("Start  ", Style::default().fg(Color::White)),
            Span::styled("Esc ", Style::default().fg(Color::DarkGray)),
            Span::styled("Quit", Style::default().fg(Color::White)),
        ])
    };
    frame.render_widget(Paragraph::new(hint_line), chunks[3]);

    // Overlay (confirmation modal or in-progress message)
    if let Some(ov) = overlay {
        draw_overlay(frame, area, ov, instances);
    }
}

/// Render a centered modal for overlay state.
fn draw_overlay(frame: &mut Frame, area: Rect, overlay: &Overlay, instances: &[Instance]) {
    let (title, body, accent) = match overlay {
        Overlay::ConfirmStop { index } => {
            let inst = &instances[*index];
            (
                " Stop instance ",
                vec![
                    Line::from(vec![
                        Span::styled("Name: ", Style::default().fg(Color::DarkGray)),
                        Span::styled(&inst.name, Style::default().fg(Color::Cyan)),
                    ]),
                    Line::from(vec![
                        Span::styled("ID:   ", Style::default().fg(Color::DarkGray)),
                        Span::styled(&inst.instance_id, Style::default().fg(Color::White)),
                    ]),
                    Line::from(vec![
                        Span::styled("AZ:   ", Style::default().fg(Color::DarkGray)),
                        Span::styled(&inst.az, Style::default().fg(Color::White)),
                    ]),
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("Stop this instance? ", Style::default().fg(Color::White)),
                        Span::styled(
                            "[y/N]",
                            Style::default()
                                .fg(Color::Yellow)
                                .add_modifier(Modifier::BOLD),
                        ),
                    ]),
                ],
                Color::Red,
            )
        }
        Overlay::ConfirmStart { index } => {
            let inst = &instances[*index];
            (
                " Start instance ",
                vec![
                    Line::from(vec![
                        Span::styled("Name: ", Style::default().fg(Color::DarkGray)),
                        Span::styled(&inst.name, Style::default().fg(Color::Cyan)),
                    ]),
                    Line::from(vec![
                        Span::styled("ID:   ", Style::default().fg(Color::DarkGray)),
                        Span::styled(&inst.instance_id, Style::default().fg(Color::White)),
                    ]),
                    Line::from(vec![
                        Span::styled("AZ:   ", Style::default().fg(Color::DarkGray)),
                        Span::styled(&inst.az, Style::default().fg(Color::White)),
                    ]),
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("Start this instance? ", Style::default().fg(Color::White)),
                        Span::styled(
                            "[y/N]",
                            Style::default()
                                .fg(Color::Yellow)
                                .add_modifier(Modifier::BOLD),
                        ),
                    ]),
                ],
                Color::Green,
            )
        }
        Overlay::InProgress { message } => (
            " In progress ",
            vec![
                Line::from(""),
                Line::from(Span::styled(
                    message.clone(),
                    Style::default().fg(Color::Yellow),
                )),
            ],
            Color::Yellow,
        ),
    };

    let width: u16 = 56;
    let height: u16 = body.len() as u16 + 2; // border
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = area.y + area.height.saturating_sub(height) / 2;
    let modal_area = Rect::new(
        x,
        y,
        width.min(area.width),
        height.min(area.height.saturating_sub(1)),
    );

    frame.render_widget(Clear, modal_area);

    let block = Block::default()
        .title(Span::styled(
            title,
            Style::default().fg(accent).add_modifier(Modifier::BOLD),
        ))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(accent))
        .style(Style::default().bg(Color::Black));

    let inner = block.inner(modal_area);
    frame.render_widget(block, modal_area);

    frame.render_widget(Paragraph::new(body), inner);
}

/// Create a new nucleo matcher with default config.
pub(crate) fn new_matcher() -> Matcher {
    Matcher::new(NucleoConfig::DEFAULT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::ec2::{ColumnWidths, Instance};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    // --- PickerState initialization ---

    #[test]
    fn new_initializes_all_indices() {
        let state = PickerState::new(5);
        assert_eq!(state.filtered_indices.len(), 5);
        assert_eq!(state.selected, 0);
        assert!(state.query.is_empty());
        let indices: Vec<usize> = state.filtered_indices.iter().map(|&(i, _)| i).collect();
        assert_eq!(indices, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn new_zero_items() {
        let state = PickerState::new(0);
        assert!(state.filtered_indices.is_empty());
        assert_eq!(state.selected, 0);
    }

    // --- move_up ---

    #[test]
    fn move_up_wraps_to_end() {
        let mut state = PickerState::new(5);
        state.selected = 0;
        state.move_up();
        assert_eq!(state.selected, 4);
    }

    #[test]
    fn move_up_decrements() {
        let mut state = PickerState::new(5);
        state.selected = 3;
        state.move_up();
        assert_eq!(state.selected, 2);
    }

    #[test]
    fn move_up_empty_no_panic() {
        let mut state = PickerState::new(0);
        state.move_up();
        assert_eq!(state.selected, 0);
    }

    // --- move_down ---

    #[test]
    fn move_down_wraps_to_start() {
        let mut state = PickerState::new(5);
        state.selected = 4;
        state.move_down();
        assert_eq!(state.selected, 0);
    }

    #[test]
    fn move_down_increments() {
        let mut state = PickerState::new(5);
        state.selected = 0;
        state.move_down();
        assert_eq!(state.selected, 1);
    }

    #[test]
    fn move_down_empty_no_panic() {
        let mut state = PickerState::new(0);
        state.move_down();
        assert_eq!(state.selected, 0);
    }

    // --- page navigation ---

    #[test]
    fn move_page_up_saturates() {
        let mut state = PickerState::new(20);
        state.selected = 3;
        state.move_page_up(10);
        assert_eq!(state.selected, 0);
    }

    #[test]
    fn move_page_down_clamps() {
        let mut state = PickerState::new(5);
        state.selected = 0;
        state.move_page_down(100);
        assert_eq!(state.selected, 4);
    }

    // --- move_to_start / move_to_end ---

    #[test]
    fn move_to_start() {
        let mut state = PickerState::new(10);
        state.selected = 5;
        state.move_to_start();
        assert_eq!(state.selected, 0);
    }

    #[test]
    fn move_to_end() {
        let mut state = PickerState::new(10);
        state.selected = 0;
        state.move_to_end();
        assert_eq!(state.selected, 9);
    }

    #[test]
    fn move_to_end_empty() {
        let mut state = PickerState::new(0);
        state.move_to_end();
        assert_eq!(state.selected, 0);
    }

    // --- query manipulation ---

    #[test]
    fn insert_char_appends() {
        let mut state = PickerState::new(1);
        state.insert_char('a');
        state.insert_char('b');
        assert_eq!(state.query, "ab");
    }

    #[test]
    fn delete_char_removes_last() {
        let mut state = PickerState::new(1);
        state.query = "abc".to_string();
        state.delete_char();
        assert_eq!(state.query, "ab");
    }

    #[test]
    fn delete_char_empty_no_panic() {
        let mut state = PickerState::new(1);
        state.delete_char();
        assert!(state.query.is_empty());
    }

    #[test]
    fn clear_query_empties() {
        let mut state = PickerState::new(1);
        state.query = "test".to_string();
        state.clear_query();
        assert!(state.query.is_empty());
    }

    // --- update_filter tests ---

    fn test_config() -> Config {
        Config {
            profile: Some("test".into()),
            aws_config_file: None,
            region: Some("us-east-1".into()),
            scan_regions: vec![],
            tag_filters: vec![],
            running_only: true,
            log_level: "info".into(),
            forward: None,
            shell_commands: Vec::new(),
        }
    }

    fn test_instances() -> Vec<Instance> {
        vec![
            Instance {
                name: "web-server".into(),
                instance_id: "i-abc123".into(),
                instance_type: "t3.micro".into(),
                state: "running".into(),
                az: "us-east-1a".into(),
                private_ip: "10.0.0.1".into(),
                platform: "Linux".into(),
                age: "3d".into(),
            },
            Instance {
                name: "db-server".into(),
                instance_id: "i-def456".into(),
                instance_type: "m5.large".into(),
                state: "running".into(),
                az: "us-west-2b".into(),
                private_ip: "10.0.1.1".into(),
                platform: "Linux".into(),
                age: "3d".into(),
            },
            Instance {
                name: "cache-node".into(),
                instance_id: "i-ghi789".into(),
                instance_type: "r6g.medium".into(),
                state: "stopped".into(),
                az: "ap-northeast-2a".into(),
                private_ip: "10.0.2.1".into(),
                platform: "Linux".into(),
                age: "3d".into(),
            },
        ]
    }

    fn make_items(instances: &[Instance]) -> (Vec<String>, ColumnWidths) {
        let widths = ColumnWidths::from_instances(instances);
        let items: Vec<String> = instances.iter().map(|i| i.to_row(&widths)).collect();
        (items, widths)
    }

    #[test]
    fn update_filter_empty_query_returns_all() {
        let instances = test_instances();
        let (items, _) = make_items(&instances);
        let mut state = PickerState::new(items.len());
        let mut matcher = new_matcher();

        update_filter(&items, &mut state, &mut matcher);
        assert_eq!(state.filtered_indices.len(), 3);
    }

    #[test]
    fn update_filter_with_query_filters() {
        let instances = test_instances();
        let (items, _) = make_items(&instances);
        let mut state = PickerState::new(items.len());
        let mut matcher = new_matcher();

        state.query = "web".to_string();
        update_filter(&items, &mut state, &mut matcher);
        assert!(!state.filtered_indices.is_empty());
        assert_eq!(state.filtered_indices[0].0, 0);
    }

    #[test]
    fn update_filter_no_match() {
        let instances = test_instances();
        let (items, _) = make_items(&instances);
        let mut state = PickerState::new(items.len());
        let mut matcher = new_matcher();

        state.query = "zzzznonexistent".to_string();
        update_filter(&items, &mut state, &mut matcher);
        assert!(state.filtered_indices.is_empty());
    }

    #[test]
    fn update_filter_clamps_selected() {
        let instances = test_instances();
        let (items, _) = make_items(&instances);
        let mut state = PickerState::new(items.len());
        let mut matcher = new_matcher();

        state.selected = 10;
        state.query = "web".to_string();
        update_filter(&items, &mut state, &mut matcher);
        assert!(state.selected < state.filtered_indices.len());
    }

    #[test]
    fn update_filter_clamps_selected_to_zero_on_empty() {
        let instances = test_instances();
        let (items, _) = make_items(&instances);
        let mut state = PickerState::new(items.len());
        let mut matcher = new_matcher();

        state.selected = 5;
        state.query = "zzzznonexistent".to_string();
        update_filter(&items, &mut state, &mut matcher);
        assert_eq!(state.selected, 0);
    }

    #[test]
    fn update_filter_sorts_by_score_descending() {
        let instances = test_instances();
        let (items, _) = make_items(&instances);
        let mut state = PickerState::new(items.len());
        let mut matcher = new_matcher();

        state.query = "server".to_string();
        update_filter(&items, &mut state, &mut matcher);
        assert!(state.filtered_indices.len() >= 2);
        for w in state.filtered_indices.windows(2) {
            assert!(w[0].1 >= w[1].1);
        }
    }

    // --- draw tests ---

    #[test]
    fn draw_renders_without_panic() {
        let instances = test_instances();
        let config = test_config();
        let (items, widths) = make_items(&instances);
        let state = PickerState::new(items.len());

        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw_picker(
                    frame,
                    frame.area(),
                    &items,
                    &widths,
                    &config,
                    &state,
                    &instances,
                    None,
                    None,
                )
            })
            .unwrap();
    }

    #[test]
    fn draw_with_query_and_selection() {
        let instances = test_instances();
        let config = test_config();
        let (items, widths) = make_items(&instances);
        let mut state = PickerState::new(items.len());
        state.query = "web".to_string();
        state.selected = 0;
        let mut matcher = new_matcher();
        update_filter(&items, &mut state, &mut matcher);

        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw_picker(
                    frame,
                    frame.area(),
                    &items,
                    &widths,
                    &config,
                    &state,
                    &instances,
                    None,
                    None,
                )
            })
            .unwrap();
    }

    #[test]
    fn draw_empty_filtered_list() {
        let instances = test_instances();
        let config = test_config();
        let (items, widths) = make_items(&instances);
        let mut state = PickerState::new(items.len());
        state.filtered_indices.clear();

        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw_picker(
                    frame,
                    frame.area(),
                    &items,
                    &widths,
                    &config,
                    &state,
                    &instances,
                    None,
                    None,
                )
            })
            .unwrap();
    }

    #[test]
    fn draw_with_no_region_in_config() {
        let instances = test_instances();
        let config = Config {
            profile: None,
            aws_config_file: None,
            region: None,
            scan_regions: vec![],
            tag_filters: vec![],
            running_only: true,
            log_level: "info".into(),
            forward: None,
            shell_commands: Vec::new(),
        };
        let (items, widths) = make_items(&instances);
        let state = PickerState::new(items.len());

        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw_picker(
                    frame,
                    frame.area(),
                    &items,
                    &widths,
                    &config,
                    &state,
                    &instances,
                    None,
                    None,
                )
            })
            .unwrap();
    }

    #[test]
    fn draw_selected_item_gets_highlighted() {
        let instances = test_instances();
        let config = test_config();
        let (items, widths) = make_items(&instances);
        let mut state = PickerState::new(items.len());
        state.selected = 1;

        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw_picker(
                    frame,
                    frame.area(),
                    &items,
                    &widths,
                    &config,
                    &state,
                    &instances,
                    None,
                    None,
                )
            })
            .unwrap();
    }

    #[test]
    fn draw_with_long_query() {
        let instances = test_instances();
        let config = test_config();
        let (items, widths) = make_items(&instances);
        let mut state = PickerState::new(items.len());
        state.query = "web-server us-east-1 t3.micro".to_string();

        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw_picker(
                    frame,
                    frame.area(),
                    &items,
                    &widths,
                    &config,
                    &state,
                    &instances,
                    None,
                    None,
                )
            })
            .unwrap();
    }

    #[test]
    fn draw_single_instance() {
        let instances = vec![Instance {
            name: "solo".into(),
            instance_id: "i-solo".into(),
            instance_type: "t3.nano".into(),
            state: "running".into(),
            az: "us-east-1a".into(),
            private_ip: "10.0.0.1".into(),
            platform: "Linux".into(),
            age: "1h".into(),
        }];
        let config = test_config();
        let (items, widths) = make_items(&instances);
        let state = PickerState::new(items.len());

        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw_picker(
                    frame,
                    frame.area(),
                    &items,
                    &widths,
                    &config,
                    &state,
                    &instances,
                    None,
                    None,
                )
            })
            .unwrap();
    }

    #[test]
    fn draw_last_item_selected() {
        let instances = test_instances();
        let config = test_config();
        let (items, widths) = make_items(&instances);
        let mut state = PickerState::new(items.len());
        state.selected = 2;

        let backend = TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw_picker(
                    frame,
                    frame.area(),
                    &items,
                    &widths,
                    &config,
                    &state,
                    &instances,
                    None,
                    None,
                )
            })
            .unwrap();
    }
}
