//! Thin wrapper over the AWS Health SDK.
//!
//! Health API is global but the SDK still requires a region. We pin to
//! `us-east-1` (the active control-plane endpoint) regardless of where the
//! events themselves originate.

use std::collections::HashSet;

use anyhow::Context;
use aws_sdk_health::Client;
use aws_sdk_health::types::{
    DateTimeRange, EventFilter as SdkEventFilter, EventStatusCode, EventTypeCategory,
    EventTypeFilter,
};
use aws_smithy_types::DateTime as SmithyDateTime;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use tracing::{debug, instrument};

use crate::health::{AffectedEntity, EventDescription, HealthDetail, HealthEvent};

const HEALTH_REGION: &str = "us-east-1";

#[derive(Clone)]
pub struct HealthClient {
    client: Client,
    locale: String,
}

#[derive(Debug, Clone)]
pub struct EventSummary {
    pub arn: String,
    pub service: Option<String>,
    pub event_type_code: Option<String>,
    pub event_type_category: Option<String>,
    pub region: Option<String>,
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    pub last_updated_time: Option<DateTime<Utc>>,
    pub status_code: Option<String>,
}

impl HealthClient {
    /// Test-only constructor: inject a pre-built SDK client (e.g. backed by a
    /// replay HTTP transport) instead of resolving config from the environment.
    #[cfg(test)]
    pub fn from_client(client: Client, locale: impl Into<String>) -> Self {
        Self {
            client,
            locale: locale.into(),
        }
    }

