//! Periodic AWS Health API poller.
//!
//! Two concurrent responsibilities run in the same cycle:
//!
//! 1. **Notifications** — events whose `lastUpdatedTime` advanced since the
//!    previous poll get forwarded once per state change.
//! 2. **Reminders** — for every `reminder_offset_hours` value, we re-check
//!    upcoming events; when `startTime - now <= offset` and we haven't fired
//!    that `(arn, offset)` pair yet, we post a reminder message.
//!
//! ## Cold start
//!
//! With `cold_start_suppress = true` (default) the first poll only seeds
//! the dedup + reminder trackers — no Slack messages are sent. This prevents
//! a replay storm every time the pod restarts.

use std::time::Duration;

use chrono::{Duration as ChronoDuration, Utc};
use tokio::sync::Mutex;
use tokio::time::{MissedTickBehavior, interval};
use tracing::{error, info, instrument, warn};

use crate::aws::health::{EventSummary, HealthClient};
use crate::dedup::{Dedup, ReminderTracker};
use crate::filter::EventFilter;
use crate::notify::Notifier;
use crate::observability::metrics::Metrics;

const PRUNE_AFTER_HOURS: i64 = 72;

pub struct PollerCfg {
    pub interval: Duration,
    pub initial_lookback: Duration,
    pub cold_start_suppress: bool,
    pub services: Vec<String>,
    pub categories: Vec<String>,
    /// Reminder offsets in hours before `startTime`. Empty disables.
    pub reminder_offsets_hours: Vec<u32>,
}

pub struct Poller {
    aws: HealthClient,
    notifier: Notifier,
    filter: EventFilter,
    metrics: Metrics,
    dedup: Mutex<Dedup>,
    reminders: Mutex<ReminderTracker>,
    cfg: PollerCfg,
}

impl Poller {
    pub fn new(
        aws: HealthClient,
        notifier: Notifier,
        filter: EventFilter,
        metrics: Metrics,
        cfg: PollerCfg,
    ) -> Self {
        Self {
            aws,
            notifier,
            filter,
            metrics,
            dedup: Mutex::new(Dedup::new()),
            reminders: Mutex::new(ReminderTracker::new()),
            cfg,
        }
    }

