//! SSM Connect tab: EC2 instance scanning + interactive picker.

mod picker;

use std::time::Instant;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use nucleo::Matcher;
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use crate::config::Config;
use crate::ec2::{ColumnWidths, Instance};

pub(crate) use picker::PickerState;

const SPINNER_FRAMES: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/// EC2 Connect tab phase.
pub(crate) enum Ec2Phase {
    Scanning {
        start: Instant,
        spinner_frame: usize,
        regions: String,
    },
    Ready {
        instances: Vec<Instance>,
        items: Vec<String>,
        widths: ColumnWidths,
        picker: PickerState,
        matcher: Matcher,
    },
    Error(String),
}

/// Action returned from EC2 tab key handling.
pub(crate) enum Ec2Action {
    None,
    Select(Instance),
    Quit,
}

impl Ec2Phase {
    pub(crate) fn new_scanning(regions: String) -> Self {
        Self::Scanning {
            start: Instant::now(),
            spinner_frame: 0,
            regions,
        }
    }

    pub(crate) fn tick_spinner(&mut self) {
        if let Self::Scanning { spinner_frame, .. } = self {
            *spinner_frame = spinner_frame.wrapping_add(1);
        }
    }

    pub(crate) fn load_instances(&mut self, instances: Vec<Instance>) {
        let widths = ColumnWidths::from_instances(&instances);
        let items: Vec<String> = instances.iter().map(|i| i.to_row(&widths)).collect();
        let picker_state = PickerState::new(items.len());
        let matcher = picker::new_matcher();
        *self = Self::Ready {
            instances,
            items,
            widths,
            picker: picker_state,
            matcher,
        };
    }

    pub(crate) fn set_error(&mut self, msg: String) {
        *self = Self::Error(msg);
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> Ec2Action {
        if key.kind != KeyEventKind::Press {
            return Ec2Action::None;
        }

        match self {
            Self::Scanning { .. } => match (key.code, key.modifiers) {
                (KeyCode::Esc, _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => Ec2Action::Quit,
                (KeyCode::Char('q'), KeyModifiers::NONE) => Ec2Action::Quit,
                _ => Ec2Action::None,
            },
            Self::Ready {
                instances,
                items,
                picker,
                matcher,
                ..
            } => match (key.code, key.modifiers) {
                (KeyCode::Esc, _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => Ec2Action::Quit,
                (KeyCode::Enter, _) => {
                    if let Some(&(idx, _)) = picker.filtered_indices.get(picker.selected) {
                        Ec2Action::Select(instances[idx].clone())
                    } else {
                        Ec2Action::None
                    }
                }
                (KeyCode::Up, _) | (KeyCode::Char('p'), KeyModifiers::CONTROL) => {
                    picker.move_up();
                    Ec2Action::None
                }
                (KeyCode::Down, _) | (KeyCode::Char('n'), KeyModifiers::CONTROL) => {
                    picker.move_down();
                    Ec2Action::None
                }
                (KeyCode::PageUp, _) | (KeyCode::Left, _) => {
                    picker.move_page_up(10);
                    Ec2Action::None
                }
                (KeyCode::PageDown, _) | (KeyCode::Right, _) => {
                    picker.move_page_down(10);
                    Ec2Action::None
                }
                (KeyCode::Home, _) => {
                    picker.move_to_start();
                    Ec2Action::None
                }
                (KeyCode::End, _) => {
                    picker.move_to_end();
                    Ec2Action::None
                }
                (KeyCode::Backspace, _) | (KeyCode::Char('h'), KeyModifiers::CONTROL) => {
                    picker.delete_char();
                    picker.selected = 0;
                    picker::update_filter(items, picker, matcher);
                    Ec2Action::None
                }
                (KeyCode::Char('u'), KeyModifiers::CONTROL) => {
                    picker.clear_query();
                    picker.selected = 0;
                    picker::update_filter(items, picker, matcher);
                    Ec2Action::None
                }
                (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
                    picker.insert_char(c);
                    picker.selected = 0;
                    picker::update_filter(items, picker, matcher);
                    Ec2Action::None
                }
                _ => Ec2Action::None,
            },
            Self::Error(_) => match (key.code, key.modifiers) {
                (KeyCode::Esc, _)
                | (KeyCode::Char('c'), KeyModifiers::CONTROL)
                | (KeyCode::Char('q'), KeyModifiers::NONE) => Ec2Action::Quit,
                _ => Ec2Action::None,
            },
        }
    }

    pub(crate) fn draw(&self, frame: &mut Frame, area: Rect, config: &Config) {
        match self {
            Self::Scanning {
                start,
                spinner_frame,
                regions,
            } => {
                let elapsed = start.elapsed().as_secs();
                let spinner = SPINNER_FRAMES[spinner_frame % SPINNER_FRAMES.len()];

                let chunks = Layout::vertical([
                    Constraint::Length(1), // scanning message
                    Constraint::Length(1), // hint
                    Constraint::Min(0),    // remaining space
                ])
                .split(area);

                let msg = Line::from(vec![
                    Span::styled(format!(" {spinner} "), Style::default().fg(Color::Yellow)),
                    Span::styled(
                        format!(
                            "Scanning EC2 instances in {regions} ({elapsed}s) (profile: {})",
                            config.profile_display()
                        ),
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
            Self::Ready {
                items,
                widths,
                picker,
                ..
            } => {
                picker::draw_picker(frame, area, items, widths, config, picker);
            }
            Self::Error(msg) => {
                let chunks = Layout::vertical([
                    Constraint::Length(1), // error message
                    Constraint::Length(1), // hint
                    Constraint::Min(0),    // remaining space
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
        }
    }
}