    pub async fn from_env(locale: impl Into<String>) -> anyhow::Result<Self> {
        let cfg = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(HEALTH_REGION))
            .load()
            .await;
        Ok(Self {
            client: Client::new(&cfg),
            locale: locale.into(),
        })
    }

    /// Fetch event summaries whose `lastUpdatedTime` falls in `[from, to)`,
    /// optionally narrowed by service and category lists.
    #[instrument(skip(self), fields(from = %from, to = %to))]
    pub async fn list_events(
        &self,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
        services: &[String],
        categories: &[String],
    ) -> anyhow::Result<Vec<EventSummary>> {
        let mut builder = SdkEventFilter::builder().last_updated_times(
            DateTimeRange::builder()
                .from(to_smithy(from))
                .to(to_smithy(to))
                .build(),
        );
        for s in services.iter().filter(|s| !s.is_empty()) {
            builder = builder.services(s.clone());
        }
        for c in categories.iter().filter(|c| !c.is_empty()) {
            builder = builder.event_type_categories(EventTypeCategory::from(c.as_str()));
        }
        // Only events that are open or upcoming — closed ones we already sent.
        let filter = builder
            .event_status_codes(EventStatusCode::Open)
            .event_status_codes(EventStatusCode::Upcoming)
            .build();

        let mut stream = self
            .client
            .describe_events()
            .filter(filter)
            .into_paginator()
            .items()
            .send();

        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            let event = item.context("describe_events page failed")?;
            out.push(EventSummary {
                arn: event.arn.unwrap_or_default(),
                service: event.service,
                event_type_code: event.event_type_code,
                event_type_category: event.event_type_category.map(|c| c.as_str().to_string()),
                region: event.region,
                start_time: event.start_time.and_then(from_smithy),
                end_time: event.end_time.and_then(from_smithy),
                last_updated_time: event.last_updated_time.and_then(from_smithy),
                status_code: event.status_code.map(|s| s.as_str().to_string()),
            });
        }
        debug!(count = out.len(), "fetched events");
        Ok(out)
    }

    /// Fetch upcoming events whose `startTime` falls inside `(now, now + horizon]`.
    /// Used by the reminder loop to find events approaching their scheduled start.
    #[instrument(skip(self), fields(horizon_hours = horizon.num_hours()))]
    pub async fn list_upcoming(
        &self,
        horizon: ChronoDuration,
        services: &[String],
        categories: &[String],
    ) -> anyhow::Result<Vec<EventSummary>> {
        let now = Utc::now();
        let to = now + horizon;
        let mut builder = SdkEventFilter::builder().start_times(
            DateTimeRange::builder()
                .from(to_smithy(now))
                .to(to_smithy(to))
                .build(),
        );
        for s in services.iter().filter(|s| !s.is_empty()) {
            builder = builder.services(s.clone());
        }
        for c in categories.iter().filter(|c| !c.is_empty()) {
            builder = builder.event_type_categories(EventTypeCategory::from(c.as_str()));
        }
        let filter = builder
            .event_status_codes(EventStatusCode::Upcoming)
            .build();

        let mut stream = self
            .client
            .describe_events()
            .filter(filter)
            .into_paginator()
            .items()
            .send();

        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            let event = item.context("describe_events (upcoming) page failed")?;
            out.push(EventSummary {
                arn: event.arn.unwrap_or_default(),
                service: event.service,
                event_type_code: event.event_type_code,
                event_type_category: event.event_type_category.map(|c| c.as_str().to_string()),
                region: event.region,
                start_time: event.start_time.and_then(from_smithy),
                end_time: event.end_time.and_then(from_smithy),
                last_updated_time: event.last_updated_time.and_then(from_smithy),
                status_code: event.status_code.map(|s| s.as_str().to_string()),
            });
        }
        debug!(count = out.len(), "fetched upcoming events");
        Ok(out)
    }

    /// Hydrate a summary into a full `HealthEvent` with description and affected entities.
    /// When the summary was built from an ARN only, the missing fields are
    /// filled from the `DescribeEventDetails` response.
    pub async fn hydrate(&self, summary: EventSummary) -> anyhow::Result<HealthEvent> {
        let details = self
            .client
            .describe_event_details()
            .event_arns(summary.arn.clone())
            .locale(self.locale.clone())
            .send()
            .await
            .context("describe_event_details")?;

        let successful = details.successful_set.unwrap_or_default();
        let api_event = successful.first().and_then(|d| d.event.clone());
        let description: Vec<EventDescription> = successful
            .into_iter()
            .filter_map(|d| d.event_description)
            .map(|d| EventDescription {
                language: Some(self.locale.clone()),
                latest_description: d.latest_description,
            })
            .collect();

        let entities = self.list_affected(&summary.arn).await.unwrap_or_else(|e| {
            tracing::warn!(arn = %summary.arn, error = %e, "failed to fetch affected entities");
            Vec::new()
        });

        let service = summary
            .service
            .or_else(|| api_event.as_ref().and_then(|e| e.service.clone()));
        let event_type_code = summary
            .event_type_code
            .or_else(|| api_event.as_ref().and_then(|e| e.event_type_code.clone()));
        let event_type_category = summary.event_type_category.or_else(|| {
            api_event.as_ref().and_then(|e| {
                e.event_type_category
                    .as_ref()
                    .map(|c| c.as_str().to_string())
            })
        });
        let region = summary
            .region
            .or_else(|| api_event.as_ref().and_then(|e| e.region.clone()));
        let start_time = summary.start_time.map(fmt_rfc3339).or_else(|| {
            api_event
                .as_ref()
                .and_then(|e| e.start_time)
                .and_then(from_smithy)
                .map(fmt_rfc3339)
        });
        let end_time = summary.end_time.map(fmt_rfc3339).or_else(|| {
            api_event
                .as_ref()
                .and_then(|e| e.end_time)
                .and_then(from_smithy)
                .map(fmt_rfc3339)
        });
        let last_updated_time = summary.last_updated_time.map(fmt_rfc3339).or_else(|| {
            api_event
                .as_ref()
                .and_then(|e| e.last_updated_time)
                .and_then(from_smithy)
                .map(fmt_rfc3339)
        });
        let status_code = summary.status_code.or_else(|| {
            api_event
                .as_ref()
                .and_then(|e| e.status_code.as_ref().map(|s| s.as_str().to_string()))
        });

        Ok(HealthEvent {
            account: None,
            region,
            detail: HealthDetail {
                event_arn: Some(summary.arn),
                service,
                event_type_code,
                event_type_category,
                start_time,
                end_time,
                last_updated_time,
                status_code,
                event_description: description,
                affected_entities: entities,
            },
        })
    }

    /// Look up which of the given service codes exist in the AWS Health catalog.
    /// Returns the subset (with AWS's canonical casing) that matched. Used at
    /// startup to validate the configured allow/deny service lists without
    /// paginating the full catalog of thousands of event types.
    pub async fn lookup_service_codes(
        &self,
        services: &[String],
    ) -> anyhow::Result<HashSet<String>> {
        if services.is_empty() {
            return Ok(HashSet::new());
        }
        let mut builder = EventTypeFilter::builder();
        for s in services.iter().filter(|s| !s.is_empty()) {
            builder = builder.services(s.clone());
        }
        let mut stream = self
            .client
            .describe_event_types()
            .filter(builder.build())
            .into_paginator()
            .items()
            .send();

        let mut out = HashSet::new();
        while let Some(item) = stream.next().await {
            let et = item.context("describe_event_types page failed")?;
            if let Some(service) = et.service {
                out.insert(service);
            }
        }
        debug!(
            queried = services.len(),
            matched = out.len(),
            "looked up service codes"
        );
        Ok(out)
    }

    /// Look up which of the given `eventTypeCode` values exist in the AWS
    /// Health catalog. Returns the matching entries as canonical
    /// `SERVICE/EVENT_TYPE_CODE` pairs so callers can validate that a
    /// configured code actually belongs to the service it was written under.
    pub async fn lookup_event_type_codes(
        &self,
        codes: &[String],
    ) -> anyhow::Result<HashSet<String>> {
        if codes.is_empty() {
            return Ok(HashSet::new());
        }
        let mut builder = EventTypeFilter::builder();
        for c in codes.iter().filter(|c| !c.is_empty()) {
            builder = builder.event_type_codes(c.clone());
        }
        let mut stream = self
            .client
            .describe_event_types()
            .filter(builder.build())
            .into_paginator()
            .items()
            .send();

        let mut out = HashSet::new();
        while let Some(item) = stream.next().await {
            let et = item.context("describe_event_types page failed")?;
            if let (Some(service), Some(code)) = (et.service, et.code) {
                out.insert(format!("{service}/{code}"));
            }
        }
        debug!(
            queried = codes.len(),
            matched = out.len(),
            "looked up event type codes"
        );
        Ok(out)
    }

    async fn list_affected(&self, arn: &str) -> anyhow::Result<Vec<AffectedEntity>> {
        let filter = aws_sdk_health::types::EntityFilter::builder()
            .event_arns(arn.to_string())
            .build()
            .context("entity filter build")?;
        let mut stream = self
            .client
            .describe_affected_entities()
            .filter(filter)
            .into_paginator()
            .items()
            .send();
        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            let e = item.context("describe_affected_entities page failed")?;
            out.push(AffectedEntity {
                entity_value: e.entity_value,
                status: e.status_code.map(|s| s.as_str().to_string()),
            });
        }
        Ok(out)
    }
}

