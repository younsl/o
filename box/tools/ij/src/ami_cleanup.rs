mod ami;
pub(crate) mod app;
pub(crate) mod aws;
mod cleanup;
mod error;
pub(crate) mod ui;

use std::io::stdout;
use std::time::Duration;

use crossterm::{
    ExecutableCommand,
    event::{Event, EventStream},
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use futures::StreamExt;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use tokio::sync::mpsc;

use self::ami::ScanResult;
use self::app::{App, AppAction, AppMode};

/// CLI arguments for the ami-cleanup subcommand.
#[derive(clap::Args, Debug, Clone, PartialEq)]
pub struct AmiCleanupArgs {
    /// AWS profile name (interactive selection if omitted)
    #[arg(long)]
    pub profile: Option<String>,

    /// AWS regions to scan (defaults to all enabled regions)
    #[arg(long, short)]
    pub region: Vec<String>,

    /// Only target AMIs older than N days
    #[arg(long, default_value_t = 0)]
    pub min_age_days: u64,

    /// Additional AWS profiles to check for AMI usage (e.g. dev, stg, prd accounts)
    #[arg(long = "consumer-profile")]
    pub consumer_profiles: Vec<String>,
}

/// Messages sent from the background scan task to the TUI loop.
pub(crate) enum ScanMsg {
    Log(String),
    Done(String),
    Finished(Vec<ScanResult>),
    Error(String),
}

pub(crate) struct ScanParams {
    pub profile: String,
    pub regions: Vec<String>,
    pub min_age_days: u64,
    pub consumer_profiles: Vec<String>,
}

/// Entry point for the ami-cleanup subcommand.
pub async fn run(args: AmiCleanupArgs) -> anyhow::Result<()> {
    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;

    let backend = CrosstermBackend::new(stdout());
    let mut terminal = Terminal::new(backend)?;

    let mut app = if args.profile.is_some() {
        // CLI mode: skip profile selection
        let profile = args.profile.as_deref().unwrap();
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

    let result = run_app(&mut terminal, &mut app, &args).await;

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

/// Spawn the scanning work on a background task, sending progress via channel.
pub(crate) fn spawn_scan(params: ScanParams, tx: mpsc::UnboundedSender<ScanMsg>) {
    let profile = params.profile;
    let regions = params.regions;
    let min_age_days = params.min_age_days;
    let consumer_profiles = params.consumer_profiles;

    tokio::spawn(async move {
        // Send initial message before any async work so the UI shows progress immediately
        let _ = tx.send(ScanMsg::Log(format!("Initializing profile: {profile}...")));

        let base_config = aws::build_config(&profile, None).await;

        // Log scan parameters
        let consumers = if consumer_profiles.is_empty() {
            "none".to_string()
        } else {
            consumer_profiles.join(", ")
        };
        let age_filter = if min_age_days > 0 {
            format!(" older than {min_age_days}d")
        } else {
            String::new()
        };
        let _ = tx.send(ScanMsg::Done(format!(
            "Scanning AMIs{age_filter} owned by {profile} with consumers [{consumers}]"
        )));

        // Determine regions
        let regions = if !regions.is_empty() {
            let _ = tx.send(ScanMsg::Done(format!(
                "{} region(s): {}",
                regions.len(),
                regions.join(", ")
            )));
            regions
        } else if let Some(r) = aws::get_profile_region(&base_config) {
            let _ = tx.send(ScanMsg::Done(format!("Using profile region: {r}")));
            vec![r]
        } else {
            let _ = tx.send(ScanMsg::Log("Fetching all enabled regions..".to_string()));
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

        let multi = regions.len() > 1;
        let total = regions.len();

        // Scan all regions in parallel
        let mut handles = tokio::task::JoinSet::new();

        for (i, region) in regions.into_iter().enumerate() {
            let tx = tx.clone();
            let profile = profile.clone();
            let consumer_profiles = consumer_profiles.clone();

            handles.spawn(async move {
                let prefix = if multi {
                    format!("[{}/{}] {region}", i + 1, total)
                } else {
                    region.clone()
                };

                let config = aws::build_config(&profile, Some(&region)).await;
                let ec2 = aws_sdk_ec2::Client::new(&config);
                let asg = aws_sdk_autoscaling::Client::new(&config);

                // Step 1: List owned AMIs
                let _ = tx.send(ScanMsg::Log(format!("{prefix}: Listing owned AMIs..")));
                let mut owned_amis = match ami::get_owned_amis(&ec2).await {
                    Ok(amis) => {
                        let _ = tx.send(ScanMsg::Done(format!(
                            "{prefix}: Found {} owned AMIs",
                            amis.len()
                        )));
                        amis
                    }
                    Err(e) => {
                        let _ = tx.send(ScanMsg::Done(format!("{prefix}: FAILED: {e}")));
                        return None;
                    }
                };

                // Step 2: Collect in-use refs
                let _ = tx.send(ScanMsg::Log(format!("{prefix}: Collecting in-use refs..")));
                let mut used_ami_ids = match ami::get_used_ami_ids(&ec2, &asg).await {
                    Ok(ids) => {
                        let _ = tx.send(ScanMsg::Done(format!(
                            "{prefix}: {profile} uses {} AMIs",
                            ids.len()
                        )));
                        ids
                    }
                    Err(e) => {
                        let _ = tx.send(ScanMsg::Done(format!("{prefix}: FAILED: {e}")));
                        return None;
                    }
                };

                // Step 2b: Consumer accounts
                for cp in &consumer_profiles {
                    let _ = tx.send(ScanMsg::Log(format!("{prefix}: Consumer [{cp}]..")));
                    let cp_config = aws::build_config(cp, Some(&region)).await;
                    let cp_ec2 = aws_sdk_ec2::Client::new(&cp_config);
                    let cp_asg = aws_sdk_autoscaling::Client::new(&cp_config);
                    match ami::get_used_ami_ids(&cp_ec2, &cp_asg).await {
                        Ok(ids) => {
                            let _ = tx.send(ScanMsg::Done(format!(
                                "{prefix}: {cp} uses {} AMIs",
                                ids.len()
                            )));
                            used_ami_ids.extend(ids);
                        }
                        Err(e) => {
                            let _ = tx.send(ScanMsg::Done(format!("{prefix}: [{cp}] FAILED: {e}")));
                        }
                    }
                }

                // Step 3: Shared check
                let _ = tx.send(ScanMsg::Log(format!("{prefix}: Checking shared..")));
                ami::check_shared_amis(&ec2, &mut owned_amis).await;
                let shared = owned_amis.iter().filter(|a| a.shared).count();
                let unused_amis = ami::compute_unused(&owned_amis, &used_ami_ids, min_age_days);
                let _ = tx.send(ScanMsg::Done(format!(
                    "{prefix}: {} unused, {shared} shared (skipped)",
                    unused_amis.len()
                )));

                Some(ScanResult {
                    region,
                    owned_amis,
                    used_ami_ids,
                    unused_amis,
                })
            });
        }

        // Collect results from all parallel tasks
        let mut scan_results = Vec::new();
        while let Some(result) = handles.join_next().await {
            if let Ok(Some(scan_result)) = result {
                scan_results.push(scan_result);
            }
        }

        // Sort by region name for consistent ordering
        scan_results.sort_by(|a, b| a.region.cmp(&b.region));

        let _ = tx.send(ScanMsg::Finished(scan_results));
    });
}

/// Handle a key action. Returns true if the app should quit.
pub(crate) async fn handle_action(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    app: &mut App,
    args: &AmiCleanupArgs,
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
                .or_else(|| args.profile.clone())
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
            start_scan(app, args, tx.clone()).await;
        }
        AppAction::None => {}
    }
    Ok(false)
}

pub(crate) async fn start_scan(
    app: &mut App,
    args: &AmiCleanupArgs,
    tx: mpsc::UnboundedSender<ScanMsg>,
) {
    let profile = app
        .profile_selector
        .owner_profile
        .clone()
        .or_else(|| args.profile.clone())
        .unwrap_or_default();

    let consumer_profiles = if !app.profile_selector.consumer_profiles.is_empty() {
        app.profile_selector.consumer_profiles.clone()
    } else {
        args.consumer_profiles.clone()
    };

    spawn_scan(
        ScanParams {
            profile,
            regions: args.region.clone(),
            min_age_days: args.min_age_days,
            consumer_profiles,
        },
        tx,
    );
}

async fn run_app(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    app: &mut App,
    args: &AmiCleanupArgs,
) -> anyhow::Result<()> {
    let mut reader = EventStream::new();
    let (tx, mut rx) = mpsc::unbounded_channel();

    // If starting in Scanning mode (CLI provided --profile), kick off scan immediately
    if app.mode == AppMode::Scanning {
        start_scan(app, args, tx.clone()).await;
    }

    let mut tick = tokio::time::interval(Duration::from_millis(100));

    terminal.draw(|f| ui::draw(f, app, f.area()))?;

    loop {
        if app.mode == AppMode::Scanning {
            tokio::select! {
                biased;

                event = reader.next() => {
                    match event {
                        Some(Ok(Event::Key(key))) => {
                            if matches!(app.handle_key(key), AppAction::Quit) {
                                break;
                            }
                        }
                        Some(Ok(Event::Resize(_, _))) => {}
                        _ => {}
                    }
                    terminal.draw(|f| ui::draw(f, app, f.area()))?;
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
                            let elapsed = app.elapsed_secs();
                            app.add_scan_log(format!("Scan completed in {elapsed}s"));
                            app.finish_scan_log(format!("Scan completed in {elapsed}s"));
                            terminal.draw(|f| ui::draw(f, app, f.area()))?;
                            tokio::time::sleep(Duration::from_millis(1500)).await;
                            app.load_scan_results(&results);
                        }
                        None => {
                            if app.mode == AppMode::Scanning {
                                app.mode = AppMode::Done;
                            }
                        }
                    }
                    terminal.draw(|f| ui::draw(f, app, f.area()))?;
                }

                _ = tick.tick() => {
                    app.tick_spinner();
                    terminal.draw(|f| ui::draw(f, app, f.area()))?;
                }
            }
        } else {
            let event = reader.next().await;
            if let Some(Ok(Event::Resize(_, _))) = event {
                terminal.draw(|f| ui::draw(f, app, f.area()))?;
            } else if let Some(Ok(Event::Key(key))) = event {
                let action = handle_action(terminal, app, args, &tx, key).await?;
                if action {
                    break;
                }
                // Drain buffered key events via EventStream (not raw crossterm)
                while let Ok(Some(Ok(Event::Key(key)))) =
                    tokio::time::timeout(Duration::ZERO, reader.next()).await
                {
                    if handle_action(terminal, app, args, &tx, key).await? {
                        terminal.draw(|f| ui::draw(f, app, f.area()))?;
                        return Ok(());
                    }
                }
                terminal.draw(|f| ui::draw(f, app, f.area()))?;
            }
        }
    }

    Ok(())
}

