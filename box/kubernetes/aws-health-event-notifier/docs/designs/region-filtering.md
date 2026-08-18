# Region filtering

Status: implemented in 0.3.0.

## Summary

Add `allowRegions` / `denyRegions` to the event filter so an operator can drop
AWS Health events whose `region` is outside the regions the account actually
runs in. Today the filter matches on category, service, and
`SERVICE/EVENT_TYPE_CODE` only, so an event that concerns a region we do not
use can be silenced only by denying its event type code in every region, or its
service outright.

The concrete case that motivated this: `AWS_DIRECTCONNECT_OPERATIONAL_ISSUE`
for the Equinix FR5, Frankfurt location fired repeatedly in `eu-central-1`.
The account has no workload there, but the only way to stop the alarm was
`denyEventCodes: [DIRECTCONNECT/AWS_DIRECTCONNECT_OPERATIONAL_ISSUE]`, which
also silences the same event in `ap-northeast-2`, where a Direct Connect
outage is a real incident.

## Goals

- Drop events by region with the same allow/deny semantics the other filter
  lists already use: empty allow means allow everything, deny wins over allow.
- Never lose an event because its region is unknown. An event with no region
  must not be dropped by an allow list.
- Keep global-scope events (`region: global`) reachable without forcing every
  operator to remember to list `global`.
- Validate configured regions at startup, consistent with how unknown service
  codes and event type codes abort startup today.

## Non-goals

