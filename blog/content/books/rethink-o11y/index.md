---
title: "rethink o11y"
date: 2026-04-12T01:23:00+09:00
updated: 2026-04-12T01:23:00+09:00
description: "Observability is a licensing and delivery mechanism for understanding, not a dashboard collection hobby"
keywords: []
tags: ["devops", "observability"]
template: "zine.html"
---

{% card(kind="cover", title="rethink o11y", author="Younsung Lee", author_url="https://github.com/younsl") %}
Observability is not a *dashboard collection hobby*.

After Rich Hickey's [*Open Source is Not About You*](https://gist.github.com/richhickey/1563cddea1002958f96e7ba9519972d9).
{% end %}

{% card(title="The wrong question") %}
Deployed [Prometheus](https://prometheus.io/), [Grafana](https://grafana.com/), [Loki](https://grafana.com/oss/loki/), [Tempo](https://grafana.com/oss/tempo/), [OpenTelemetry](https://opentelemetry.io/)?

You have infrastructure. Not observability.
{% end %}

{% card(title="You are not entitled") %}
Not to understanding. Not to root cause. Not to a dashboard that tells you what's wrong.

If you want answers, earn them.
{% end %}

{% card(title="The three pillars myth") %}
Metrics, logs, traces — a *vendor taxonomy*, not engineering.

Three storage formats. Says nothing about whether you understand your system.
{% end %}

{% card(title="Tooling ≠ understanding") %}
Teams with all three pillars who can't answer *"why is this slow now?"*

One engineer with `kubectl top`, `tcpdump`, two well-placed log lines — finds it in minutes.
{% end %}

{% card(title="Dashboards aren't understanding") %}
200 imported panels nobody reads until an incident — then nobody knows which panel matters.

A dashboard you didn't design is one you don't understand.
{% end %}

{% card(title="If you can't ask, delete") %}
Every panel should answer a specific question.

If you can't articulate the question, delete the panel. *You will not miss it.*
{% end %}

{% card(title="Alert fatigue is a choice") %}
You chose it: arbitrary thresholds, copied rules, *snooze* instead of *delete*.

An alert that needs no action isn't an alert — it's spam.
{% end %}

{% card(title="400 → 15") %}
I've seen teams cut alerting rules from 400 to 15 and improve incident response.

*Not despite the reduction — because of it.*
{% end %}

{% card(title="The collection trap") %}
Every metric you never query is waste. Every log line never searched is waste. Every trace never followed is waste.

Some orgs spend more on o11y than on the infra they observe.
{% end %}

{% card(title="Start from questions") %}
Not *"what can we collect?"*

"What do we need to know?"

Instrument for the answers. Stop there.
{% end %}

{% card(title="Tools are gifts") %}
Prometheus. Grafana. OpenTelemetry. Built by people who owe you nothing.

They give you the *ability* to observe. Whether you do is on you.
{% end %}

{% card(title="The three questions") %}
1. What are the three most important things our system does for users?
2. How do we know — *right now* — they're working?
3. When they break, what's the first thing we need?
{% end %}

{% card(title="If you can answer those") %}
You have the foundation for real observability.

If you can't, no tooling will save you.
{% end %}

{% card(kind="end", title="Stop worshipping tools.") %}
*Start understanding systems.*
{% end %}
