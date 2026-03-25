//! Tabbed TUI shell: EC2 Connect + AMI Cleanup + ASG Scaling tabs with dropdown menu.

use std::io::stdout;
use std::time::Duration;

use crossterm::ExecutableCommand;
use crossterm::event::{Event, EventStream, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use futures::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::{Frame, Terminal};
use tokio::sync::mpsc;

use crate::ami_cleanup;
use crate::ami_cleanup::app::{App as AmiApp, AppAction, AppMode};
use crate::ami_cleanup::{AmiCleanupArgs, ScanMsg};
use crate::asg_scaling;
use crate::asg_scaling::Msg as AsgMsg;
use crate::asg_scaling::app::{App as AsgApp, AppAction as AsgAction, AppMode as AsgMode};
use crate::config::Config;
use crate::ec2::{Instance, Scanner};
use crate::error::{Error, Result};
use crate::ssm_connect::{Ec2Action, Ec2Phase};

const TAB_LABELS: &[&str] = &["EC2 Connect", "AMI Cleanup", "ASG Scaling"];
const TAB_DESCS: &[&str] = &[
    "Connect to EC2 instances via SSM Session Manager",
    "Scan and delete unused AMIs across regions",
    "View and scale Auto Scaling Groups",
];

#[derive(Clone, Copy, PartialEq)]
enum ActiveTab {
    Ec2Connect,
    AmiCleanup,
    AsgScaling,
}

impl ActiveTab {
    fn index(self) -> usize {
        match self {
            Self::Ec2Connect => 0,
            Self::AmiCleanup => 1,
            Self::AsgScaling => 2,
        }
    }

    fn from_index(i: usize) -> Self {
        match i {
            0 => Self::Ec2Connect,
            1 => Self::AmiCleanup,
            _ => Self::AsgScaling,
        }
    }
}

/// Result of the tabbed TUI session.
pub(crate) enum TabResult {
    Connect(Instance),
    Quit,
}

struct TabApp {
    active_tab: ActiveTab,
    menu_open: bool,
    menu_cursor: usize,
    ec2: Ec2Phase,
    ami_app: AmiApp,
    ami_args: AmiCleanupArgs,
    asg_app: AsgApp,
    asg_scan_started: bool,
    config: Config,
}

/// Run the tabbed TUI. Returns the selected instance or Quit.
pub(crate) async fn run_tabbed(config: Config) -> Result<TabResult> {
    enable_raw_mode().map_err(|e| Error::Other(e.into()))?;
    stdout()
        .execute(EnterAlternateScreen)
        .map_err(|e| Error::Other(e.into()))?;

    let backend = CrosstermBackend::new(stdout());
    let mut terminal = Terminal::new(backend).map_err(|e| Error::Other(e.into()))?;

    // Initialize AMI cleanup tab with profile list
    let profiles = ami_cleanup::aws::list_profiles();
    let ami_app = if profiles.is_empty() {
        AmiApp::new_select_profile(vec![])
    } else {
        AmiApp::new_select_profile(profiles)
    };

    // Use scan_regions from file config; fall back to single --region if set
    let ami_regions = if !config.scan_regions.is_empty() {
        config.scan_regions.clone()
    } else {
        config.region.iter().cloned().collect()
    };

    let ami_args = AmiCleanupArgs {
        profile: config.profile.clone(),
        region: ami_regions,
        min_age_days: 0,
        consumer_profiles: Vec::new(),
    };

    // Build region display string for EC2 scanning indicator
    let ec2_regions_display = if let Some(ref r) = config.region {
        r.clone()
    } else if config.scan_regions.len() == 1 {
        config.scan_regions[0].clone()
    } else if !config.scan_regions.is_empty() {
        format!("{} regions", config.scan_regions.len())
    } else {
        "22 regions".to_string()
    };

    // Build ASG regions display string (reuse the same logic)
    let asg_regions_display = ec2_regions_display.clone();
    let asg_app = AsgApp::new_scanning(asg_regions_display);

    let mut app = TabApp {
        active_tab: ActiveTab::Ec2Connect,
        menu_open: false,
        menu_cursor: 0,
        ec2: Ec2Phase::new_scanning(ec2_regions_display),
        ami_app,
        ami_args,
        asg_app,
        asg_scan_started: false,
        config: config.clone(),
    };

    // Kick off EC2 scan in background
    let (ec2_tx, ec2_rx_inner) = mpsc::unbounded_channel();
    let mut ec2_rx = Some(ec2_rx_inner);
    {
        let config = config.clone();
        tokio::spawn(async move {
            let scanner = Scanner::new(config);
            let result = scanner.fetch_instances().await;
            let _ = ec2_tx.send(result);
        });
    }

    // AMI scan channel
    let (ami_tx, mut ami_rx) = mpsc::unbounded_channel::<ScanMsg>();

    // ASG channels
    let (asg_tx, mut asg_rx) = mpsc::unbounded_channel::<AsgMsg>();

    let mut reader = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(100));

    let result = loop {
        terminal
            .draw(|f| draw_frame(f, &mut app))
            .map_err(|e| Error::Other(e.into()))?;

        tokio::select! {
            biased;

            event = reader.next() => {
                match event {
                    Some(Ok(Event::Key(key))) => {
                        if key.kind != KeyEventKind::Press {
                            continue;
                        }

                        // Ctrl+C quits from anywhere
                        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
                            break TabResult::Quit;
                        }

                        // Menu is open: handle menu navigation
                        if app.menu_open {
                            match key.code {
                                KeyCode::Up | KeyCode::Char('k') => {
                                    if app.menu_cursor > 0 {
                                        app.menu_cursor -= 1;
                                    }
                                }
                                KeyCode::Down | KeyCode::Char('j') => {
                                    if app.menu_cursor + 1 < TAB_LABELS.len() {
                                        app.menu_cursor += 1;
                                    }
                                }
                                KeyCode::Enter => {
                                    app.active_tab = ActiveTab::from_index(app.menu_cursor);
                                    app.menu_open = false;
                                }
                                KeyCode::Esc | KeyCode::Tab => {
                                    app.menu_open = false;
                                }
                                _ => {}
                            }
                            continue;
                        }

                        // Tab key opens dropdown menu (but not when ASG tab is in text-input modes)
                        if key.code == KeyCode::Tab {
                            // In ASG InputAbsolute/Preview mode, Tab should not open menu
                            if app.active_tab == ActiveTab::AsgScaling
                                && matches!(
                                    app.asg_app.mode,
                                    AsgMode::InputAbsolute | AsgMode::Preview
                                )
                            {
                                app.asg_app.handle_key(key);
                            } else {
                                app.menu_open = true;
                                app.menu_cursor = app.active_tab.index();
                            }
                            continue;
                        }

                        // Delegate to active tab
                        match app.active_tab {
                            ActiveTab::Ec2Connect => {
                                match app.ec2.handle_key(key) {
                                    Ec2Action::Select(instance) => {
                                        break TabResult::Connect(instance);
                                    }
                                    Ec2Action::Quit => break TabResult::Quit,
                                    Ec2Action::None => {}
                                }
                            }
                            ActiveTab::AmiCleanup => {
                                match app.ami_app.handle_key(key) {
                                    AppAction::Quit => break TabResult::Quit,
                                    AppAction::Delete => {
                                        let profile = app.ami_app.profile_selector.owner_profile.clone()
                                            .or_else(|| app.ami_args.profile.clone())
                                            .unwrap_or_default();
                                        ami_cleanup::run_deletions(&mut terminal, &mut app.ami_app, &profile).await
                                            .map_err(Error::Other)?;
                                    }
                                    AppAction::StartScan => {
                                        let profile = app.ami_app.profile_selector.owner_profile.clone()
                                            .unwrap_or_default();
                                        let base_config = ami_cleanup::aws::build_config(&profile, None).await;
                                        let account_id = ami_cleanup::aws::get_account_id(&base_config)
                                            .await.unwrap_or_else(|_| "unknown".to_string());
                                        app.ami_app.header = format!("{account_id} (profile: {profile})");
                                        ami_cleanup::start_scan(&mut app.ami_app, &app.ami_args, ami_tx.clone()).await;
                                    }
                                    AppAction::None => {}
                                }
                            }
                            ActiveTab::AsgScaling => {
                                match app.asg_app.handle_key(key) {
                                    AsgAction::Quit => break TabResult::Quit,
                                    AsgAction::Apply => {
                                        // Collect updates from selected rows
                                        let updates: Vec<_> = app.asg_app.rows.iter()
                                            .filter(|r| r.selected && r.has_changes())
                                            .map(|r| (
                                                r.info.name.clone(),
                                                r.info.region.clone(),
                                                r.new_min.unwrap_or(r.info.min_size),
                                                r.new_max.unwrap_or(r.info.max_size),
                                                r.new_desired.unwrap_or(r.info.desired_capacity),
                                            ))
                                            .collect();
                                        asg_scaling::spawn_apply(&app.config, updates, asg_tx.clone());
                                    }
                                    AsgAction::None => {}
                                }
                            }
                        }
                    }
                    Some(Ok(Event::Resize(_, _))) => {}
                    _ => {}
                }
            }

            // EC2 scan result (disabled after first result received)
            result = async { ec2_rx.as_mut().unwrap().recv().await }, if ec2_rx.is_some() => {
                match result {
                    Some(Ok((instances, _elapsed))) => {
                        if instances.is_empty() {
                            app.ec2.set_error("No instances found".to_string());
                        } else {
                            app.ec2.load_instances(instances);
                        }
                    }
                    Some(Err(e)) => {
                        app.ec2.set_error(e.to_string());
                    }
                    None => {}
                }
                // Disable this branch — EC2 scan is one-shot
                ec2_rx = None;
            }

            // ASG messages
            msg = asg_rx.recv() => {
                match msg {
                    Some(AsgMsg::ScanFinished(asgs)) => {
                        if asgs.is_empty() {
                            app.asg_app.set_error("No ASGs found".into());
                        } else {
                            app.asg_app.load_results(asgs);
                        }
                    }
                    Some(AsgMsg::ScanError(e)) => {
                        app.asg_app.set_error(e);
                    }
                    Some(AsgMsg::ApplyOk(name)) => {
                        app.asg_app.apply_logs.push(format!("{name}: OK"));
                        app.asg_app.mark_applied(&name);
                    }
                    Some(AsgMsg::ApplyErr(name, err)) => {
                        app.asg_app.apply_logs.push(format!("{name}: FAILED ({err})"));
                        app.asg_app.mark_failed(&name, err);
                    }
                    Some(AsgMsg::ApplyDone) => {
                        app.asg_app.mode = AsgMode::Done;
                    }
                    None => {}
                }
            }

            // AMI scan messages
            msg = ami_rx.recv() => {
                match msg {
                    Some(ScanMsg::Log(text)) => app.ami_app.add_scan_log(text),
                    Some(ScanMsg::Done(text)) => {
                        // In parallel scan, Done replaces the last undone log if possible,
                        // otherwise appends as already-done entry.
                        if !app.ami_app.scan_logs.iter().rev().any(|l| !l.done) {
                            app.ami_app.scan_logs.push(ami_cleanup::app::ScanLog { text, done: true });
                        } else {
                            app.ami_app.finish_scan_log(text);
                        }
                    }
                    Some(ScanMsg::Error(text)) => {
                        app.ami_app.scan_logs.push(ami_cleanup::app::ScanLog { text, done: true });
                        app.ami_app.mode = AppMode::Done;
                    }
                    Some(ScanMsg::Finished(results)) => {
                        let elapsed = app.ami_app.elapsed_secs();
                        app.ami_app.add_scan_log(format!("Scan completed in {elapsed}s"));
                        app.ami_app.finish_scan_log(format!("Scan completed in {elapsed}s"));
                        terminal.draw(|f| draw_frame(f, &mut app)).map_err(|e| Error::Other(e.into()))?;
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                        app.ami_app.load_scan_results(&results);
                    }
                    None => {}
                }
            }

            // Tick (spinner animation)
            _ = tick.tick() => {
                app.ec2.tick_spinner();
                if app.ami_app.mode == AppMode::Scanning {
                    app.ami_app.tick_spinner();
                }
                if matches!(app.asg_app.mode, AsgMode::Scanning | AsgMode::Applying) {
                    app.asg_app.tick_spinner();
                }

                // Lazy ASG scan: start when the tab is first displayed
                if app.active_tab == ActiveTab::AsgScaling
                    && !app.asg_scan_started
                    && app.asg_app.mode == AsgMode::Scanning
                {
                    app.asg_scan_started = true;
                    asg_scaling::spawn_scan(&app.config, asg_tx.clone());
                }
            }
        }
    };

    disable_raw_mode().map_err(|e| Error::Other(e.into()))?;
    stdout()
        .execute(LeaveAlternateScreen)
        .map_err(|e| Error::Other(e.into()))?;

    Ok(result)
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

