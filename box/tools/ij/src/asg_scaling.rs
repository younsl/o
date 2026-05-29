//! ASG Scaling tab: scan and scale Auto Scaling Groups.

pub(crate) mod app;
pub(crate) mod aws;
pub(crate) mod ui;

use tokio::sync::mpsc;
use tracing::warn;

use crate::ami_cleanup::aws as ami_aws;
use crate::config::{AWS_REGIONS, Config};

use self::aws::AsgInfo;

/// Messages sent from background scan/apply tasks to the TUI loop.
pub(crate) enum Msg {
    /// ASG scan completed for all regions.
    ScanFinished(Vec<AsgInfo>),
    /// ASG scan failed.
    ScanError(String),
    /// A single ASG update succeeded.
    ApplyOk(String),
    /// A single ASG update failed.
    ApplyErr(String, String),
    /// All apply operations finished.
    ApplyDone,
}

/// Spawn background ASG scan across regions.
pub(crate) fn spawn_scan(config: &Config, tx: mpsc::UnboundedSender<Msg>) {
    let profile = config.profile.clone().unwrap_or_else(|| "default".into());
    let regions: Vec<String> = if let Some(ref r) = config.region {
        vec![r.clone()]
    } else if !config.scan_regions.is_empty() {
        config.scan_regions.clone()
    } else {
        AWS_REGIONS.iter().map(|s| s.to_string()).collect()
    };

    tokio::spawn(async move {
        let base_config = ami_aws::build_config(&profile, None).await;

        let mut handles = tokio::task::JoinSet::new();
        for region in regions {
            let base = base_config.clone();
            handles.spawn(async move { aws::list_asgs(&base, &region).await });
        }

        let mut all_asgs: Vec<AsgInfo> = Vec::new();
        while let Some(result) = handles.join_next().await {
            match result {
                Ok(Ok(asgs)) => all_asgs.extend(asgs),
                Ok(Err(e)) => warn!("ASG scan error: {e}"),
                Err(e) => warn!("ASG scan task panic: {e}"),
            }
        }

        all_asgs.sort_by(|a, b| a.region.cmp(&b.region).then_with(|| a.name.cmp(&b.name)));

        if all_asgs.is_empty() {
            let _ = tx.send(Msg::ScanError("No ASGs found".into()));
        } else {
            let _ = tx.send(Msg::ScanFinished(all_asgs));
        }
    });
}

/// Spawn background apply operations for selected ASGs.
pub(crate) fn spawn_apply(
    config: &Config,
    updates: Vec<(String, String, i32, i32, i32)>, // (name, region, min, max, desired)
    tx: mpsc::UnboundedSender<Msg>,
) {
    let profile = config.profile.clone().unwrap_or_else(|| "default".into());

    tokio::spawn(async move {
        let base_config = ami_aws::build_config(&profile, None).await;

        for (name, region, min, max, desired) in updates {
            match aws::update_asg(&base_config, &region, &name, min, max, desired).await {
                Ok(()) => {
                    let _ = tx.send(Msg::ApplyOk(name));
                }
                Err(e) => {
                    let err = format!("{e}");
                    let _ = tx.send(Msg::ApplyErr(name, err));
                }
            }
        }

        let _ = tx.send(Msg::ApplyDone);
    });
}