fn to_smithy(dt: DateTime<Utc>) -> SmithyDateTime {
    SmithyDateTime::from_secs(dt.timestamp())
}

fn from_smithy(dt: SmithyDateTime) -> Option<DateTime<Utc>> {
    DateTime::<Utc>::from_timestamp(dt.secs(), 0)
}

fn fmt_rfc3339(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339()
}

#[cfg(test)]
pub mod test_support {
    use aws_sdk_health::Client;
    use aws_sdk_health::config::{BehaviorVersion, Credentials, Region};
    use aws_smithy_runtime::client::http::test_util::{ReplayEvent, StaticReplayClient};
    use aws_smithy_types::body::SdkBody;

    /// Build a Health SDK `Client` that replays the given JSON response bodies
    /// in order, one per HTTP request the SDK makes. Each body is returned with
    /// HTTP 200 and the awsJson1.1 content type.
    pub fn replay_client(bodies: Vec<String>) -> (Client, StaticReplayClient) {
        let events = bodies
            .into_iter()
            .map(|body| {
                ReplayEvent::new(
                    http::Request::builder()
                        .uri("https://health.us-east-1.amazonaws.com/")
                        .body(SdkBody::empty())
                        .unwrap(),
                    http::Response::builder()
                        .status(200)
                        .header("content-type", "application/x-amz-json-1.1")
                        .body(SdkBody::from(body))
                        .unwrap(),
                )
            })
            .collect();
        let http_client = StaticReplayClient::new(events);
        let conf = aws_sdk_health::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::for_tests())
            .http_client(http_client.clone())
            .build();
        (Client::from_conf(conf), http_client)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::replay_client;
    use super::*;