fn draw_frame(frame: &mut Frame, app: &mut TabApp) {
    let chunks = Layout::vertical([
        Constraint::Length(1), // Menu bar
        Constraint::Min(1),    // Tab content
    ])
    .split(frame.area());

    draw_menu_bar(frame, chunks[0], app.active_tab);

    // Clear content area before rendering active tab to prevent stale text
    frame.render_widget(Clear, chunks[1]);

    match app.active_tab {
        ActiveTab::Ec2Connect => app.ec2.draw(frame, chunks[1], &app.config),
        ActiveTab::AmiCleanup => ami_cleanup::ui::draw(frame, &mut app.ami_app, chunks[1]),
        ActiveTab::AsgScaling => {
            let profile = app.config.profile_display().to_string();
            asg_scaling::ui::draw(frame, &mut app.asg_app, chunks[1], &profile);
        }
    }

    // Dropdown overlay (drawn last so it's on top)
    if app.menu_open {
        draw_dropdown(frame, chunks[0], app.menu_cursor, app.active_tab);
    }
}

/// Yellow background menu bar with version + active tab indicator.
fn draw_menu_bar(frame: &mut Frame, area: Rect, active: ActiveTab) {
    let bar_style = Style::default().fg(Color::Black).bg(Color::Yellow);

    let version = format!(
        "ij v{} ({})",
        env!("CARGO_PKG_VERSION"),
        env!("BUILD_COMMIT")
    );

    let active_label = TAB_LABELS[active.index()];

    let line = Line::from(vec![
        Span::styled(
            format!(" {version}"),
            bar_style.add_modifier(Modifier::BOLD),
        ),
        Span::styled(" | ", bar_style),
        Span::styled(
            format!("[Tab] {active_label}"),
            bar_style.add_modifier(Modifier::BOLD),
        ),
    ]);

    // Fill entire bar width with yellow background
    let bar = Paragraph::new(line).style(bar_style);
    frame.render_widget(bar, area);
}

