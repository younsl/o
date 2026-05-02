---
title: "rust for kubernetes addons"
date: 2026-04-19T22:00:00+09:00
updated: 2026-04-19T22:00:00+09:00
description: "Go is the default language of Kubernetes. I stopped using it for addons anyway."
keywords: []
tags: ["devops", "kubernetes", "rust"]
template: "zine.html"
---

{% card(kind="cover", title="rust for kubernetes addons", author="Younsung Lee", author_url="https://github.com/younsl") %}
<!-- cover -->
{% end %}

{% card(title="Go is the default language of Kubernetes.") %}
*I stopped using it for addons anyway.*
{% end %}

{% card(title="The default") %}
client-go is the reference. controller-runtime, kubebuilder, operator-sdk — all Go. Every KubeCon talk assumes Go.

Picking anything else means swimming against the ecosystem.
{% end %}

{% card(title="I do it anyway") %}
Every addon I've shipped this year — [karc](https://github.com/younsl/o/tree/main/box/kubernetes/karc), [kuo](https://github.com/younsl/o/tree/main/box/kubernetes/kubernetes-upgrade-operator), [trivy-collector](https://github.com/younsl/o/tree/main/box/kubernetes/trivy-collector), [gss](https://github.com/younsl/o/tree/main/box/kubernetes/gss), [filesystem-cleaner](https://github.com/younsl/o/tree/main/box/kubernetes/filesystem-cleaner) — is Rust.

This book is *why*.
{% end %}

{% card(title="Wrong workload") %}
Go was built for big teams writing big network services that need to be read by someone who joined last Tuesday.

My addons are small operators that sit in a cluster forever. The priorities invert.
{% end %}

{% card(title="I. Wins") %}
The axes that matter to operators.
{% end %}

{% card(title="Smaller images") %}
Go + client-go + AWS SDK: a 30–80 MB distroless image.

Rust on musl, packed into scratch: 5–15 MB.

Cold ECR pulls and CVE scan surface — both win.
{% end %}

{% card(title="Smaller memory") %}
A hello-world Go controller idles at 30–50 MB RSS before doing anything.

The same controller in Rust: 5–10 MB.

Noise on one Pod. Real money across a fleet.
{% end %}

{% card(title="No nil panics") %}
The single most common failure I've operated in Go: `nil pointer dereference`.

Rust's `Option` makes presence-or-absence part of the type system. The compiler refuses to forget.
{% end %}

{% card(title="No silent error drops") %}
Go error handling looks identical whether you handle or *ignore* an error. `_ =` and the compiler shrugs.

Rust refuses to compile if you drop a `Result`.
{% end %}

{% card(title="Tokio cancellation") %}
Goroutines and channels are elegant in the language tour.

Structured cancellation, backpressure, propagating deadlines — `tokio::select!` + `CancellationToken` makes ownership clear.
{% end %}

{% card(title="kube-rs is ready") %}
[kube-rs](https://kube.rs/) was the blocker for years. It isn't anymore.

Typed APIs, watchers, controllers, finalizers, admission webhooks. Narrower than controller-runtime — but enough.
{% end %}

{% card(title="II. Tradeoffs") %}
I am not pretending this is free.
{% end %}

{% card(title="Cross-compilation is harder") %}
Go: `GOOS=linux GOARCH=arm64 go build`. Done.

Rust: target installed, target linker, often a C toolchain. `cargo-zigbuild` makes it painless — *eventually*.
{% end %}

{% card(title="Zig caveat") %}
`cargo-zigbuild` depends on [Zig](https://ziglang.org/), still pre-1.0.

I use it pinned, as a linker only — not a language I write in. If it breaks, fall back to gcc and linker paths by hand.
{% end %}

{% card(title="Compile times") %}
A cold release build is minutes, not seconds. I feel it on every release.

Incremental dev builds are fast. The cost is the guarantees.
{% end %}

{% card(title="Smaller talent pool") %}
*"I know Go"* is a more common resume line than *"I know Rust"*.

Mitigation: the addons are small. Total Rust under 15k lines. A new hire learns to operate them in a week.
{% end %}

{% card(title="III. The claim") %}
What I'm *not* claiming, and what I am.
{% end %}

{% card(title="Not claiming") %}
Not that Rust is better in general.
Not that you should rewrite your Go services.
Not that this scales to a 100-person backend team.
{% end %}

{% card(title="Claiming") %}
For small, long-running, resource-constrained Kubernetes addons run by a small team forever —

Rust beats Go on image size, memory, crash class, and shutdown determinism.
{% end %}

{% card(title="Unix philosophy") %}
Go was built to build a *big thing*.

Rust is built to build a *small, correct thing that does not fall over*.

My addons are the second kind.
{% end %}

{% card(kind="end", title="That's why.") %}
*All in Rust.*
{% end %}