    #[tokio::test]
    async fn list_events_maps_summaries() {
        let body = r#"{"events":[{"arn":"arn:1","service":"EC2","eventTypeCode":"AWS_EC2_X","eventTypeCategory":"issue","region":"us-east-1","startTime":1.7e9,"endTime":1.71e9,"lastUpdatedTime":1.72e9,"statusCode":"open"}]}"#;
        let (client, _h) = replay_client(vec![body.into()]);
        let hc = HealthClient::from_client(client, "en");
        let out = hc
            .list_events(Utc::now() - ChronoDuration::hours(1), Utc::now(), &[], &[])
            .await
            .unwrap();
        assert_eq!(out.len(), 1);
        let e = &out[0];
        assert_eq!(e.arn, "arn:1");
        assert_eq!(e.service.as_deref(), Some("EC2"));
        assert_eq!(e.event_type_category.as_deref(), Some("issue"));
        assert_eq!(e.status_code.as_deref(), Some("open"));
        assert!(e.start_time.is_some());
    }

    #[tokio::test]
    async fn list_events_with_filters_returns_empty() {
        let (client, _h) = replay_client(vec![r#"{"events":[]}"#.into()]);
        let hc = HealthClient::from_client(client, "en");
        let out = hc
            .list_events(
                Utc::now() - ChronoDuration::hours(1),
                Utc::now(),
                &["EC2".into(), String::new()],
                &["issue".into(), String::new()],
            )
            .await
            .unwrap();
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn list_upcoming_maps_summaries() {
        let body = r#"{"events":[{"arn":"arn:2","service":"RDS","eventTypeCode":"AWS_RDS_X","eventTypeCategory":"scheduledChange","region":"us-west-2","startTime":1.8e9,"endTime":1.81e9,"lastUpdatedTime":1.79e9,"statusCode":"upcoming"}]}"#;
        let (client, _h) = replay_client(vec![body.into()]);
        let hc = HealthClient::from_client(client, "en");
        let out = hc
            .list_upcoming(ChronoDuration::hours(24), &["RDS".into()], &[])
            .await
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].arn, "arn:2");
        assert_eq!(out[0].status_code.as_deref(), Some("upcoming"));
    }

    #[tokio::test]
    async fn hydrate_fills_details_and_entities() {
        let details = r#"{"successfulSet":[{"event":{"arn":"arn:1","service":"EC2","eventTypeCode":"AWS_EC2_X","eventTypeCategory":"issue","region":"us-east-1","startTime":1.7e9,"endTime":1.71e9,"lastUpdatedTime":1.72e9,"statusCode":"open"},"eventDescription":{"latestDescription":"hello"}}],"failedSet":[]}"#;
        let entities = r#"{"entities":[{"entityValue":"i-123","statusCode":"IMPAIRED"}]}"#;
        let (client, _h) = replay_client(vec![details.into(), entities.into()]);
        let hc = HealthClient::from_client(client, "en");
        let summary = EventSummary {
            arn: "arn:1".into(),
            service: None,
            event_type_code: None,
            event_type_category: None,
            region: None,
            start_time: None,
            end_time: None,
            last_updated_time: None,
            status_code: None,
        };
        let event = hc.hydrate(summary).await.unwrap();
        assert_eq!(event.detail.service.as_deref(), Some("EC2"));
        assert_eq!(event.detail.event_type_category.as_deref(), Some("issue"));
        assert_eq!(event.detail.description(), Some("hello"));
        assert_eq!(event.detail.affected_entities.len(), 1);
        assert_eq!(
            event.detail.affected_entities[0].entity_value.as_deref(),
            Some("i-123")
        );
        assert!(event.detail.start_time.is_some());
    }

    #[tokio::test]
    async fn hydrate_prefers_summary_fields() {
        let details = r#"{"successfulSet":[{"event":{"arn":"arn:1","service":"RDS"},"eventDescription":{"latestDescription":"d"}}],"failedSet":[]}"#;
        let entities = r#"{"entities":[]}"#;
        let (client, _h) = replay_client(vec![details.into(), entities.into()]);
        let hc = HealthClient::from_client(client, "en");
        let summary = EventSummary {
            arn: "arn:1".into(),
            service: Some("EC2".into()),
            event_type_code: Some("CODE".into()),
            event_type_category: Some("issue".into()),
            region: Some("us-east-1".into()),
            start_time: Some(Utc::now()),
            end_time: None,
            last_updated_time: None,
            status_code: Some("open".into()),
        };
        let event = hc.hydrate(summary).await.unwrap();
        // Summary value wins over the API event's "RDS".
        assert_eq!(event.detail.service.as_deref(), Some("EC2"));
        assert_eq!(event.detail.status_code.as_deref(), Some("open"));
    }

    #[tokio::test]
    async fn lookup_service_codes_collects_matches() {
        let body = r#"{"eventTypes":[{"service":"EC2"},{"service":"RDS"}]}"#;
        let (client, _h) = replay_client(vec![body.into()]);
        let hc = HealthClient::from_client(client, "en");
        let out = hc
            .lookup_service_codes(&["EC2".into(), "RDS".into()])
            .await
            .unwrap();
        assert!(out.contains("EC2"));
        assert!(out.contains("RDS"));
    }

    #[tokio::test]
    async fn lookup_event_type_codes_collects_service_code_pairs() {
        let body = r#"{"eventTypes":[{"service":"VPN","code":"AWS_VPN_REDUNDANCY_LOSS"}]}"#;
        let (client, _h) = replay_client(vec![body.into()]);
        let hc = HealthClient::from_client(client, "en");
        let out = hc
            .lookup_event_type_codes(&["AWS_VPN_REDUNDANCY_LOSS".into()])
            .await
            .unwrap();
        assert!(out.contains("VPN/AWS_VPN_REDUNDANCY_LOSS"));
    }

    #[tokio::test]
    async fn lookup_event_type_codes_empty_input_skips_call() {
        let (client, _h) = replay_client(vec![]);
        let hc = HealthClient::from_client(client, "en");
        let out = hc.lookup_event_type_codes(&[]).await.unwrap();
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn lookup_service_codes_empty_input_skips_call() {
        // No replay events provided: an empty input must not make any request.
        let (client, _h) = replay_client(vec![]);
        let hc = HealthClient::from_client(client, "en");
        let out = hc.lookup_service_codes(&[]).await.unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn time_helpers_round_trip() {
        let now = Utc::now();
        let smithy = to_smithy(now);
        let back = from_smithy(smithy).unwrap();
        assert_eq!(back.timestamp(), now.timestamp());
        assert!(fmt_rfc3339(now).contains('T'));
    }
}
