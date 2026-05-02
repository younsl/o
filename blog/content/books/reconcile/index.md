---
title: "reconcile"
date: 2026-04-26T00:00:00+09:00
updated: 2026-04-27T00:00:00+09:00
description: "Best practices for keeping Kubernetes alive. One card. One principle."
keywords: []
tags: ["kubernetes", "devops"]
template: "zine.html"
---

{% card(kind="cover", title="reconcile", author="Younsung Lee", author_url="https://github.com/younsl") %}
![An abstract black background with wavy lines](1.jpg)

<small>Photo by [Pawel Czerwinski](https://unsplash.com/@pawel_czerwinski) on Unsplash</small>
{% end %}

{% card(title="Best practices for keeping Kubernetes alive.") %}
*One card. One principle.*
{% end %}

{% card(title="Define your resources") %}
No requests? The scheduler guesses where to put you.
No limits? One pod eats the whole node.

CPU limits — handle with care. Throttling kills latency.
{% end %}

{% card(title="Separate your probes") %}
Readiness blocks traffic. Liveness kills the container.

If your app boots slow and only liveness fires, you'll loop forever. Use a `startupProbe`.
{% end %}

{% card(title=":latest is a trap") %}
Moving tags break rollback. Same manifest, different image. Not reproducible.

Pin to SHA digest when you can — it catches supply-chain tampering too.
{% end %}

{% card(title="PDB is your insurance") %}
Node drains happen every week. No PodDisruptionBudget means cluster upgrades become outages.

At minimum: `minAvailable: 1`.
{% end %}

{% card(title="RBAC: least privilege") %}
`cluster-admin` on the default ServiceAccount is suicide.

One SA per workload. Only the verbs you need. Wildcards get revoked the moment debugging ends.
{% end %}

{% card(title="Spread your pods") %}
Three replicas on one node? Availability is fiction.

Use `topologySpreadConstraints` to scatter across nodes and zones.
{% end %}

{% card(title="Run as non-root") %}
- `runAsNonRoot: true`
- `readOnlyRootFilesystem: true`
- `capabilities.drop: [ALL]`

Half of container-escape incidents close with these three lines.
{% end %}

{% card(title="Default deny") %}
Without NetworkPolicy, every pod can reach every pod. A highway for lateral movement.

Default deny per namespace. Open by allow-list.
{% end %}

{% card(title="Native admission policy first") %}
[ValidatingAdmissionPolicy](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/) and [MutatingAdmissionPolicy](https://kubernetes.io/docs/reference/access-authn-authz/mutating-admission-policy/) ship with the API server. CEL expressions evaluated in-tree — no controller pod, no admission webhook to keep healthy.

Reach for [Kyverno](https://kyverno.io/) only when you need cross-resource mutation, image verification, or report generation the natives don't cover.
{% end %}

{% card(title="Don't store secrets in plaintext") %}
A secret committed to Git is a secret leaked forever. Plain Kubernetes Secrets in etcd aren't much better — base64 isn't encryption.

Keep the source of truth in [HashiCorp Vault](https://www.vaultproject.io/) (or your cloud secrets manager) and sync into the cluster with [External Secrets Operator](https://external-secrets.io/).

Then turn on etcd encryption at rest for what's already inside.
{% end %}

{% card(title="Log to stdout") %}
Write to a file → sidecars, rotation, full disks.

[12-factor](https://12factor.net/logs): write to stdout. Collection is infrastructure's job.
{% end %}

{% card(title="One stack, not five charts") %}
Prometheus, Alertmanager, Grafana, kube-state-metrics, node-exporter — wiring them as five separate Helm releases means version drift and broken ServiceMonitor references.

[kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) ships them as one tested bundle, glued together by the Prometheus Operator.

*Override what you need. Let the rest stay in sync.*
{% end %}

{% card(title="Lower your ndots") %}
The default `ndots: 5` tries five search domains before resolving an external name. DNS traffic balloons. So does latency.

![CoreDNS total request volume reduced by 56% after lowering ndots](ndots-before-after.png)

<small>On a cluster with 7 nodes and ~130 pods, switching ArgoCD from `ndots: 5` to `ndots: 2` cut total DNS query volume by 56%.</small>

For most workloads, `dnsConfig.options.ndots: 2` is enough. Pair it with [NodeLocal DNSCache](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/) to keep lookups on the node and shave off the round-trip to CoreDNS.
{% end %}

{% card(title="Deploy with GitOps") %}
`kubectl apply` trusts human hands.

Put desired state in Git, let ArgoCD or Flux reconcile. The cluster converges, no questions asked.
{% end %}

{% card(kind="end", title="That's it.") %}
The principles are simple. *Living by them isn't.*
{% end %}