    pub async fn run(
        &self,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> anyhow::Result<()> {
        let mut ticker = interval(self.cfg.interval);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

        let mut cursor =
            Utc::now() - ChronoDuration::from_std(self.cfg.initial_lookback).unwrap_or_default();
        let mut first_run = true;

        info!(
            interval_secs = self.cfg.interval.as_secs(),
            initial_lookback_secs = self.cfg.initial_lookback.as_secs(),
            cold_start_suppress = self.cfg.cold_start_suppress,
            reminder_offsets_hours = ?self.cfg.reminder_offsets_hours,
            "poller started"
        );

        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = shutdown.changed() => {
                    info!("poller shutting down");
                    return Ok(());
                }
            }

            let to = Utc::now();
            let suppress = first_run && self.cfg.cold_start_suppress;
            let result = async {
                self.poll_once(cursor, to, suppress).await?;
                if !self.cfg.reminder_offsets_hours.is_empty() {
                    self.poll_reminders(suppress).await?;
                }
                Ok::<(), anyhow::Error>(())
            }
            .await;

            if let Err(e) = result {
                error!(error = %e, "poll cycle failed");
                self.metrics.record_poll("error");
            } else {
                self.metrics.record_poll("ok");
            }
            cursor = to;
            first_run = false;
            let dedup_size = {
                let mut d = self.dedup.lock().await;
                d.prune_older_than(ChronoDuration::hours(PRUNE_AFTER_HOURS));
                d.len()
            };
            tracing::debug!(dedup_size, "dedup state after cycle");
        }
    }

    #[instrument(skip(self), fields(from = %from, to = %to, suppress))]
    async fn poll_once(
        &self,
        from: chrono::DateTime<Utc>,
        to: chrono::DateTime<Utc>,
        suppress: bool,
    ) -> anyhow::Result<()> {
        let summaries = self
            .aws
            .list_events(from, to, &self.cfg.services, &self.cfg.categories)
            .await?;

        info!(
            fetched = summaries.len(),
            suppress, "received event summaries"
        );

        for summary in summaries {
            let arn = summary.arn.clone();
            let last_updated = summary.last_updated_time;

            self.metrics.record_event(
                summary.service.as_deref().unwrap_or("unknown"),
                summary.event_type_category.as_deref().unwrap_or("unknown"),
                summary.region.as_deref().unwrap_or("unknown"),
            );

            {
                let dedup = self.dedup.lock().await;
                if !dedup.should_process(&arn, last_updated) {
                    continue;
                }
            }

            if suppress {
                self.dedup.lock().await.mark_processed(arn, last_updated);
                self.metrics.record_filtered("cold_start_suppressed");
                continue;
            }

            let event = match self.aws.hydrate(summary).await {
                Ok(e) => e,
                Err(e) => {
                    warn!(arn = %arn, error = %e, "failed to hydrate event details");
                    continue;
                }
            };

            let decision = self.filter.evaluate(&event);
            if !decision.is_allowed() {
                self.metrics.record_filtered(decision.reason());
                self.dedup.lock().await.mark_processed(arn, last_updated);
                continue;
            }

            match self.notifier.publish(&event, None).await {
                Ok(()) => {
                    self.dedup
                        .lock()
                        .await
                        .mark_processed(arn.clone(), last_updated);
                    info!(arn = %arn, "forwarded event");
                }
                Err(e) => {
                    warn!(arn = %arn, error = %e, "publish failed; will retry next cycle");
                }
            }
        }
        Ok(())
    }

    /// Re-fetch upcoming events and fire one reminder per `(arn, offset_hours)`
    /// pair as soon as `startTime - now <= offset`.
    async fn poll_reminders(&self, suppress: bool) -> anyhow::Result<()> {
        let max_offset = self
            .cfg
            .reminder_offsets_hours
            .iter()
            .max()
            .copied()
            .unwrap_or(0);
        if max_offset == 0 {
            return Ok(());
        }
        let horizon = ChronoDuration::hours(i64::from(max_offset));
        let summaries = self
            .aws
            .list_upcoming(horizon, &self.cfg.services, &self.cfg.categories)
            .await?;

        info!(
            fetched = summaries.len(),
            max_offset_hours = max_offset,
            "received upcoming-event summaries for reminder evaluation"
        );

        let now = Utc::now();
        let live_arns: std::collections::HashSet<String> =
            summaries.iter().map(|s| s.arn.clone()).collect();
        for summary in summaries {
            self.evaluate_reminder(summary, now, suppress).await;
        }
        // Drop reminder records for events that are no longer in the upcoming
        // window (already started / closed) — they can never fire again.
        self.reminders
            .lock()
            .await
            .retain_relevant(|arn| live_arns.contains(arn));
        Ok(())
    }

    async fn evaluate_reminder(
        &self,
        summary: EventSummary,
        now: chrono::DateTime<Utc>,
        suppress: bool,
    ) {
        let Some(start) = summary.start_time else {
            return;
        };
        // Only remind for events with a bounded maintenance window — i.e.,
        // `endTime` set. Open-ended issues without endTime fall through.
        if summary.end_time.is_none() {
            return;
        }
        let until_start = start.signed_duration_since(now);
        if until_start <= ChronoDuration::zero() {
            return;
        }
        let arn = summary.arn.clone();

        for &offset_h in &self.cfg.reminder_offsets_hours {
            if until_start > ChronoDuration::hours(i64::from(offset_h)) {
                continue;
            }
            let should_fire = self.reminders.lock().await.should_fire(&arn, offset_h);
            if !should_fire {
                continue;
            }
            if suppress {
                self.reminders
                    .lock()
                    .await
                    .mark_fired(arn.clone(), offset_h);
                continue;
            }
            if !self.filter.evaluate(&minimal_event(&summary)).is_allowed() {
                self.reminders
                    .lock()
                    .await
                    .mark_fired(arn.clone(), offset_h);
                continue;
            }
            let event = match self.aws.hydrate(summary.clone()).await {
                Ok(e) => e,
                Err(e) => {
                    warn!(arn = %arn, error = %e, "reminder hydrate failed");
                    return;
                }
            };
            match self.notifier.publish(&event, Some(offset_h)).await {
                Ok(()) => {
                    self.metrics.record_reminder(offset_h);
                    self.reminders
                        .lock()
                        .await
                        .mark_fired(arn.clone(), offset_h);
                    info!(arn = %arn, offset_hours = offset_h, "fired reminder");
                }
                Err(e) => {
                    warn!(arn = %arn, offset_hours = offset_h, error = %e, "reminder publish failed");
                }
            }
        }
    }
}