pub(crate) async fn run_deletions(
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

        terminal.draw(|f| ui::draw(f, app, f.area()))?;
    }

    if !app.has_deleting() {
        app.mode = AppMode::Browse;
        terminal.draw(|f| ui::draw(f, app, f.area()))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    #[derive(Parser)]
    struct TestCli {
        #[command(flatten)]
        args: super::AmiCleanupArgs,
    }

    #[test]
    fn test_defaults() {
        let cli = TestCli::try_parse_from(["test"]).unwrap();
        assert!(cli.args.profile.is_none());
        assert!(cli.args.region.is_empty());
        assert_eq!(cli.args.min_age_days, 0);
        assert!(cli.args.consumer_profiles.is_empty());
    }

    #[test]
    fn test_with_profile() {
        let cli = TestCli::try_parse_from(["test", "--profile", "prod"]).unwrap();
        assert_eq!(cli.args.profile, Some("prod".into()));
    }

    #[test]
    fn test_with_regions() {
        let cli = TestCli::try_parse_from(["test", "-r", "us-east-1", "-r", "eu-west-1"]).unwrap();
        assert_eq!(cli.args.region, vec!["us-east-1", "eu-west-1"]);
    }

    #[test]
    fn test_with_min_age_days() {
        let cli = TestCli::try_parse_from(["test", "--min-age-days", "30"]).unwrap();
        assert_eq!(cli.args.min_age_days, 30);
    }

    #[test]
    fn test_with_consumer_profiles() {
        let cli = TestCli::try_parse_from([
            "test",
            "--consumer-profile",
            "dev",
            "--consumer-profile",
            "stg",
        ])
        .unwrap();
        assert_eq!(cli.args.consumer_profiles, vec!["dev", "stg"]);
    }

    #[test]
    fn test_all_options() {
        let cli = TestCli::try_parse_from([
            "test",
            "--profile",
            "prod",
            "-r",
            "us-east-1",
            "--min-age-days",
            "90",
            "--consumer-profile",
            "dev",
        ])
        .unwrap();
        assert_eq!(cli.args.profile, Some("prod".into()));
        assert_eq!(cli.args.region, vec!["us-east-1"]);
        assert_eq!(cli.args.min_age_days, 90);
        assert_eq!(cli.args.consumer_profiles, vec!["dev"]);
    }
}
