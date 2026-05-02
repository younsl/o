---
title: "pyroscope in production"
date: 2026-04-28T22:00:00+09:00
updated: 2026-04-28T22:00:00+09:00
description: "Continuous profiling is not a fourth pillar. It's a tool you reach for when metrics, logs, and traces have already failed."
keywords: []
tags: ["devops", "observability", "pyroscope", "profiling"]
template: "zine.html"
---

{% card(kind="cover", title="pyroscope in production", author="Younsung Lee", author_url="https://github.com/younsl") %}
*Continuous profiling is a scalpel, not a dashboard.*
{% end %}

{% card(title="Epigraph") %}
> 고도로 발달한 공학은 예술 그 자체다.

*Sufficiently advanced engineering is indistinguishable from art.*
{% end %}

{% card(title="The pitch") %}
[Pyroscope](https://grafana.com/oss/pyroscope/) collects CPU, memory, and lock profiles from every process, every minute, forever.

You can finally answer *"why is this slow?"* at the function level. In production. Without restarting anything.
{% end %}

{% card(title="The trap") %}
You roll it out fleet-wide. Cardinality explodes. Storage bills creep up. Nobody opens the flame graphs.

Six months later it's another tab in Grafana that nobody reads.
{% end %}

{% card(title="Profiling ≠ a fourth pillar") %}
![Architecture: three boxes on the left — Metrics (is it slow?), Logs (what happened?), Traces (which service?) — converge through a funnel labeled "narrowed to one service" into a single Profiles box on the right (which line of code?). Triage on the left, drilldown on the right.](./four-pillars.svg)

Vendors will tell you metrics, logs, traces, *and now profiles*.

Profiling is not a coequal pillar. It's the thing you reach for *after* the other three have narrowed the suspect to a single service.
{% end %}

{% card(title="When you actually need it") %}
You have a service. p99 is bad. You know *which* service. You know *which* endpoint. You don't know *which line of code*.

That's the moment Pyroscope earns its keep.
{% end %}

{% card(title="When you don't") %}
You don't have SLOs. You don't have traces. You don't know which service is slow.

Profiles won't save you. Fix the basics first.
{% end %}

{% card(title="I. Deployment") %}
How profiles get into Pyroscope.
{% end %}

{% card(title="The shape of it") %}
![Pyroscope architecture: profile sources (application with pprof SDK push, Alloy DaemonSet with eBPF pull) feed into Pyroscope (Distributor, Ingester, Compactor, Querier), which writes to and reads from object storage like S3 or GCS, and serves queries to Grafana Profiles Drilldown.](./architecture.svg)

Two collection paths in. Object storage in the middle. Grafana on the way out.
{% end %}

{% card(title="Two collection models") %}
**SDK push** — the app calls the Pyroscope SDK, samples itself, ships profiles out.

**eBPF pull** — [Grafana Alloy](https://grafana.com/docs/alloy/latest/) (or the legacy agent) reads `/proc` and kernel events, no app changes.

Pick one per workload. *Don't run both.*
{% end %}

{% card(title="eBPF for breadth") %}
You don't own all the binaries. Third-party sidecars, vendor agents, polyglot fleets — eBPF gives you CPU profiles across all of them with zero code change.

Use it where *coverage* matters more than *depth*.
{% end %}

{% card(title="SDK for depth") %}
Go: `net/http/pprof` is already in the binary — push to Pyroscope is a one-liner, and you get heap, mutex, block, and goroutine profiles eBPF can't see.

Java: [async-profiler](https://github.com/async-profiler/async-profiler) is still the standard for JVM, with accurate JIT symbolization eBPF struggles with.

For services you own, the SDK is usually the better deal.
{% end %}

{% card(title="The honest split") %}
Despite the marketing, SDK push is still the majority of production Pyroscope deployments — especially Go and JVM.

eBPF is rising fast, and it's the right default for new polyglot fleets. But "eBPF or nothing" is not where the industry actually is.
{% end %}

{% card(title="DaemonSet, not sidecar") %}
Run the eBPF collector as a [DaemonSet](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/). *One per node.* It scrapes every container.

A sidecar per pod is wasteful — eBPF reads kernel events, not pod-local state.
{% end %}

{% card(title="II. Labels") %}
The cardinality story is the whole story.
{% end %}

{% card(title="Labels are the index") %}
Pyroscope queries by label set: `service_name`, `namespace`, `pod`, `version`, anything you push.

Every unique combination is a separate series. Storage and query cost scale with cardinality. *Same as Prometheus. Same problem.*
{% end %}

{% card(title="The labels you want") %}
- `service_name` — the service, not the pod
- `namespace` — for multi-tenant clusters
- `version` — to compare before/after a deploy
- `env` — prod, staging, dev

Stop there. Almost always.
{% end %}

{% card(title="The labels you don't") %}
- `pod_name` — changes every restart, infinite churn
- `request_id` — unbounded, will kill the database
- `user_id` — same

If a label's value space is unbounded, *don't push it as a label*. Encode it in the profile or skip it.
{% end %}

{% card(title="version is the killer label") %}
The single most useful label is `version` (git SHA or semver).

Diff a flame graph between two versions and the regression introduced by your last deploy is *visually obvious*. This is the workflow that justifies the whole tool.
{% end %}

{% card(title="III. Sampling and overhead") %}
Profiling is not free.
{% end %}

{% card(title="The default is fine") %}
Pyroscope SDKs default to ~100 Hz CPU sampling. eBPF defaults are similar.

This costs 1–2% CPU on a healthy service. *Don't tune it down to be safe.* You'll make profiles too sparse to be useful and save nothing meaningful.
{% end %}

{% card(title="When overhead matters") %}
Latency-critical hot paths — high-frequency trading, ad serving, real-time bidding.

Measure first. If 1% CPU is unacceptable, you have other problems.
{% end %}

{% card(title="Allocation profiling is expensive") %}
CPU profiles sample. Allocation profiles in some runtimes (Go's `mutex`, `block`) instrument *every event*.

Read the docs for your runtime before enabling them in production. The default is usually off for a reason.
{% end %}

{% card(title="IV. Storage") %}
Where the bill comes from.
{% end %}

{% card(title="Retention is the dial") %}
Pyroscope stores raw stack traces. Compressed, but still bigger than metrics.

A fleet of 1000 pods at default sampling, 30-day retention: tens to hundreds of GB. Don't be surprised.
{% end %}

{% card(title="Short retention, narrow scope") %}
You don't need 90 days of profiles. You need *yesterday's* and *last week's*.

7–14 days is usually enough. The diff workflow is short-horizon.
{% end %}

{% card(title="Object storage from day one") %}
Pyroscope can run on local disk. *Don't.*

Use [S3](https://aws.amazon.com/s3/) (or GCS, or compatible) from the start. The migration later is painful and you'll lose history.
{% end %}

{% card(title="V. The flame graph") %}
The thing you actually look at.
{% end %}

{% card(title="Read it from the bottom") %}
The wide bars at the bottom are the entry points. The wide bars at the top are where time is actually spent.

If the top is dominated by `runtime.gcBgMarkWorker` or `epoll_wait`, your hotspot is GC or I/O — not your code.
{% end %}

{% card(title="Diff > absolute") %}
A flame graph in isolation tells you where time goes. Useful, sometimes.

A flame graph *diffed against a baseline* tells you what *changed*. Almost always more useful.
{% end %}

{% card(title="Trace → profile is the killer link") %}
[Tempo](https://grafana.com/oss/tempo/) traces tell you which span was slow. The span profile shows you the stack *inside that span*.

This is the workflow Pyroscope was built for. *Wire it up.* It's a few lines of config in [Alloy](https://grafana.com/docs/alloy/latest/) or your SDK.
{% end %}

{% card(title="Profiles Drilldown") %}
[Profiles Drilldown](https://grafana.com/docs/grafana/latest/explore/simplified-exploration/profiles/) is the queryless UI on top of Pyroscope — service breakdowns, label exploration, diff views, all without writing a query.

For most engineers, *this is the entry point*. Not the raw datasource. Not the Explore tab.
{% end %}

{% card(title="Stop teaching the query language") %}
The Pyroscope query syntax is fine. Almost nobody on your team needs to learn it.

Drilldown handles 90% of investigations. Save query syntax for the SRE who's tuning a recording rule.
{% end %}

{% card(title="Drilldown's diff is the workflow") %}
Pick a service. Pick *before deploy* and *after deploy*. The [Diff flame graph view](https://grafana.com/docs/grafana/latest/visualizations/simplified-exploration/profiles/choose-a-view/) highlights the new red bars — share of time per function, normalized across both windows.

The workflow that used to take an afternoon now takes 30 seconds. *This is the regression-hunt loop.*
{% end %}

{% card(title="VI. Anti-patterns") %}
Things I keep seeing.
{% end %}

{% card(title="Profiling everything") %}
Enabling Pyroscope on every workload — including 5-replica cron jobs that run for 10 seconds — produces noise, not insight.

Profile services with steady-state load. Skip the rest.
{% end %}

{% card(title="The dashboard graveyard") %}
Building a Grafana dashboard with 12 flame graphs *next to each other*.

Flame graphs are interactive. They are not panels. Use the Pyroscope UI, link from incidents.
{% end %}

{% card(title="Confusing CPU with latency") %}
A function high in the CPU flame graph is *CPU-heavy*. It is not necessarily *slow*.

If your service is slow because it's blocked on the database, CPU profiles will lie to you. Use traces to localize, *then* profile.
{% end %}

{% card(title="VII. Operating it") %}
The pieces that fail.
{% end %}

{% card(title="Ingester is the choke point") %}
Pyroscope's ingester holds recent profiles in memory. Under bursty traffic — a deploy that restarts every pod — it OOMs.

Size for the *startup spike*, not the steady state.
{% end %}

{% card(title="Compactor lag is silent") %}
The compactor merges blocks in object storage. If it falls behind, queries get slow but nothing alerts.

Watch [`pyroscope_compactor_blocks_marked_for_deletion_total`](https://grafana.com/docs/pyroscope/latest/) and the block age. *Set an SLO on compaction lag.*
{% end %}

{% card(title="Adoption is the hardest problem") %}
The infra is easy. *Getting engineers to open the tool* is hard.

Link profiles from your incident runbooks. Demo the trace-to-profile jump in postmortems. Otherwise it's another tab nobody clicks.
{% end %}

{% card(title="VIII. The three questions") %}
Before you deploy Pyroscope.
{% end %}

{% card(title="Ask yourself") %}
1. Do I already know *which* service is slow? (If not, fix tracing first.)
2. Will I diff profiles across versions? (If not, you're collecting souvenirs.)
3. Who opens the flame graph during an incident? (If nobody, the deployment is theater.)
{% end %}

{% card(title="If you can answer those") %}
Continuous profiling will pay for itself the first time it saves a postmortem.

If you can't, no amount of cardinality will save you.
{% end %}

{% card(kind="end", title="Profiles are evidence.") %}
*Don't collect them like trophies.*
{% end %}
