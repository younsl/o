//! In-memory dedup for events already forwarded to Slack.
//!
//! Keyed by `eventArn`; the value is the latest `lastUpdatedTime` we have
//! posted. An event is re-posted when its `lastUpdatedTime` advances
//! (e.g., status transition `upcoming → open → closed`).
//!
//! State is intentionally in-memory: on pod restart the lookback window
//! covers any events that updated while we were offline.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration as ChronoDuration, Utc};

#[derive(Debug, Default)]
pub struct Dedup {
    seen: HashMap<String, DateTime<Utc>>,
}

impl Dedup {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns true if the `(arn, last_updated)` pair is new or strictly newer
    /// than what we already saw. `None` `last_updated` is treated as always-new.
    pub fn should_process(&self, arn: &str, last_updated: Option<DateTime<Utc>>) -> bool {
        match (self.seen.get(arn), last_updated) {
            (None, _) | (Some(_), None) => true,
            (Some(prev), Some(curr)) => curr > *prev,
        }
    }

    pub fn mark_processed(&mut self, arn: String, last_updated: Option<DateTime<Utc>>) {
        let stamp = last_updated.unwrap_or_else(Utc::now);
        self.seen.insert(arn, stamp);
    }

    /// Drop entries older than the cutoff to bound memory growth.
    pub fn prune_older_than(&mut self, ttl: ChronoDuration) {
        let cutoff = Utc::now() - ttl;
        self.seen.retain(|_, t| *t >= cutoff);
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }
}

/// Tracks which `(eventArn, offset_hours)` reminder pairs have already fired.
/// Reset on pod restart; `cold_start_suppress` covers replay protection.
#[derive(Debug, Default)]
pub struct ReminderTracker {
    fired: HashSet<(String, u32)>,
}

impl ReminderTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn should_fire(&self, arn: &str, offset_hours: u32) -> bool {
        !self.fired.contains(&(arn.to_string(), offset_hours))
    }

    pub fn mark_fired(&mut self, arn: String, offset_hours: u32) {
        self.fired.insert((arn, offset_hours));
    }

    /// Keep only entries whose `arn` is in `still_relevant`. The poller
    /// uses this to drop reminders for events that have already started.
    pub fn retain_relevant<F: FnMut(&str) -> bool>(&mut self, mut still_relevant: F) {
        self.fired.retain(|(arn, _)| still_relevant(arn));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_arn_always_processed() {
        let d = Dedup::new();
        assert!(d.should_process("arn:1", Some(Utc::now())));
    }

    #[test]
    fn same_timestamp_skipped() {
        let mut d = Dedup::new();
        let t = Utc::now();
        d.mark_processed("arn:1".into(), Some(t));
        assert!(!d.should_process("arn:1", Some(t)));
    }

    #[test]
    fn newer_timestamp_processed() {
        let mut d = Dedup::new();
        let t = Utc::now();
        d.mark_processed("arn:1".into(), Some(t));
        assert!(d.should_process("arn:1", Some(t + ChronoDuration::seconds(1))));
    }

    #[test]
    fn prune_drops_stale() {
        let mut d = Dedup::new();
        let old = Utc::now() - ChronoDuration::hours(24);
        d.mark_processed("arn:old".into(), Some(old));
        d.mark_processed("arn:new".into(), Some(Utc::now()));
        d.prune_older_than(ChronoDuration::hours(1));
        assert_eq!(d.len(), 1);
        assert!(d.should_process("arn:old", Some(old)));
    }

    #[test]
    fn mark_processed_none_uses_now_and_blocks_repost() {
        let mut d = Dedup::new();
        d.mark_processed("arn:1".into(), None);
        // A subsequent poll with an older explicit timestamp should be skipped.
        let past = Utc::now() - ChronoDuration::hours(1);
        assert!(!d.should_process("arn:1", Some(past)));
    }

    #[test]
    fn reminder_tracker_fires_once_per_pair() {
        let mut r = ReminderTracker::new();
        assert!(r.should_fire("arn:1", 24));
        r.mark_fired("arn:1".into(), 24);
        assert!(!r.should_fire("arn:1", 24));
        // Different offset still fires.
        assert!(r.should_fire("arn:1", 6));
    }

    #[test]
    fn reminder_tracker_retain_relevant_drops_others() {
        let mut r = ReminderTracker::new();
        r.mark_fired("arn:keep".into(), 24);
        r.mark_fired("arn:drop".into(), 24);
        r.retain_relevant(|arn| arn == "arn:keep");
        assert!(!r.should_fire("arn:keep", 24));
        assert!(r.should_fire("arn:drop", 24));
    }
}