- Pushing the allow list to the AWS Health API as a server-side `regions`
  narrowing. Deferred, see [Server-side narrowing](#server-side-narrowing).
- Filtering by affected entity region or by resource ARN. The filter stays at
  event granularity, matching `DescribeEvents`.
- Per-region routing, such as sending `eu-central-1` events to a different
  Slack channel. This design only drops.
- Deriving the allowed regions automatically from what the account uses. The
  operator declares them.

## Background

### Current filter

`src/filter.rs` holds six lists and nothing else:

```
allow_categories  deny_categories
allow_services    deny_services
allow_event_codes deny_event_codes
```

`EventFilter::evaluate` reads exactly three fields off the event:
`detail.event_type_category`, `detail.service`, `detail.event_type_code`.
Order is deny-category, deny-service, deny-event-code, then the three allow
checks. The outcome is a `FilterDecision`, whose `reason()` string becomes the
`reason` label on `aws_health_event_filtered_total`.

### Region is already carried, just never consulted

`HealthEvent.region` exists (`src/health.rs:6`) and is populated from the API
response (`src/aws/health.rs:215-217`). Its only consumers are presentational
or observational:

- `src/slack/formatter.rs:47` renders it as the Slack `Region` field.
- `src/k8s/event.rs:70-71` appends `" in {region}"` to the Kubernetes Event
  message.
- `src/observability/metrics.rs:118` uses it as the `region` label on
  `aws_health_event_received_total`.

`minimal_event` in `src/poller.rs:309` already copies `region` from the
summary, so the reminder path (`src/poller.rs:273`) can filter on region
without an extra `DescribeEventDetails` call.

Adding region filtering is therefore a change to the filter and its wiring, not
to the event model.

### The API cannot express a deny list

`aws_sdk_health::types::EventFilter` carries a `regions` field, but it is an
allow-list-only mechanism: the API has no "exclude these regions" input. A deny
list must therefore be evaluated in process regardless, exactly as
`denyServices` is today, so in-process is where both lists live.

## Architecture

![Architecture](region-filtering.svg)

Both lists are evaluated in one place, `EventFilter::evaluate`. `DescribeEvents`
is called exactly as before, without a `regions` narrowing, so every event the
account can see is still fetched and the filter decides on it locally. That
keeps one enforcement point and one set of semantics.

## Semantics

### Matching

Region strings are matched case-insensitively after trimming, the same
normalization `normalize()` applies to services and categories. AWS emits
lowercase region codes (`ap-northeast-2`, `eu-central-1`), so this only guards
against operator typing.

### Evaluation order

Region checks sit between the service checks and the event-code checks, so that
a more specific `SERVICE/EVENT_TYPE_CODE` deny still reads as the most targeted
rule:

```
deny_category -> deny_service -> deny_region -> deny_event_code
  -> allow_categories -> allow_services -> allow_regions -> allow_event_codes
```

Two new `FilterDecision` variants and their `reason()` strings:

| Variant | reason | Meaning |
|---------|--------|---------|
| `DenyRegion` | `deny_region` | Event region appears in `deny_regions`. |
| `NotInAllowedRegions` | `region_not_allowed` | `allow_regions` is non-empty and the event region is not in it. |

Both become new values of the `reason` label on
`aws_health_event_filtered_total` and must be added to the label-values list in
`docs/metrics.md`.

### Missing region

`HealthEvent.region` is `Option<String>`, and the field can also arrive as an
empty string. An event with no region is **allowed** by both lists:

- The deny path already behaves this way for event codes. `matches()` returns
  false on an empty code, which is what
  `missing_event_code_passes_deny_list` asserts. Region matching mirrors it.
- The allow path is the one that needs an explicit rule. `contains_ci` returns
  false for an empty needle, so a naive `!allow_regions.is_empty() &&
  !contains_ci(...)` would silently drop every region-less event the moment an
  operator sets an allow list. The check must therefore be skipped when the
  region is absent or empty.

The failure mode being avoided is losing a real event because AWS omitted a
field, which is worse than delivering one extra notification.

### Global events

AWS Health reports global-scope events with the region `global`. Under a strict
allow list such as `[ap-northeast-2]`, those would all disappear, which is a
silent and hard-to-notice loss for services like IAM, Route 53, CloudFront, and
Health itself.

`global` is therefore treated as always allowed: it is appended to the
effective allow list rather than required from the operator. It stays deniable,
so an operator who genuinely wants global events gone can list `global` in
`denyRegions`.

`global` is a literal, not a region code, so startup validation accepts it
alongside well-formed region codes.

## Configuration

### Filter constructor

`EventFilter::new` and `validate_filters` take one list per parameter today, six
and seven positional arguments respectively. A fourth dimension pushes both past
the `clippy::too_many_arguments` threshold, and eight same-typed `&[String]`
arguments in a row are a real mis-ordering hazard at the call site.

Both therefore take a single borrowed `FilterLists` struct with one named field
per list. `Default` gives the empty-list case, so a test that exercises one
dimension names only that field:

```rust
EventFilter::new(&FilterLists {
    allow_regions: &["ap-northeast-2".into()],
    ..Default::default()
})
```

### Environment

Two new variables on `RunArgs` in `src/config.rs`, following the existing
pattern exactly:

```rust
/// Comma-separated AWS region codes to allow (case-insensitive).
/// Empty = allow all. `global` is always allowed.
#[arg(long, env = "ALLOW_REGIONS", value_delimiter = ',', num_args = 0..)]
pub allow_regions: Vec<String>,

/// Comma-separated AWS region codes to deny (wins over allow).
#[arg(long, env = "DENY_REGIONS", value_delimiter = ',', num_args = 0..)]
pub deny_regions: Vec<String>,
```

### Chart

`filter.allowRegions` and `filter.denyRegions` in `values.yaml`, rendered into
the existing `<fullname>-filter` ConfigMap by
`templates/configmap.yaml`, which already gates every key behind `with` so an
empty list emits nothing:

```yaml
{{- with .Values.filter.allowRegions }}
ALLOW_REGIONS: {{ join "," . | quote }}
{{- end }}
{{- with .Values.filter.denyRegions }}
DENY_REGIONS: {{ join "," . | quote }}
{{- end }}
```

The deployment's checksum annotation over that ConfigMap already rolls the pods
when the filter changes, so no extra wiring is needed.

The motivating case then becomes:

```yaml
filter:
  allowRegions:
    - ap-northeast-2
  denyEventCodes:
    - EC2/AWS_EC2_OPERATIONAL_ISSUE
    - VPN/AWS_VPN_REDUNDANCY_LOSS
    - ES/AWS_ES_SERVICE_SOFTWARE_UPDATE_AVAILABLE
```

`DIRECTCONNECT/AWS_DIRECTCONNECT_OPERATIONAL_ISSUE` leaves the deny list. A
Frankfurt outage is dropped on region; a Seoul outage still pages.

## Server-side narrowing

`aws_sdk_health::types::EventFilter` carries a `regions` field, so the allow
list could also be pushed into `DescribeEvents` the way `services` and
`categories` already are. That is deliberately left out of this change.

The gain is not measurable. One account polled every 60 seconds returns a
handful of event summaries, and the region check is a string compare on a list
of one or two entries.

The risk is a silent loss. The narrowing would have to carry `global` for
global-scope events to survive an allow list, and if the API rejects or ignores
`global` as a `regions` value, those events are never fetched. The in-process
rule that intends to keep them then never sees them, which is exactly the
failure mode [Missing region](#missing-region) and [Global events](#global-events)
are written to avoid, except undetectable from the filter metrics.

Adding it later is additive and needs no semantic change, because the
in-process check is already authoritative: `list_events` and `list_upcoming`
would gain a `regions` parameter fed from a new `PollerCfg.regions` field, set
to the allow list plus `global`, and the filter would keep deciding. It should
be done only after confirming against the real API that a `regions` filter
containing `global` still returns global-scope events.

## Startup validation

`validate_filters` and `ValidationReport` in `src/filter.rs` gain
`allow_regions` / `deny_regions` entries, and `all_invalid()` reports them as
`allow_regions '<value>'` and `deny_regions '<value>'`.

Regions cannot be validated the way services and event codes are.
`DescribeEventTypes`, which backs `lookup_service_codes` and
`lookup_event_type_codes`, returns no region catalog. Two options:

1. **Shape validation.** Accept anything matching the AWS region-code shape
   (`^[a-z]{2}(-[a-z]+)+-\d$`) plus the literal `global`. Catches typos such as
   `ap-northeast2` and `eu_central_1`, accepts regions that do not exist yet
   without a release.
2. **Static list.** Ship the known region codes as a constant. Catches
   `ap-northeast-9`, but goes stale on every new region launch and turns a
   correct configuration into a crash loop.

Option 1 is chosen. A wrong-but-well-formed region is an over-filter the
operator can see in `aws_health_event_filtered_total{reason="region_not_allowed"}`,
whereas a stale static list is a startup failure with no workaround short of a
new image.

Validation failure keeps the current behaviour: log the invalid values and
abort startup from `validate_against_catalog` in `src/server.rs`. Regions add no
`DescribeEventTypes` call, so the `queried_service_count` and
`queried_event_code_count` fields on the validation log line are unchanged. The
failure message names service codes and event type codes only and is reworded to
cover regions.

## Observability

- Two new `reason` values on `aws_health_event_filtered_total`, documented in
  `docs/metrics.md`.
- The startup `"filter validation result"` log line gains the region lists,
  matching the existing per-list valid/invalid count pairs.
- The earlier `"filter configured"` line gains `allow_regions`, `deny_regions`,
  and `allow_regions_effective`, the enforced allow set including the implicitly
  appended `global`:

```
filter configured ... allow_regions=["ap-northeast-2"] allow_regions_effective=["ap-northeast-2", "global"]
```

  `allow_regions_effective` is empty when `allow_regions` is empty, because
  allow-all has no effective set to report. This is how an operator sees that
  `global` was added, without every deployment paying for a warning about a rule
  it never touches.
- Region values dropped at runtime are not logged per event. A single outage in
  an unused region would otherwise print a line every poll cycle; the
  `reason` label on `aws_health_event_filtered_total` carries it instead.
- No new metric. `aws_health_event_received_total` already carries a `region`
  label, so the events a new allow list would drop can be measured before the
  list is turned on:

```promql
sum by (region) (increase(aws_health_event_received_total[7d]))
```

Running that query first is the recommended way to pick an allow list, rather
than reasoning about which regions the account "should" be using.

## Testing

Unit tests in `src/filter.rs`, mirroring the existing event-code cases:

- Empty region lists allow everything, including an event with no region.
- `denyRegions` drops a matching region, keeps the others.
- `allowRegions` drops a non-listed region, keeps a listed one.
- Deny wins over allow for the same region.
- Region matching is case-insensitive.
- An event with `region: None` and an event with `region: Some("")` both pass a
  non-empty allow list.
- `global` passes a non-empty allow list that omits it, and is dropped when it
  appears in the deny list.
- Region and event-code rules compose: the same event code is delivered in one
  region and dropped in another.

In `src/poller.rs`, extend the reminder-path test alongside
`minimal_event_carries_event_code_for_filtering` to assert the summary's region
reaches the filter, so reminders cannot bypass a region rule.

Validation tests in `src/filter.rs` alongside `validate_flags_unknown_event_code`:
well-formed regions pass, malformed ones are reported per list, `global` is
accepted.

## Migration

Additive and backward compatible. Both lists default to empty, which is
allow-all, so an existing deployment behaves identically until an operator sets
one. Removing an event code from `denyEventCodes` in favour of a region rule is
a separate, deliberate change on the deployment side.

## Resolved questions

**Should `global` be appended silently, or should omitting it produce a startup
warning?** Silently, with the effective list logged. `allow_regions_effective`
on the existing validation line shows exactly what is in force, and a warning on
every deployment that never thinks about global events is noise about a rule
nobody wants to change.

**Should a well-formed but never-matching `allowRegions` entry be surfaced?**
No. `sum by (region) (increase(aws_health_event_received_total[7d]))` already
answers it from data, and shape validation cannot tell `ap-northeast-9` from a
region that simply had no events this week. A background matcher would be a
second, weaker source of the same answer.
