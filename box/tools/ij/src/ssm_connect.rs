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

/// Overlay state shown on top of the picker in the Ready phase.
pub(crate) enum Overlay {
    /// Confirmation modal before stopping an instance.
    ConfirmStop { index: usize },
    /// Confirmation modal before starting an instance.
    ConfirmStart { index: usize },
    /// Stop/start request submitted; waiting for API result.
    InProgress { message: String },
}

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
        overlay: Option<Overlay>,
        status: Option<String>,
    },
    Error(String),
}

/// Action returned from EC2 tab key handling.
pub(crate) enum Ec2Action {
    None,
    Select(Instance),
    Stop(Instance),
    Start(Instance),
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
            overlay: None,
            status: None,
        };
    }

    pub(crate) fn set_error(&mut self, msg: String) {
        *self = Self::Error(msg);
    }

    /// Apply a new state to an instance by id and refresh the rendered row.
    pub(crate) fn update_instance_state(&mut self, instance_id: &str, new_state: &str) {
        if let Self::Ready {
            instances,
            items,
            widths,
            ..
        } = self
        {
            if let Some(i) = instances.iter_mut().find(|i| i.instance_id == instance_id) {
                i.state = new_state.to_string();
            }
            *widths = ColumnWidths::from_instances(instances);
            *items = instances.iter().map(|i| i.to_row(widths)).collect();
        }
    }

    /// Set a transient status line and clear any overlay.
    pub(crate) fn set_status(&mut self, msg: String) {
        if let Self::Ready {
            status, overlay, ..
        } = self
        {
            *status = Some(msg);
            *overlay = None;
        }
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
                overlay,
                status,
                ..
            } => {
                // While an action is in-flight, ignore input except Ctrl+C.
                if matches!(overlay, Some(Overlay::InProgress { .. })) {
                    if key.modifiers.contains(KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('c')
                    {
                        return Ec2Action::Quit;
                    }
                    return Ec2Action::None;
                }

                // Handle confirmation modal keys.
                if let Some(ov) = overlay {
                    match (key.code, key.modifiers) {
                        (KeyCode::Char('y'), _) | (KeyCode::Char('Y'), _) | (KeyCode::Enter, _) => {
                            let (action, msg) = match ov {
                                Overlay::ConfirmStop { index } => {
                                    let inst = instances[*index].clone();
                                    let m = format!("Stopping {} ...", inst.name);
                                    (Ec2Action::Stop(inst), m)
                                }
                                Overlay::ConfirmStart { index } => {
                                    let inst = instances[*index].clone();
                                    let m = format!("Starting {} ...", inst.name);
                                    (Ec2Action::Start(inst), m)
                                }
                                Overlay::InProgress { .. } => unreachable!(),
                            };
                            *overlay = Some(Overlay::InProgress { message: msg });
                            *status = None;
                            return action;
                        }
                        (KeyCode::Esc, _)
                        | (KeyCode::Char('n'), _)
                        | (KeyCode::Char('N'), _)
                        | (KeyCode::Char('q'), _) => {
                            *overlay = None;
                            return Ec2Action::None;
                        }
                        _ => return Ec2Action::None,
                    }
                }

                match (key.code, key.modifiers) {
                    (KeyCode::Esc, _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                        Ec2Action::Quit
                    }
                    (KeyCode::Enter, _) => {
                        if let Some(&(idx, _)) = picker.filtered_indices.get(picker.selected) {
                            Ec2Action::Select(instances[idx].clone())
                        } else {
                            Ec2Action::None
                        }
                    }
                    // Ctrl+S: stop selected instance (with confirmation)
                    (KeyCode::Char('s'), KeyModifiers::CONTROL) => {
                        if let Some(&(idx, _)) = picker.filtered_indices.get(picker.selected) {
                            *status = None;
                            *overlay = Some(Overlay::ConfirmStop { index: idx });
                        }
                        Ec2Action::None
                    }
                    // Ctrl+B: boot/start selected instance (with confirmation)
                    (KeyCode::Char('b'), KeyModifiers::CONTROL) => {
                        if let Some(&(idx, _)) = picker.filtered_indices.get(picker.selected) {
                            *status = None;
                            *overlay = Some(Overlay::ConfirmStart { index: idx });
                        }
                        Ec2Action::None
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
                }
            }
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
                instances,
                items,
                widths,
                picker,
                overlay,
                status,
                ..
            } => {
                picker::draw_picker(
                    frame,
                    area,
                    items,
                    widths,
                    config,
                    picker,
                    instances,
                    overlay.as_ref(),
                    status.as_deref(),
                );
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
