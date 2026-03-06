mod ami;
mod app;
mod aws;
mod cleanup;
mod cli;
mod error;
mod ui;

use std::io::stdout;
use std::time::Duration;

use clap::Parser;
use crossterm::{
    event::{Event, EventStream},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use futures::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

use crate::ami::ScanResult;
use crate::app::{App, AppAction, AppMode};
use crate::cli::Cli;

/// Messages sent from the background scan task to the TUI loop.
enum ScanMsg {
    Log(String),
    Done(String),
    Finished(Vec<ScanResult>),
    Error(String),
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;

    let backend = CrosstermBackend::new(stdout());
    let mut terminal = Terminal::new(backend)?;

    let mut app = if cli.profile.is_some() {
        // CLI mode: skip profile selection
        let profile = cli.profile.as_deref().unwrap();
        let base_config = aws::build_config(profile, None).await;
        let account_id = aws::get_account_id(&base_config).await?;
        let header = format!("{account_id} (profile: {profile})");
        App::new_scanning(header)
    } else {
        // Interactive mode: show profile selector
        let profiles = aws::list_profiles();
        if profiles.is_empty() {
            disable_raw_mode()?;
            stdout().execute(LeaveAlternateScreen)?;
            anyhow::bail!("No AWS profiles found in ~/.aws/config or ~/.aws/credentials");
        }
        App::new_select_profile(profiles)
    };

    let result = run_app(&mut terminal, &mut app, &cli).await;

    disable_raw_mode()?;
    stdout().execute(LeaveAlternateScreen)?;

    result?;

    let deleted = app.deleted_count();
    let failed = app.failed_count();
    if deleted > 0 || failed > 0 {
        println!("Cleanup: {} deleted, {} failed", deleted, failed);
    }

    Ok(())
}

struct ScanParams {
    profile: String,
    regions: Vec<String>,
    min_age_days: u64,
    consumer_profiles: Vec<String>,
}

/// Spawn the scanning work on a background task, sending progress via channel.
fn spawn_scan(params: ScanParams, tx: mpsc::UnboundedSender<ScanMsg>) {
    let profile = params.profile;
    let regions = params.regions;
    let min_age_days = params.min_age_days;
    let consumer_profiles = params.consumer_profiles;

    tokio::spawn(async move {
        let base_config = aws::build_config(&profile, None).await;

        // Determine regions
        let regions = if !regions.is_empty() {
            let _ = tx.send(ScanMsg::Log(format!(
                "{} region(s) specified",
                regions.len()
            )));
            let _ = tx.send(ScanMsg::Done(format!(
                "{} region(s) specified",
                regions.len()
            )));
            regions
        } else if let Some(r) = aws::get_profile_region(&base_config) {
            let _ = tx.send(ScanMsg::Log(format!("Using profile region: {r}")));
            let _ = tx.send(ScanMsg::Done(format!("Using profile region: {r}")));
            vec![r]
        } else {
            let _ = tx.send(ScanMsg::Log("Fetching all enabled regions...".to_string()));
            match aws::get_enabled_regions(&base_config).await {
                Ok(r) => {
                    let _ = tx.send(ScanMsg::Done(format!("{} regions found", r.len())));
                    r
                }
                Err(e) => {
                    let _ = tx.send(ScanMsg::Error(format!("Failed to fetch regions: {e}")));
                    return;
                }
            }
        };

        let mut scan_results = Vec::new();

        for (i, region) in regions.iter().enumerate() {
            let prefix = format!("[{}/{}] {region}", i + 1, regions.len());

            let config = aws::build_config(&profile, Some(region)).await;
            let ec2 = aws_sdk_ec2::Client::new(&config);
            let asg = aws_sdk_autoscaling::Client::new(&config);

            // Step 1: List owned AMIs
            let _ = tx.send(ScanMsg::Log(format!("{prefix}: Listing owned AMIs...")));
            let mut owned_amis = match ami::get_owned_amis(&ec2).await {
                Ok(amis) => {
                    let _ = tx.send(ScanMsg::Done(format!(
                        "{prefix}: {} owned AMIs",
                        amis.len()
                    )));
                    amis
                }
                Err(e) => {
                    let _ = tx.send(ScanMsg::Done(format!("{prefix}: FAILED: {e}")));
                    continue;
                }
            };

            // Step 2: Collect in-use refs from owner account
            let _ = tx.send(ScanMsg::Log(format!("{prefix}: Collecting in-use refs...")));
            let mut used_ami_ids = match ami::get_used_ami_ids(&ec2, &asg).await {
                Ok(ids) => {
                    let _ = tx.send(ScanMsg::Done(format!(
                        "{prefix}: {} in-use refs",
                        ids.len()
                    )));
                    ids
                }
                Err(e) => {
                    let _ = tx.send(ScanMsg::Done(format!("{prefix}: FAILED: {e}")));
                    continue;
                }
            };

            // Step 2b: Collect in-use refs from consumer accounts
            for cp in &consumer_profiles {
                let _ = tx.send(ScanMsg::Log(format!(
                    "{prefix}: Checking consumer [{cp}]..."
                )));
                let cp_config = aws::build_config(cp, Some(region)).await;
                let cp_ec2 = aws_sdk_ec2::Client::new(&cp_config);
                let cp_asg = aws_sdk_autoscaling::Client::new(&cp_config);
                match ami::get_used_ami_ids(&cp_ec2, &cp_asg).await {
                    Ok(ids) => {
                        let _ = tx.send(ScanMsg::Done(format!(
                            "{prefix}: [{cp}] {} in-use refs",
                            ids.len()
                        )));
                        used_ami_ids.extend(ids);
                    }
                    Err(e) => {
                        let _ = tx.send(ScanMsg::Done(format!("{prefix}: [{cp}] FAILED: {e}")));
                    }
                }
            }

            // Step 3: Check launch permissions
            let _ = tx.send(ScanMsg::Log(format!(
                "{prefix}: Checking launch permissions ({} AMIs)...",
                owned_amis.len()
            )));
            ami::check_shared_amis(&ec2, &mut owned_amis).await;
            let shared_count = owned_amis.iter().filter(|a| a.shared).count();
            let _ = tx.send(ScanMsg::Done(format!(
                "{prefix}: {shared_count} shared (skipped)"
            )));

            // Compute unused
            let unused_amis = ami::compute_unused(&owned_amis, &used_ami_ids, min_age_days);
            let _ = tx.send(ScanMsg::Log(format!(
                "{prefix}: {} unused AMIs",
                unused_amis.len()
            )));
            let _ = tx.send(ScanMsg::Done(format!(
                "{prefix}: {} unused AMIs",
                unused_amis.len()
            )));

            scan_results.push(ScanResult {
                region: region.clone(),
                owned_amis,
                used_ami_ids,
                unused_amis,
            });
        }

        let _ = tx.send(ScanMsg::Finished(scan_results));
    });
}

/// Handle a key action. Returns true if the app should quit.
async fn handle_action(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    app: &mut App,
    cli: &Cli,
    tx: &mpsc::UnboundedSender<ScanMsg>,
    key: crossterm::event::KeyEvent,
) -> anyhow::Result<bool> {
    match app.handle_key(key) {
        AppAction::Quit => return Ok(true),
        AppAction::Delete => {
            let profile = app
                .profile_selector
                .owner_profile
                .clone()
                .or_else(|| cli.profile.clone())
                .unwrap_or_default();
            run_deletions(terminal, app, &profile).await?;
        }
        AppAction::StartScan => {
            let profile = app
                .profile_selector
                .owner_profile
                .clone()
                .unwrap_or_default();
            let base_config = aws::build_config(&profile, None).await;
            let account_id = aws::get_account_id(&base_config)
                .await
                .unwrap_or_else(|_| "unknown".to_string());
            app.header = format!("{account_id} (profile: {profile})");
            start_scan(app, cli, tx.clone()).await;
        }
        AppAction::None => {}
    }
    Ok(false)
}

async fn start_scan(app: &mut App, cli: &Cli, tx: mpsc::UnboundedSender<ScanMsg>) {
    let profile = app
        .profile_selector
        .owner_profile
        .clone()
        .or_else(|| cli.profile.clone())
        .unwrap_or_default();

    let consumer_profiles = if !app.profile_selector.consumer_profiles.is_empty() {
        app.profile_selector.consumer_profiles.clone()
    } else {
        cli.consumer_profiles.clone()
    };

    spawn_scan(
        ScanParams {
            profile,
            regions: cli.region.clone(),
            min_age_days: cli.min_age_days,
            consumer_profiles,
        },
        tx,
    );
}

async fn run_app(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    app: &mut App,
    cli: &Cli,
) -> anyhow::Result<()> {
    let mut reader = EventStream::new();
    let (tx, mut rx) = mpsc::unbounded_channel();

    // If starting in Scanning mode (CLI provided --profile), kick off scan immediately
    if app.mode == AppMode::Scanning {
        start_scan(app, cli, tx.clone()).await;
    }

    let mut tick = tokio::time::interval(Duration::from_millis(100));

    terminal.draw(|f| ui::draw(f, app))?;

    loop {
        if app.mode == AppMode::Scanning {
            tokio::select! {
                biased;

                event = reader.next() => {
                    if let Some(Ok(Event::Key(key))) = event {
                        if matches!(app.handle_key(key), AppAction::Quit) {
                            break;
                        }
                    }
                    terminal.draw(|f| ui::draw(f, app))?;
                }

                msg = rx.recv() => {
                    match msg {
                        Some(ScanMsg::Log(text)) => app.add_scan_log(text),
                        Some(ScanMsg::Done(text)) => app.finish_scan_log(text),
                        Some(ScanMsg::Error(text)) => {
                            app.add_scan_log(text.clone());
                            app.finish_scan_log(text);
                            app.mode = AppMode::Done;
                        }
                        Some(ScanMsg::Finished(results)) => {
                            app.load_scan_results(&results);
                        }
                        None => {
                            if app.mode == AppMode::Scanning {
                                app.mode = AppMode::Done;
                            }
                        }
                    }
                    terminal.draw(|f| ui::draw(f, app))?;
                }

                _ = tick.tick() => {
                    app.tick_spinner();
                    terminal.draw(|f| ui::draw(f, app))?;
                }
            }
        } else {
            let event = reader.next().await;
            if let Some(Ok(Event::Key(key))) = event {
                let action = handle_action(terminal, app, cli, &tx, key).await?;
                if action {
                    break;
                }
                // Drain buffered key events via EventStream (not raw crossterm)
                loop {
                    match tokio::time::timeout(Duration::ZERO, reader.next()).await {
                        Ok(Some(Ok(Event::Key(key)))) => {
                            if handle_action(terminal, app, cli, &tx, key).await? {
                                terminal.draw(|f| ui::draw(f, app))?;
                                return Ok(());
                            }
                        }
                        _ => break,
                    }
                }
                terminal.draw(|f| ui::draw(f, app))?;
            }
        }
    }

    Ok(())
}

async fn run_deletions(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    app: &mut App,
    profile: &str,
) -> anyhow::Result<()> {
    let deleting: Vec<_> = app
        .rows
        .iter()
        .filter(|r| r.status == app::AmiStatus::Deleting)
        .map(|r| (r.region.clone(), r.ami.clone()))
        .collect();

    for (region, ami_data) in deleting {
        let config = aws::build_config(profile, Some(&region)).await;
        let ec2 = aws_sdk_ec2::Client::new(&config);
        let result = cleanup::delete_ami(&ec2, &ami_data).await;

        if result.deregister_ok {
            app.mark_deleted(&ami_data.ami_id);
        } else {
            let err = result
                .deregister_err
                .unwrap_or_else(|| "unknown".to_string());
            app.mark_failed(&ami_data.ami_id, err);
        }

        terminal.draw(|f| ui::draw(f, app))?;
    }

    if !app.has_deleting() {
        app.mode = AppMode::Browse;
        terminal.draw(|f| ui::draw(f, app))?;
    }

    Ok(())
}
