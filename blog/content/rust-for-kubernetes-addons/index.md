---
title: "rust for kubernetes addons"
date: 2026-04-19T22:00:00+09:00
lastmod: 2026-04-19T22:00:00+09:00
description: "Go is the default language of Kubernetes. I stopped using it for addons anyway."
keywords: []
tags: ["devops", "kubernetes", "rust"]
---

Go is the native language of Kubernetes. client-go is the reference implementation. controller-runtime, kubebuilder, and operator-sdk are all Go. Every talk at every KubeCon assumes Go. Picking anything else to write a controller is going against the current of the entire ecosystem.

I do it anyway. Every addon I've written in the last year — [karc](https://github.com/younsl/o/tree/main/box/kubernetes/karc), [kuo](https://github.com/younsl/o/tree/main/box/kubernetes/kubernetes-upgrade-operator), [trivy-collector](https://github.com/younsl/o/tree/main/box/kubernetes/trivy-collector), [gss](https://github.com/younsl/o/tree/main/box/kubernetes/gss), [filesystem-cleaner](https://github.com/younsl/o/tree/main/box/kubernetes/filesystem-cleaner), [elasticache-backup](https://github.com/younsl/o/tree/main/box/kubernetes/elasticache-backup), [redis-console](https://github.com/younsl/o/tree/main/box/kubernetes/redis-console), [snowflake-exporter](https://github.com/younsl/o/tree/main/box/kubernetes/snowflake-exporter) — is [Rust](https://www.rust-lang.org/).

This post is why.

## The default answer is wrong for my workload

Go is an excellent language for building Kubernetes itself. It was designed at Google to solve a very specific problem: large teams writing large network services that need to compile fast and be read by someone who joined last Tuesday. It optimizes for a readable lowest common denominator.

That is not my workload.

My workload is small, long-running operators and exporters that sit inside a cluster forever. A sidecar that cleans up a filesystem. A cronjob that backs up ElastiCache. A controller that watches one CRD. An exporter that runs one query every 30 seconds and exposes a /metrics endpoint.

For these, the priorities invert. I do not care that a new engineer can be productive in Go in three days. I care that the thing runs on 32Mi of memory, ships as a 4MB scratch image, and does not crash at 3am because someone dereferenced a nil pointer.

## What Rust actually buys me in a cluster

### Container image size

A typical Go controller with client-go and some AWS SDK imports produces a distroless image in the 30–80MB range. A Rust binary statically linked against musl and packed into a scratch image is usually 5–15MB. That matters when you're pulling it onto 200 nodes behind a cold ECR proxy, and it matters for CVE scanning surface — a scratch image has nothing to scan.

### Memory footprint

The Go runtime reserves memory generously. A hello-world Go controller idles at 30–50MB RSS before it has done anything. The same controller in Rust idles at 5–10MB. For a single deployment this is noise. For a DaemonSet across a large fleet, or a CronJob that spawns ten replicas, the difference is real infrastructure cost.

### No GC pauses

For a controller that processes reconcile events, GC pauses are not a disaster, but they are a source of latency you can never fully explain. Rust has deterministic destruction. You can reason about when memory is freed because the compiler tells you.

### Actual null safety

The single most common failure mode in Go services I have operated is the nil pointer dereference panic. client-go returns pointers to structs with pointer fields, and every one of them is a potential panic. Rust's Option type makes the presence-or-absence of a value part of the type system, and the compiler will not let you forget to handle the empty case. This is not a style preference. It is a class of incident that simply cannot happen.

### Result beats if-err-not-nil

Go's error handling is famously verbose, but verbose is not the real problem. The real problem is that it is syntactically identical to *ignoring* an error — you can discard the return value with a blank identifier and the compiler is fine with it. Rust refuses to compile if you drop a Result. The ergonomics of the question-mark operator make the happy path readable. The type system makes the failure path unignorable.

### Structured concurrency with Tokio

Go's goroutines and channels are elegant for the examples in the language tour. They are harder than they look when you need structured cancellation, backpressure, or deadlines that propagate. Tokio's select macro together with a CancellationToken gives me the same primitives with clearer ownership. For a controller that needs to shut down cleanly on SIGTERM without leaking a reconcile mid-flight, this is the difference between "it works" and "it works every time."

### kube-rs is production-ready

This was the blocker for years and is no longer. [kube-rs](https://kube.rs/) now covers the surface I need: typed API handles, watchers, controllers, finalizers, admission webhooks. It is not as broad as controller-runtime, but for the addons I actually write, it is enough and then some.

## The honest tradeoffs

I am not going to pretend this is free.

### Cross-compilation is harder

Go was built for cross-compilation. Set GOOS and GOARCH and you're done. Rust needs the right target installed, a target-specific linker, and often a C toolchain because some crate in your tree links to OpenSSL or SQLite. I now use cargo-zigbuild to make this painless, but it took work to get there. ([The repo's CI workflow](https://github.com/younsl/o/blob/main/.github/workflows/release-rust-cli.yml) is the receipts.)

That workaround has its own cost that is worth naming. cargo-zigbuild depends on [Zig](https://ziglang.org/) as the cross-linker, and Zig is still pre-1.0. It is not a language or toolchain I would recommend someone adopt as a core dependency lightly — the surface area changes between minor releases, the standard library is still in flux, the ecosystem around it is small, and bugs at the linker level surface as mysterious build failures that no one on the team has the context to debug. I use Zig in exactly one place, pinned to a specific version, as a linker behind cargo-zigbuild — not as a language I write code in. If that pinned version ever breaks under me, the fallback is installing target-specific gcc/g++ and configuring linker paths by hand, which is the same friction Go users never have.

### Compile times are real

A cold release build on a non-trivial controller is minutes, not seconds. I feel this on every release. I do not feel it during development because incremental compilation is fast, but the first build after a dependency bump is slow. I accept this as the cost of the guarantees I get.

### The Kubernetes ecosystem is Go-first

If a new CRD ships tomorrow, the Go types will exist first. The Rust equivalents may be behind by a release, or I may have to generate them myself from the OpenAPI schema. Most of the time this is a non-issue; occasionally it is friction.

### Smaller talent pool

If I hire an SRE to maintain one of these, "I know Go" is a much more common line on a resume than "I know Rust." This is a real cost and I am honest about it. The way I manage it: the addons are small. The total Rust surface area across all of them is probably under 15k lines. Someone who has never written Rust can learn enough to operate these in a week.

## What I'm not claiming

I am not claiming Rust is a better language in general. I am not claiming you should rewrite your Go services. I am not claiming this scales to hundred-person teams building application backends.

I am claiming something narrower: **for small, long-running, resource-constrained Kubernetes addons written by a small team that operates them forever, Rust beats Go on the axes that matter to operators** — image size, memory, crash class elimination, shutdown determinism. The tradeoffs are real and I take them knowingly: slower release builds, harder cross-compilation that requires a C toolchain and a tool like cargo-zigbuild, a Kubernetes ecosystem that ships Go types first and Rust types later, and a smaller hiring pool for the people who will eventually maintain this code.

The Unix philosophy — do one thing and do it well — fits Rust better than Go in this context. Go was built to build a big thing. Rust is built to build a small, correct thing that does not fall over. The addons I write are the second kind.

That is why they are all in Rust.
