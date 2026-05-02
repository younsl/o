---
title: "job4 retro"
date: 2026-01-27T00:10:00+09:00
updated: 2026-01-27T00:10:00+09:00
description: "A retrospective on my 2 years and 6 months as a DevOps Engineer at job4"
draft: false
keywords: []
tags: ["retrospective", "devops", "career"]
template: "zine.html"
---

{% card(kind="cover", title="job4 retro", author="Younsung Lee", author_url="https://github.com/younsl") %}
![Silhouette of a person walking with a laptop](1.jpg)

2 years and 6 months as a DevOps Engineer.

*May 2023 — December 2025.*

<small>Photo by [Sebastian Schuster](https://unsplash.com/photos/silhouette-of-a-person-walking-with-a-laptop-UsMUD005Fbk) on Unsplash</small>
{% end %}

{% card(title="The role") %}
Cloud infra. CI/CD pipelines. Legacy cleanup. Monitoring and logging.

Predictable load. Stable routine.
{% end %}

{% card(title="I. The Good") %}
What worked.
{% end %}

{% card(title="Growth through legacy") %}
EC2 → Kubernetes.
Raw YAML → Helm charts.
Tangled Terraform → clean modules.

Fixing old systems is where I sharpened the most.
{% end %}

{% card(title="Stable routine") %}
Work was predictable. Free hours went to learning.

Less stress. Easier to last.
{% end %}

{% card(title="II. Lessons") %}
What broke, what taught.
{% end %}

{% card(title="Tech debt needs time") %}
Legacy was the biggest pain. Fixes never ended.

Most days went to keeping old systems alive — not building. Plan time to pay it down.
{% end %}

{% card(title="MSA in name only") %}
We called it microservices. No service mesh. 40+ ALBs, hand-managed.

More complexity. None of the benefits.
{% end %}

{% card(title="MSA: deploys") %}
True MSA means teams deploy independently.

We approved every deploy. 2–3 hours per engineer, every week. Wrong order broke things.
{% end %}

{% card(title="MSA: no mesh") %}
Devs coded Rate Limiting and Circuit Breakers by hand. Changing a limit = full redeploy.

*"We don't need that." "Overkill."* Routing, security, costs — all inefficient.
{% end %}

{% card(title="Toil kills motivation") %}
[Google SRE book](https://sre.google/sre-book/eliminating-toil/): keep toil under 50%.

We failed. Days, weeks — tickets and deploys. Motivation drained.
{% end %}

{% card(title="III. The Not-So-Good") %}
What hurt.
{% end %}

{% card(title="Politics over tech") %}
Relationships mattered more than good calls.

Safe options won, not best ones. Certain voices always carried — even with bad ideas.
{% end %}

{% card(title="Dust masks at work") %}
Two floors merged to cut costs. Construction during work hours. Masks all day. Noise. Dust.

No concern for people. This was the culture.
{% end %}

{% card(title="What I take away") %}
Culture matters as much as skill.

Software is built by people. Trust and respect beat any tool.
{% end %}

{% card(kind="end", title="Now.") %}
Two months into job5. The contrast still inspires.

*Just don't ask about Friday rush hour in 성수.*
{% end %}
