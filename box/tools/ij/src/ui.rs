//! Interactive instance selection UI with fuzzy filtering.

use std::io::{self, Stdout};

use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use nucleo::{Config as NucleoConfig, Matcher, Utf32Str};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{List, ListItem, ListState, Paragraph},
    Frame, Terminal,
};

use crate::config::Config;
use crate::ec2::{ColumnWidths, Instance};
use crate::error::{Error, Result};

/// Fuzzy picker state.
struct PickerState {
    query: String,
    selected: usize,
    filtered_indices: Vec<(usize, u32)>, // (original_index, score)
}

impl PickerState {
    fn new(total: usize) -> Self {
        Self {
            query: String::new(),
            selected: 0,
            filtered_indices: (0..total).map(|i| (i, 0)).collect(),
        }
    }

    fn move_up(&mut self) {
        if self.filtered_indices.is_empty() {
            return;
        }
        if self.selected > 0 {
            self.selected -= 1;
        } else {
            self.selected = self.filtered_indices.len() - 1;
        }
    }

    fn move_down(&mut self) {
        if self.filtered_indices.is_empty() {
            return;
        }
        if self.selected + 1 < self.filtered_indices.len() {
            self.selected += 1;
        } else {
            self.selected = 0;
        }
    }

    fn move_page_up(&mut self, page_size: usize) {
        self.selected = self.selected.saturating_sub(page_size);
    }

    fn move_page_down(&mut self, page_size: usize) {
        let max = self.filtered_indices.len().saturating_sub(1);
        self.selected = (self.selected + page_size).min(max);
    }

    fn move_to_start(&mut self) {
        self.selected = 0;
    }

    fn move_to_end(&mut self) {
        self.selected = self.filtered_indices.len().saturating_sub(1);
    }

    fn insert_char(&mut self, c: char) {
        self.query.push(c);
    }

    fn delete_char(&mut self) {
        self.query.pop();
    }

    fn clear_query(&mut self) {
        self.query.clear();
    }
}

/// Instance selector with interactive UI.
pub struct Selector<'a> {
    instances: &'a [Instance],
    widths: ColumnWidths,
    config: &'a Config,
    items: Vec<String>,
}

impl<'a> Selector<'a> {
    /// Create a new selector for the given instances.
    pub fn new(instances: &'a [Instance], config: &'a Config) -> Self {
        let widths = ColumnWidths::from_instances(instances);
        let items: Vec<String> = instances.iter().map(|i| i.to_row(&widths)).collect();
        Self {
            widths,
            instances,
            config,
            items,
        }
    }

