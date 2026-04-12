---
title: "rethink o11y"
date: 2026-04-12T01:23:00+09:00
lastmod: 2026-04-12T01:23:00+09:00
description: "Observability is a licensing and delivery mechanism for understanding, not a dashboard collection hobby"
keywords: []
tags: ["devops", "observability"]
---

This post is inspired by Rich Hickey's [Open Source is Not About You](https://gist.github.com/richhickey/1563cddea1002958f96e7ba9519972d9#open-source-is-not-about-you). His original essay challenged the sense of entitlement in open source communities. This post applies the same lens to observability — replacing "you deserve features" with "you deserve dashboards."

# Observability is Not About Dashboards

The only people entitled to say how observability 'ought' to work are people who run production systems, and the scope of their entitlement extends only to their own systems.

Just because you deployed [Prometheus](https://prometheus.io/), [Grafana](https://grafana.com/), [Loki](https://grafana.com/oss/loki/), [Tempo](https://grafana.com/oss/tempo/), and an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) does not mean you have observability. You have infrastructure. Expensive infrastructure that someone now has to maintain — and that someone is usually the same team that was already too busy to understand their own system in the first place.

As an operator of something in production you are not entitled to understanding by default. You are not entitled to root cause. You are not entitled to a dashboard that tells you what's wrong. You are not entitled to having value attached to your Grafana screenshots in the incident channel. You are not entitled to this explanation.

If you have expectations (of your tooling) that aren't being met, those expectations are your own responsibility. You are responsible for your own understanding. If you want answers, earn them.

## The Three Pillars Myth

The "three pillars of observability" — metrics, logs, traces — is a vendor taxonomy, not an engineering principle. It describes three data formats you can buy storage for. It says nothing about whether you can actually understand your system.

I have seen teams with all three pillars, correlated and indexed and dashboarded into oblivion, who cannot answer the question: "why is this slow right now?" I have seen a single engineer with `kubectl top`, `tcpdump`, and two well-placed log lines find the answer in minutes.

The difference is not tooling. The difference is understanding.

## Dashboards Are Not Understanding

Dashboards are the most popular form of cargo-cult observability. Teams copy others' [Grafana](https://grafana.com/) JSON, import community dashboards for every component they run, and end up with 200 panels nobody looks at until an incident, at which point nobody knows which panel matters.

A dashboard you didn't design is a dashboard you don't understand. A dashboard you don't understand is visual noise. It is negative value — it costs money to store, distracts during incidents, and creates a false sense of coverage.

Every panel should exist because someone asked a specific question about the system and this panel answers it. If you cannot articulate the question a panel answers, delete the panel. I promise you will not miss it.

## Alert Fatigue Is a Choice

You are not a victim of alert fatigue. You chose it. You chose it when you set arbitrary thresholds without understanding baseline behavior. You chose it when you alerted on symptoms instead of impact. You chose it when you copied alerting rules from a blog post written by someone running a completely different system at a completely different scale. You chose it every time you hit "snooze" instead of "delete."

An alert that doesn't require action is not an alert — it's spam. An alert that fires so often nobody reacts to it is worse than no alert at all, because it erodes the team's trust in the system that's supposed to wake them up when something actually matters.

The right number of alerts is shockingly small. I have seen teams go from 400 alerting rules to 15 and improve their incident response time. Not despite the reduction — because of it.

## The Collection Trap

More data is not better observability. More data is more data. It is more cost, more noise, more retention policy meetings, and more [Elasticsearch](https://www.elastic.co/elasticsearch) clusters to babysit.

Every metric you collect that you never query is waste. Every log line you ship that you never search is waste. Every trace you store that you never follow is waste. And the cumulative waste is staggering — I have personally seen organizations spend more on their observability stack than on the actual infrastructure being observed.

The question is never "what can we collect?" The question is "what do we need to know?" Start from the questions. Instrument for the answers. Stop there.

## Observability Requires Investment — Yours

Real observability — the ability to understand the internal state of your system from its external outputs — requires you to do something that tools cannot do for you: think about your system.

It requires you to know what "normal" looks like before you can recognize abnormal. It requires you to understand the relationship between your application's behavior and the infrastructure it runs on. It requires you to have opinions about what matters and what doesn't. No vendor can sell you this. No [CNCF](https://www.cncf.io/) project can give you this. No consultant can install it.

[OpenTelemetry](https://opentelemetry.io/) is a gift. [Prometheus](https://prometheus.io/) is a gift. [Grafana](https://grafana.com/) is a gift. They are powerful, well-designed tools built by talented people who owe you nothing. What they give you is the *ability* to observe. Whether you actually observe is entirely on you.

## Stop Collecting, Start Thinking

I encourage everyone drowning in dashboards and alerts and petabytes of logs they never read, to close Grafana for an hour, sit with your team, and answer these questions:

1. What are the three most important things our system does for its users?
2. How do we know right now — not tomorrow, not after an incident — whether those things are working?
3. When they stop working, what's the first thing we need to know to fix them?

If you can answer these questions, you have the foundation for real observability. If you cannot, no amount of tooling will save you.

The time to stop worshipping tools and start understanding systems is right now.

## Closing

I have the deepest respect for the people building observability tools and infrastructure. This message is not about them. It's about the gap between deploying tools and actually using them to understand what's happening.

If you're already doing this well — asking good questions, instrumenting deliberately, deleting what doesn't serve you — this isn't for you. Keep going.
