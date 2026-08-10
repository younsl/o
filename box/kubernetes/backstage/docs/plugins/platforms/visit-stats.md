---
plugins:
  - platforms-backend
---

# Platform Visit Stats

## Overview

The Platforms page ranks each internal service by how many people actually open it. This document describes where that data comes from, how the numbers are derived, and what is retained.

**Audience**

- **Plugin maintainers** changing the aggregation or the retention rules.
- **Backstage operators** answering "what does this store about users?" and "why did a platform's rank change?".

## Collection

There is no external analytics integration. A visit is recorded when a user clicks a platform tile or card on `/platforms`, which sends `POST /api/platforms/visits` with the platform name.

- The request is authenticated. An unauthenticated call is rejected, so every row carries a real user entity ref.
- The platform name is validated against `app.platforms` in app-config. An unknown name is rejected, which keeps an arbitrary POST from writing unbounded rows.
- Recording is fire-and-forget on the frontend. A failed write never delays opening the platform.

## Schema

Table `platform_visits`, created on plugin init:

| Column | Type | Notes |
|---|---|---|
| `id` | auto-increment | Primary key |
| `platform` | string | Matches a `name` in `app.platforms` |
| `user_ref` | string | User entity ref, used only for distinct counting |
| `day_key` | string(10) | `YYYY-MM-DD` calendar bucket, computed at write time |
| `visited_at` | timestamp | Exact instant of the click |

Indexed on `(day_key, platform)`.

`day_key` is computed once at write time rather than derived at query time. That keeps every aggregation a plain string comparison, so the queries behave identically on the SQLite dev database and the PostgreSQL production one, and it fixes a visit to the calendar day the user experienced rather than to UTC.

## Derived metrics

`GET /api/platforms/stats` returns one entry per configured platform, including platforms with no visits.

| Field | Meaning |
|---|---|
| `dailyVisitors` | Distinct users today |
| `weeklyVisitors` | Distinct users over the trailing 7 days |
| `previousWeeklyVisitors` | Distinct users over the 7 days before that |
| `trendPercent` | Week-over-week change, or null when the previous window is empty |
| `rank` | 1-based rank by `weeklyVisitors`, null when there were none |

The response also carries `rankedCount`, the number of platforms that had at least one visitor this week. Rank and that total are the whole popularity model. The backend ships no named tiers, since any grouping on top of a rank is a presentation choice with a threshold the reader never sees.

Popularity is ranked on distinct weekly users rather than raw clicks, so one person refreshing a dashboard all afternoon does not outrank a service the whole team opened once.

Ties share the lower rank, so a leaderboard reads `#1 #1 #3`.

`trendPercent` is null rather than infinite when the previous week is empty, and the UI drops the trend row rather than inventing a value for it.

## Presentation

Both views render the same component, so the rows, their order, and their labels are identical. The card shows it inline below the tags; the grid tile puts it in the hover tooltip, because a 64px tile has no room for it.

Cards stretch to the tallest card in their grid row, tags wrap onto as many lines as they need at full width, and the stat block is pinned to the bottom edge so it lands on one horizontal line across the row.

Where the leftover height goes is the whole design. The tail block takes it, not the linked head above it, so the slack opens between the tags and the stats. Put it in the head instead and it opens under the description, where it reads as a hole punched in the card.

Two earlier arrangements were dropped, and the reasoning is worth keeping:

- **Growing the head** pinned the stats correctly but pushed every short description away from its own tags, and the grid read as mostly empty.
- **Pinning the tag row to one line**, first by clipping the overflow and then by ellipsizing the chips, also held the stats in place but traded away readable tag labels to do it. The tags are what the reader clicks, so that is the wrong way round.

The tag row keeps a one-chip-line floor so that an untagged platform still leaves a normal gap above its stats.

The production VPN notice is overlaid on the bottom of the logo band rather than placed in the flow. That band is a fixed 96px on every card, so the notice appears only where it applies while costing no height and shifting nothing beneath it.

| Row | Meaning |
|---|---|
| `Popularity` | Rank among platforms with visitors this week (`#3`), or `No visits` |
| `Weekly trend` | Week-over-week change. Omitted when there is no previous week |
| `Daily visitors` / `Weekly visitors` | Distinct people, today and over the trailing 7 days. Shown side by side on one line, since they read as a pair |

Every number on the page counts distinct people. One person opening a platform five times today still counts as one daily visitor. Raw click rows are still written, but only as the input to that distinct count, and no total-clicks figure is surfaced anywhere.

Popularity renders as the bare rank. No named tiers, no icons, no percentile. A rank is a fact the reader can check against the visitor counts sitting directly below it, where a label like "Hot" is a threshold they cannot see and did not choose. The rank's total (`Rank 3 of 24 by weekly visitors`) is available on hover for anyone who wants the denominator.

The trend is the only colored value, and it always carries an arrow glyph, so it never reads as color alone.

A platform nobody opened this week has no rank and no previous week to trend against. Rather than saying that twice, it collapses to a single `No visits` and the trend row is dropped.

Tags on a card are buttons that toggle the page's tag filter. The card's link stops above the tag row rather than wrapping it, since a button nested inside an anchor is neither valid markup nor reliably clickable.

## Retention and cleanup

A scheduled task runs every 6 hours, one minute after startup:

1. Rows older than 90 days are deleted.
2. Rows for platforms no longer present in `app.platforms` are deleted.

Step 2 is skipped when the configured platform list is empty, so a config that failed to load cannot wipe the table.

The list is re-read on every run rather than captured at init, so removing a platform from app-config and redeploying clears its history within the hour. Without this, re-adding the same platform name inside the retention window would resurrect stale counts.

## Configuration

The plugin is always on and needs no app-config entry. One optional override exists:

```yaml
platforms:
  # IANA timezone used to bucket visits into calendar days. Default Asia/Seoul.
  timezone: Asia/Seoul
```

Changing the timezone does not rewrite already-recorded buckets.