/// Dropdown menu overlaid below the menu bar.
fn draw_dropdown(frame: &mut Frame, bar_area: Rect, cursor: usize, _active: ActiveTab) {
    let width = 52u16;
    // Each menu item = label line + description line → 2 lines per item, +2 for border
    let height = TAB_LABELS.len() as u16 * 2 + 2;

    // Position below the bar, aligned to the right side of the version text
    let x = bar_area.x + 2;
    let y = bar_area.y + bar_area.height;

    let dropdown_area = Rect::new(
        x,
        y,
        width.min(frame.area().width.saturating_sub(x)),
        height.min(frame.area().height.saturating_sub(y)),
    );

    frame.render_widget(Clear, dropdown_area);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .style(Style::default().bg(Color::Black));

    let inner = block.inner(dropdown_area);
    frame.render_widget(block, dropdown_area);

    let inner_width = inner.width as usize;

    let mut lines: Vec<Line> = Vec::new();
    for (i, (label, desc)) in TAB_LABELS.iter().zip(TAB_DESCS.iter()).enumerate() {
        let is_cursor = i == cursor;
        let prefix = if is_cursor { " > " } else { "   " };

        let label_style = if is_cursor {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Yellow)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White).bg(Color::Black)
        };

        let desc_style = Style::default().fg(Color::DarkGray).bg(Color::Black);

        let label_text = format!("{prefix}{label}");
        let padded_label = format!("{:<width$}", label_text, width = inner_width);
        lines.push(Line::from(Span::styled(padded_label, label_style)));
        lines.push(Line::from(Span::styled(format!("   {desc}"), desc_style)));
    }

    frame.render_widget(Paragraph::new(lines), inner);
}