    /// Show selection UI and return the selected instance.
    pub fn select(&self) -> Result<&'a Instance> {
        let mut terminal = self.setup_terminal()?;
        let result = self.run_picker(&mut terminal);
        self.restore_terminal(&mut terminal)?;
        result
    }

    fn setup_terminal(&self) -> Result<Terminal<CrosstermBackend<Stdout>>> {
        enable_raw_mode().map_err(|e| Error::Other(e.into()))?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen).map_err(|e| Error::Other(e.into()))?;
        let backend = CrosstermBackend::new(stdout);
        Terminal::new(backend).map_err(|e| Error::Other(e.into()))
    }

    fn restore_terminal(&self, terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<()> {
        disable_raw_mode().map_err(|e| Error::Other(e.into()))?;
        execute!(terminal.backend_mut(), LeaveAlternateScreen)
            .map_err(|e| Error::Other(e.into()))?;
        terminal.show_cursor().map_err(|e| Error::Other(e.into()))?;
        Ok(())
    }

    fn run_picker(
        &self,
        terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    ) -> Result<&'a Instance> {
        let mut state = PickerState::new(self.items.len());
        let mut matcher = Matcher::new(NucleoConfig::DEFAULT);

        loop {
            // Update filtered list
            self.update_filter(&mut state, &mut matcher);

            // Draw UI
            terminal
                .draw(|frame| self.draw(frame, &state))
                .map_err(|e| Error::Other(e.into()))?;

            // Handle input
            if let Event::Key(key) = event::read().map_err(|e| Error::Other(e.into()))? {
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                match (key.code, key.modifiers) {
                    (KeyCode::Esc, _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                        return Err(Error::Cancelled);
                    }
                    (KeyCode::Enter, _) => {
                        if let Some(&(idx, _)) = state.filtered_indices.get(state.selected) {
                            return Ok(&self.instances[idx]);
                        }
                        return Err(Error::Cancelled);
                    }
                    (KeyCode::Up, _) | (KeyCode::Char('p'), KeyModifiers::CONTROL) => {
                        state.move_up();
                    }
                    (KeyCode::Down, _) | (KeyCode::Char('n'), KeyModifiers::CONTROL) => {
                        state.move_down();
                    }
                    (KeyCode::PageUp, _) | (KeyCode::Left, _) => {
                        state.move_page_up(10);
                    }
                    (KeyCode::PageDown, _) | (KeyCode::Right, _) => {
                        state.move_page_down(10);
                    }
                    (KeyCode::Home, _) => {
                        state.move_to_start();
                    }
                    (KeyCode::End, _) => {
                        state.move_to_end();
                    }
                    (KeyCode::Backspace, _) | (KeyCode::Char('h'), KeyModifiers::CONTROL) => {
                        state.delete_char();
                        state.selected = 0;
                    }
                    (KeyCode::Char('u'), KeyModifiers::CONTROL) => {
                        state.clear_query();
                        state.selected = 0;
                    }
                    (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
                        state.insert_char(c);
                        state.selected = 0;
                    }
                    _ => {}
                }
            }
        }
    }

    fn update_filter(&self, state: &mut PickerState, matcher: &mut Matcher) {
        if state.query.is_empty() {
            state.filtered_indices = (0..self.items.len()).map(|i| (i, 0)).collect();
        } else {
            let mut results: Vec<(usize, u32)> = Vec::new();
            let pattern = nucleo::pattern::Pattern::parse(
                &state.query,
                nucleo::pattern::CaseMatching::Smart,
                nucleo::pattern::Normalization::Smart,
            );

            for (idx, item) in self.items.iter().enumerate() {
                let mut buf = Vec::new();
                let haystack = Utf32Str::new(item, &mut buf);
                if let Some(score) = pattern.score(haystack, matcher) {
                    results.push((idx, score));
                }
            }

            // Sort by score descending
            results.sort_by(|a, b| b.1.cmp(&a.1));
            state.filtered_indices = results;
        }

        // Clamp selected index
        if state.selected >= state.filtered_indices.len() {
            state.selected = state.filtered_indices.len().saturating_sub(1);
        }
    }

    fn draw(&self, frame: &mut Frame, state: &PickerState) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1), // Search line
                Constraint::Length(1), // Header
                Constraint::Min(1),    // List
            ])
            .split(frame.area());

        // Search line: Profile: xxx | Region: yyy [filtered/total] > query
        let profile = self.config.profile_display();
        let region = self.config.region.as_deref().unwrap_or("all");
        let filtered = state.filtered_indices.len();
        let total = self.items.len();

        let search_line = Line::from(vec![
            Span::styled("Profile: ", Style::default().fg(Color::DarkGray)),
            Span::styled(format!("{} ", profile), Style::default().fg(Color::Cyan)),
            Span::styled("| ", Style::default().fg(Color::DarkGray)),
            Span::styled("Region: ", Style::default().fg(Color::DarkGray)),
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
        let cursor_x = format!(
            "Profile: {} | Region: {} [{}/{}] > ",
            profile, region, filtered, total
        )
        .len() as u16
            + state.query.len() as u16;
        frame.set_cursor_position((cursor_x, chunks[0].y));

        // Header
        let header = Line::from(vec![Span::styled(
            format!("  {}", self.widths.header()),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        )]);
        frame.render_widget(Paragraph::new(header), chunks[1]);

        // List
        let items: Vec<ListItem> = state
            .filtered_indices
            .iter()
            .enumerate()
            .map(|(i, &(idx, _))| {
                let content = &self.items[idx];
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

        let list = List::new(items).highlight_symbol("> ");

        let mut list_state = ListState::default();
        list_state.select(Some(state.selected));

        frame.render_stateful_widget(list, chunks[2], &mut list_state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- PickerState initialization ---

    #[test]
    fn new_initializes_all_indices() {
        let state = PickerState::new(5);
        assert_eq!(state.filtered_indices.len(), 5);
        assert_eq!(state.selected, 0);
        assert!(state.query.is_empty());
        // Indices are 0..5 with score 0
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
        state.move_up(); // should not panic
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
        state.move_down(); // should not panic
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
        state.delete_char(); // should not panic
        assert!(state.query.is_empty());
    }

    #[test]
    fn clear_query_empties() {
        let mut state = PickerState::new(1);
        state.query = "test".to_string();
        state.clear_query();
        assert!(state.query.is_empty());
    }

    // --- Selector and update_filter tests ---

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
                az: "us-east-1a".into(),
                private_ip: "10.0.0.1".into(),
                platform: "Linux".into(),
                age: "3d".into(),
            },
            Instance {
                name: "db-server".into(),
                instance_id: "i-def456".into(),
                instance_type: "m5.large".into(),
                az: "us-west-2b".into(),
                private_ip: "10.0.1.1".into(),
                platform: "Linux".into(),
                age: "3d".into(),
            },
            Instance {
                name: "cache-node".into(),
                instance_id: "i-ghi789".into(),
                instance_type: "r6g.medium".into(),
                az: "ap-northeast-2a".into(),
                private_ip: "10.0.2.1".into(),
                platform: "Linux".into(),
                age: "3d".into(),
            },
        ]
    }

    #[test]
    fn selector_new_creates_items() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        assert_eq!(selector.items.len(), 3);
        assert!(selector.items[0].contains("web-server"));
        assert!(selector.items[1].contains("db-server"));
        assert!(selector.items[2].contains("cache-node"));
    }

    #[test]
    fn selector_new_empty_instances() {
        let instances: Vec<Instance> = vec![];
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        assert!(selector.items.is_empty());
    }

    #[test]
    fn update_filter_empty_query_returns_all() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let mut state = PickerState::new(instances.len());
        let mut matcher = Matcher::new(NucleoConfig::DEFAULT);

        selector.update_filter(&mut state, &mut matcher);
        assert_eq!(state.filtered_indices.len(), 3);
    }

    #[test]
    fn update_filter_with_query_filters() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let mut state = PickerState::new(instances.len());
        let mut matcher = Matcher::new(NucleoConfig::DEFAULT);

        state.query = "web".to_string();
        selector.update_filter(&mut state, &mut matcher);
        assert!(state.filtered_indices.len() >= 1);
        // First result should be the web-server instance (index 0)
        assert_eq!(state.filtered_indices[0].0, 0);
    }

    #[test]
    fn update_filter_no_match() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let mut state = PickerState::new(instances.len());
        let mut matcher = Matcher::new(NucleoConfig::DEFAULT);

        state.query = "zzzznonexistent".to_string();
        selector.update_filter(&mut state, &mut matcher);
        assert!(state.filtered_indices.is_empty());
    }

    #[test]
    fn update_filter_clamps_selected() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let mut state = PickerState::new(instances.len());
        let mut matcher = Matcher::new(NucleoConfig::DEFAULT);

        state.selected = 10; // Way beyond bounds
        state.query = "web".to_string();
        selector.update_filter(&mut state, &mut matcher);
        // selected should be clamped to valid range
        assert!(state.selected < state.filtered_indices.len());
    }

    #[test]
    fn update_filter_clamps_selected_to_zero_on_empty() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let mut state = PickerState::new(instances.len());
        let mut matcher = Matcher::new(NucleoConfig::DEFAULT);

        state.selected = 5;
        state.query = "zzzznonexistent".to_string();
        selector.update_filter(&mut state, &mut matcher);
        assert_eq!(state.selected, 0);
    }

    // --- draw tests (using ratatui TestBackend) ---

    #[test]
    fn draw_renders_without_panic() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let state = PickerState::new(instances.len());

        let backend = ratatui::backend::TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| selector.draw(frame, &state)).unwrap();
    }

    #[test]
    fn draw_with_query_and_selection() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let mut state = PickerState::new(instances.len());
        state.query = "web".to_string();
        state.selected = 0;
        // Filter to match query
        let mut matcher = Matcher::new(NucleoConfig::DEFAULT);
        selector.update_filter(&mut state, &mut matcher);

        let backend = ratatui::backend::TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| selector.draw(frame, &state)).unwrap();
    }

    #[test]
    fn draw_empty_filtered_list() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let mut state = PickerState::new(instances.len());
        state.filtered_indices.clear();

        let backend = ratatui::backend::TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| selector.draw(frame, &state)).unwrap();
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
        let selector = Selector::new(&instances, &config);
        let state = PickerState::new(instances.len());

        let backend = ratatui::backend::TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| selector.draw(frame, &state)).unwrap();
    }

    #[test]
    fn draw_selected_item_gets_highlighted() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let mut state = PickerState::new(instances.len());
        state.selected = 1; // Select second item

        let backend = ratatui::backend::TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| selector.draw(frame, &state)).unwrap();
    }

    #[test]
    fn draw_with_long_query() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let mut state = PickerState::new(instances.len());
        state.query = "web-server us-east-1 t3.micro".to_string();

        let backend = ratatui::backend::TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| selector.draw(frame, &state)).unwrap();
    }

    #[test]
    fn draw_single_instance() {
        let instances = vec![Instance {
            name: "solo".into(),
            instance_id: "i-solo".into(),
            instance_type: "t3.nano".into(),
            az: "us-east-1a".into(),
            private_ip: "10.0.0.1".into(),
            platform: "Linux".into(),
            age: "1h".into(),
        }];
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let state = PickerState::new(instances.len());

        let backend = ratatui::backend::TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| selector.draw(frame, &state)).unwrap();
    }

    #[test]
    fn draw_last_item_selected() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let mut state = PickerState::new(instances.len());
        state.selected = 2; // Last item

        let backend = ratatui::backend::TestBackend::new(120, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| selector.draw(frame, &state)).unwrap();
    }

    #[test]
    fn update_filter_sorts_by_score_descending() {
        let instances = test_instances();
        let config = test_config();
        let selector = Selector::new(&instances, &config);
        let mut state = PickerState::new(instances.len());
        let mut matcher = Matcher::new(NucleoConfig::DEFAULT);

        state.query = "server".to_string();
        selector.update_filter(&mut state, &mut matcher);
        // Both web-server and db-server should match
        assert!(state.filtered_indices.len() >= 2);
        // Results should be sorted by score (descending)
        for w in state.filtered_indices.windows(2) {
            assert!(w[0].1 >= w[1].1);
        }
    }
}
