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
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    fn move_down(&mut self) {
        if self.selected + 1 < self.filtered_indices.len() {
            self.selected += 1;
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
        execute!(terminal.backend_mut(), LeaveAlternateScreen).map_err(|e| Error::Other(e.into()))?;
        terminal.show_cursor().map_err(|e| Error::Other(e.into()))?;
        Ok(())
    }

    fn run_picker(&self, terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<&'a Instance> {
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
                    Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
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
