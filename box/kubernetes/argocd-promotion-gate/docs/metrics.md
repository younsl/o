# Metrics

## Overview

The three metrics the gate exposes, every value their labels can take, and the queries worth keeping. Also which metric answers which question, because the obvious one does not count what its name suggests.

For whoever builds the dashboard or the alerts. [docs/configuration.md](configuration.md) covers the settings these metrics report on.

The admin listener serves `/metrics` on port 8080, alongside `/healthz`, `/readyz`, and the UI extension API. The webhook port serves admission and nothing else, so a scrape never touches it.

The registry is the gate's own rather than the client library default, so the exposed series are limited to what this binary owns plus the standard Go runtime and process collectors.

```yaml
serviceMonitor:
  enabled: true
  interval: 30s
```

## The metric set

| Metric | Type | Labels | Incremented |
| --- | --- | --- | --- |
| `argocd_promotion_gate_decisions_total` | counter | `env`, `code`, `allowed` | once per verdict, from either the webhook or the panel API |
| `argocd_promotion_gate_admission_requests_total` | counter | `outcome` | once per AdmissionReview the API server sends |
| `argocd_promotion_gate_lookup_failures_total` | counter | `kind` | once per fact the gate could not read |

## What each label carries

`code` is the machine-readable reason, the same value the panel and the JSON API return.

| `code` | Meaning | Usual `allowed` |
| --- | --- | --- |
| `NotGated` | the environment is outside the chain or is its head | `true` |
| `Exempt` | the principal or the Application opted out | `true` |
| `Rollback` | the target revision was already deployed here | `true` |
| `UpstreamMissing` | no upstream Application exists for this identity | set by `gate.missingUpstream` |
| `UpstreamOutOfSync` | the upstream exists but is not `Synced` | `false` |
| `UpstreamUnhealthy` | the upstream is `Synced` but not `Healthy` | `false` |
| `ImageTagMismatch` | this sync would deploy a tag the upstream is not running | `false` in `enforce`, `true` in `warn` |
| `LookupFailed` | a fact the verdict needs could not be read | set by `gate.imageTag.onError` |
| `Passed` | every configured check passed | `true` |

`outcome` describes what the webhook did with an admission request.

| `outcome` | Meaning |
| --- | --- |
| `allowed` | the gate evaluated and let the sync through |
| `denied` | the gate evaluated and refused |
| `skipped` | not a sync, an exempt principal, or an automated operation, so no evaluation happened |
| `malformed` | the review could not be decoded. Allowed with a warning, because refusing what cannot be read would take all syncs down |

`kind` names the lookup that failed.

| `kind` | Meaning |
| --- | --- |
| `upstream` | reading the upstream Application from the Kubernetes API |
| `desired_images` | reading `managed-resources` from the Argo CD API |

## Decisions are not sync attempts

The panel calls the same engine the webhook does, which is what keeps the two from disagreeing, and every one of those calls counts in `decisions_total`. Opening an Application page therefore moves the counter without anybody pressing Sync.

So `decisions_total` measures verdicts, not deploys. For traffic that actually passed through admission, use `admission_requests_total`. Both are useful, as long as which one answers which question stays clear.

## No application label

Application identity is deliberately absent from every label. A denial costs one log line, but one time series per Application would outlive the Application itself.

The logs carry what the labels do not. Every verdict, allowed or denied, logs `app`, `namespace`, `principal`, `outcome`, `reason`, and `durationMs`, plus `initiatedBy` and `revision` when the operation names them. Denials go out at warn level.

```bash
kubectl -n argocd logs deploy/argocd-promotion-gate | jq 'select(.outcome == "denied")'
```

## Queries

What `enforce` would block, which is the number to watch during rollout:

```promql
sum by (env) (increase(argocd_promotion_gate_decisions_total{code="ImageTagMismatch", allowed="true"}[24h]))
```

Denials by environment and reason:

```promql
sum by (env, code) (rate(argocd_promotion_gate_decisions_total{allowed="false"}[1h]))
```

Share of admission requests that were refused:

```promql
sum(rate(argocd_promotion_gate_admission_requests_total{outcome="denied"}[1h]))
  / sum(rate(argocd_promotion_gate_admission_requests_total[1h]))
```

Lookups failing, which is usually a missing or expired Argo CD token rather than a promotion problem:

```promql
sum by (kind) (rate(argocd_promotion_gate_lookup_failures_total[15m])) > 0
```

## Worth alerting on

| Signal | Why it matters |
| --- | --- |
| `lookup_failures_total{kind="desired_images"}` rising | the Argo CD API or its token is broken, and `onError` is deciding every tag check |
| `lookup_failures_total{kind="upstream"}` rising | the gate cannot read Applications, so RBAC or the API server is the problem |
| `admission_requests_total{outcome="malformed"}` above zero | the gate is allowing syncs it could not parse |
| `decisions_total{code="LookupFailed"}` rising with `allowed="false"` | gated syncs are being refused for a reason that is not a promotion failure |

A quiet `admission_requests_total` is not an alert on its own. An estate that deploys a few times a day looks identical to a broken registration, so pair it with a synthetic sync or watch the webhook's own error rate instead.
