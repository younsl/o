//! Interactive `send` subcommand — operator tool for manual re-delivery.
//!
//! Lists recent AWS Health events in the terminal, lets the operator
//! multi-select, then **shows a preview of each rendered Slack message**
//! and asks for per-event y/N confirmation before posting.
//!
//! Bypasses dedup and the running daemon's allow/deny filters — the
//! operator's intent is treated as authoritative.

use std::time::Duration;

use anyhow::{Context, bail};
use chrono::{Duration as ChronoDuration, Utc};
use dialoguer::Confirm;

use crate::aws::account::AccountIdentity;
use crate::aws::health::{EventSummary, HealthClient};
use crate::config::{SendArgs, SlackArgs};
use crate::slack::client::SlackClient;
use crate::slack::formatter::{self, SlackMessageOpts};

pub async fn run(slack_cfg: SlackArgs, args: SendArgs) -> anyhow::Result<()> {
    let slack = SlackClient::new(
        slack_cfg.slack_webhook_url.clone(),
        Duration::from_secs(slack_cfg.slack_timeout_secs),
    )
    .context("construct Slack client")?;

    let aws = HealthClient::from_env(args.event_locale.clone())
        .await
        .context("construct AWS Health client")?;
    let account = AccountIdentity::resolve().await;
    let account_label = account.display();

    let summaries = fetch_summaries(&aws, &args).await?;
    if summaries.is_empty() {
        eprintln!("No events found in the requested window.");
        return Ok(());
    }

    let picked = if args.arn.is_empty() {
        prompt_selection(&summaries)?
    } else {
        (0..summaries.len()).collect()
    };
    if picked.is_empty() {
        eprintln!("Nothing selected — exiting.");
        return Ok(());
    }

    let channel_display = slack_cfg
        .slack_channel
        .as_deref()
        .unwrap_or("default channel");

    let opts = SlackMessageOpts {
        channel: slack_cfg.slack_channel.as_deref(),
        username: &slack_cfg.slack_username,
        icon_emoji: &slack_cfg.slack_icon_emoji,
        account_label: account_label.as_deref(),
        reminder_offset_hours: None,
    };

    let mut failures = 0usize;
    let mut sent = 0usize;
    let mut skipped = 0usize;
    for (idx, i) in picked.iter().enumerate() {
        let summary = summaries[*i].clone();
        let arn = summary.arn.clone();
        let event = match aws.hydrate(summary).await {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[{arn}] hydrate failed: {e:#}");
                failures += 1;
                continue;
            }
        };

        let payload = formatter::build(&event, &opts);

        if !args.yes {
            let pos = idx + 1;
            let total = picked.len();
            eprintln!("\n──── Preview {pos} of {total} ({arn}) — actual Slack payload ────");
            match serde_json::to_string_pretty(&payload) {
                Ok(s) => eprintln!("{s}"),
                Err(e) => eprintln!("(failed to serialize payload: {e})"),
            }
            eprintln!("─────────────────────────────────────────────────");
            let go = Confirm::new()
                .with_prompt(format!("POST this payload to Slack ({channel_display})?"))
                .default(true)
                .interact()
                .context("per-event confirmation prompt")?;
            if !go {
                eprintln!("[{arn}] skipped");
                skipped += 1;
                continue;
            }
        }

        match slack.post(&payload).await {
            Ok(()) => {
                eprintln!("[{arn}] sent");
                sent += 1;
            }
            Err(e) => {
                eprintln!("[{arn}] slack post failed: {e}");
                failures += 1;
            }
        }
    }

    eprintln!("\nSummary — sent: {sent}, skipped: {skipped}, failed: {failures}");
    if failures > 0 {
        bail!("{failures} event(s) failed to send");
    }
    Ok(())
}

async fn fetch_summaries(aws: &HealthClient, args: &SendArgs) -> anyhow::Result<Vec<EventSummary>> {
    if args.arn.is_empty() {
        let from = Utc::now() - ChronoDuration::hours(args.lookback_hours);
        let to = Utc::now();
        eprintln!(
            "Fetching events updated since {} (lookback {}h)…",
            from.to_rfc3339(),
            args.lookback_hours
        );
        aws.list_events(from, to, &args.service, &args.category)
            .await
            .context("list events")
    } else {
        eprintln!("Direct ARN mode — skipping list");
        Ok(args
            .arn
            .iter()
            .map(|a| EventSummary {
                arn: a.clone(),
                service: None,
                event_type_code: None,
                event_type_category: None,
                region: None,
                start_time: None,
                end_time: None,
                last_updated_time: None,
                status_code: None,
            })
            .collect())
    }
}

fn prompt_selection(summaries: &[EventSummary]) -> anyhow::Result<Vec<usize>> {
    let items: Vec<String> = summaries.iter().map(format_row).collect();
    let picked = dialoguer::MultiSelect::new()
        .with_prompt("Select events to send (space to toggle, enter to confirm)")
        .items(&items)
        .interact()
        .context("multi-select prompt")?;
    Ok(picked)
}

fn format_row(s: &EventSummary) -> String {
    let updated = s
        .last_updated_time
        .map_or_else(|| "?".to_string(), |t| t.to_rfc3339());
    format!(
        "{updated:<25}  {svc:<10}  {cat:<22}  {region:<16}  {code}",
        svc = s.service.as_deref().unwrap_or("?"),
        cat = s.event_type_category.as_deref().unwrap_or("?"),
        region = s.region.as_deref().unwrap_or("?"),
        code = s.event_type_code.as_deref().unwrap_or(&s.arn),
    )
}