/// Build a minimal `HealthEvent` from a summary for filter evaluation only —
/// avoids a second API call before we know the event passes the filter.
fn minimal_event(s: &EventSummary) -> crate::health::HealthEvent {
    crate::health::HealthEvent {
        account: None,
        region: s.region.clone(),
        detail: crate::health::HealthDetail {
            event_arn: Some(s.arn.clone()),
            service: s.service.clone(),
            event_type_code: s.event_type_code.clone(),
            event_type_category: s.event_type_category.clone(),
            start_time: None,
            end_time: None,
            last_updated_time: None,
            status_code: s.status_code.clone(),
            event_description: vec![],
            affected_entities: vec![],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary() -> EventSummary {
        EventSummary {
            arn: "arn:1".into(),
            service: Some("EC2".into()),
            event_type_code: Some("CODE".into()),
            event_type_category: Some("issue".into()),
            region: Some("us-east-1".into()),
            start_time: None,
            end_time: None,
            last_updated_time: None,
            status_code: Some("open".into()),
        }
    }

    #[test]
    fn minimal_event_copies_summary_fields() {
        let e = minimal_event(&summary());
        assert_eq!(e.region.as_deref(), Some("us-east-1"));
        assert_eq!(e.detail.event_arn.as_deref(), Some("arn:1"));
        assert_eq!(e.detail.service.as_deref(), Some("EC2"));
        assert_eq!(e.detail.event_type_category.as_deref(), Some("issue"));
        assert_eq!(e.detail.status_code.as_deref(), Some("open"));
        assert!(e.detail.affected_entities.is_empty());
        assert!(e.detail.event_description.is_empty());
        assert!(e.detail.start_time.is_none());
    }

    #[test]
    fn minimal_event_is_filterable() {
        let f = EventFilter::new(&[], &[], &["EC2".into()], &[], &[], &[]);
        assert!(f.evaluate(&minimal_event(&summary())).is_allowed());
    }

    #[test]
    fn minimal_event_carries_event_code_for_filtering() {
        let f = EventFilter::new(&[], &[], &[], &[], &[], &["EC2/CODE".into()]);
        assert!(!f.evaluate(&minimal_event(&summary())).is_allowed());
    }

    mod cycle {
        use std::time::Duration as StdDuration;

        use secrecy::SecretString;
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        use super::super::*;
        use crate::aws::health::test_support::replay_client;
        use crate::notify::{Notifier, SlackOpts};
        use crate::slack::client::SlackClient;

        const LIST_ONE: &str = r#"{"events":[{"arn":"arn:1","service":"EC2","eventTypeCode":"AWS_EC2_X","eventTypeCategory":"issue","region":"us-east-1","startTime":1.7e9,"endTime":1.71e9,"lastUpdatedTime":1.72e9,"statusCode":"open"}]}"#;
        const DETAILS: &str = r#"{"successfulSet":[{"event":{"arn":"arn:1","service":"EC2","eventTypeCode":"AWS_EC2_X","eventTypeCategory":"issue","region":"us-east-1","statusCode":"open"},"eventDescription":{"latestDescription":"hello"}}],"failedSet":[]}"#;
        const ENTITIES: &str = r#"{"entities":[{"entityValue":"i-1","statusCode":"IMPAIRED"}]}"#;

        async fn slack_ok() -> MockServer {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(200))
                .mount(&server)
                .await;
            server
        }

        fn poller(aws: HealthClient, slack_url: &str, cfg: PollerCfg) -> Poller {
            let metrics = Metrics::new();
            let slack = SlackClient::new(
                SecretString::from(slack_url.to_string()),
                StdDuration::from_secs(5),
            )
            .unwrap();
            let notifier = Notifier::new(
                slack,
                SlackOpts {
                    channel: None,
                    username: "bot".into(),
                    icon_emoji: ":cloud:".into(),
                    account_label: None,
                },
                None,
                metrics.clone(),
            );
            Poller::new(aws, notifier, EventFilter::default(), metrics, cfg)
        }

        fn cfg(reminder_offsets_hours: Vec<u32>) -> PollerCfg {
            PollerCfg {
                interval: StdDuration::from_mins(1),
                initial_lookback: StdDuration::from_hours(1),
                cold_start_suppress: false,
                services: vec![],
                categories: vec![],
                reminder_offsets_hours,
            }
        }

        #[tokio::test]
        async fn poll_once_hydrates_and_publishes() {
            let server = slack_ok().await;
            let (client, _h) =
                replay_client(vec![LIST_ONE.into(), DETAILS.into(), ENTITIES.into()]);
            let p = poller(
                HealthClient::from_client(client, "en"),
                &server.uri(),
                cfg(vec![]),
            );
            p.poll_once(Utc::now() - ChronoDuration::hours(1), Utc::now(), false)
                .await
                .unwrap();
            // ARN recorded in dedup → second pass with same timestamp is skipped.
            assert_eq!(p.dedup.lock().await.len(), 1);
        }

        #[tokio::test]
        async fn poll_once_suppress_only_seeds_dedup() {
            let (client, _h) = replay_client(vec![LIST_ONE.into()]);
            // No slack server needed: suppress must not publish.
            let p = poller(
                HealthClient::from_client(client, "en"),
                "http://127.0.0.1:1",
                cfg(vec![]),
            );
            p.poll_once(Utc::now() - ChronoDuration::hours(1), Utc::now(), true)
                .await
                .unwrap();
            assert_eq!(p.dedup.lock().await.len(), 1);
        }

        #[tokio::test]
        async fn poll_once_filtered_event_is_marked_not_published() {
            let (client, _h) =
                replay_client(vec![LIST_ONE.into(), DETAILS.into(), ENTITIES.into()]);
            let metrics = Metrics::new();
            let slack = SlackClient::new(
                SecretString::from("http://127.0.0.1:1".to_string()),
                StdDuration::from_secs(5),
            )
            .unwrap();
            let notifier = Notifier::new(
                slack,
                SlackOpts {
                    channel: None,
                    username: "b".into(),
                    icon_emoji: ":x:".into(),
                    account_label: None,
                },
                None,
                metrics.clone(),
            );
            // Deny the EC2 service so the hydrated event is dropped before publish.
            let filter = EventFilter::new(&[], &[], &[], &["EC2".into()], &[], &[]);
            let p = Poller::new(
                HealthClient::from_client(client, "en"),
                notifier,
                filter,
                metrics,
                cfg(vec![]),
            );
            p.poll_once(Utc::now() - ChronoDuration::hours(1), Utc::now(), false)
                .await
                .unwrap();
            assert_eq!(p.dedup.lock().await.len(), 1);
        }

        #[tokio::test]
        async fn poll_reminders_fires_for_upcoming_event() {
            let now = Utc::now();
            let start = (now + ChronoDuration::hours(1)).timestamp();
            let end = start + 3600;
            let list = format!(
                r#"{{"events":[{{"arn":"arn:r","service":"EC2","eventTypeCode":"AWS_EC2_X","eventTypeCategory":"scheduledChange","region":"us-east-1","startTime":{start}.0,"endTime":{end}.0,"lastUpdatedTime":{start}.0,"statusCode":"upcoming"}}]}}"#
            );
            let server = slack_ok().await;
            let (client, _h) = replay_client(vec![list, DETAILS.into(), ENTITIES.into()]);
            let p = poller(
                HealthClient::from_client(client, "en"),
                &server.uri(),
                cfg(vec![24]),
            );
            p.poll_reminders(false).await.unwrap();
            // Reminder fired and recorded so it won't fire again.
            assert!(!p.reminders.lock().await.should_fire("arn:r", 24));
        }

        #[tokio::test]
        async fn poll_reminders_suppress_marks_without_publish() {
            let now = Utc::now();
            let start = (now + ChronoDuration::hours(1)).timestamp();
            let end = start + 3600;
            let list = format!(
                r#"{{"events":[{{"arn":"arn:r","service":"EC2","eventTypeCode":"AWS_EC2_X","eventTypeCategory":"scheduledChange","region":"us-east-1","startTime":{start}.0,"endTime":{end}.0,"lastUpdatedTime":{start}.0,"statusCode":"upcoming"}}]}}"#
            );
            let (client, _h) = replay_client(vec![list]);
            let p = poller(
                HealthClient::from_client(client, "en"),
                "http://127.0.0.1:1",
                cfg(vec![24]),
            );
            p.poll_reminders(true).await.unwrap();
            assert!(!p.reminders.lock().await.should_fire("arn:r", 24));
        }

        #[tokio::test]
        async fn poll_reminders_skips_event_without_end_time() {
            let now = Utc::now();
            let start = (now + ChronoDuration::hours(1)).timestamp();
            let list = format!(
                r#"{{"events":[{{"arn":"arn:r","service":"EC2","eventTypeCode":"AWS_EC2_X","eventTypeCategory":"scheduledChange","region":"us-east-1","startTime":{start}.0,"lastUpdatedTime":{start}.0,"statusCode":"upcoming"}}]}}"#
            );
            let (client, _h) = replay_client(vec![list]);
            let p = poller(
                HealthClient::from_client(client, "en"),
                "http://127.0.0.1:1",
                cfg(vec![24]),
            );
            p.poll_reminders(false).await.unwrap();
            // No end_time → never fires; record absent.
            assert!(p.reminders.lock().await.should_fire("arn:r", 24));
        }

        #[tokio::test]
        async fn poll_reminders_empty_offsets_is_noop() {
            let (client, _h) = replay_client(vec![]);
            let p = poller(
                HealthClient::from_client(client, "en"),
                "http://127.0.0.1:1",
                cfg(vec![]),
            );
            p.poll_reminders(false).await.unwrap();
        }
    }
}
