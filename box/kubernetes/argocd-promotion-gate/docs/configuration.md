# Configuration

The binary reads one YAML file, mounted from a ConfigMap the chart renders out of `.Values.gate`. Unknown keys are rejected at startup, so a misspelled setting fails the pod rather than silently disabling a check.

## Full example

```yaml
chain: [stage, prod]
gatedEnvs: [prod]

require:
  sync: true
  health: true

imageTag:
  enabled: true
  mode: warn
  kinds: [Deployment, StatefulSet, DaemonSet, CronJob, Rollout]
  ignoreRepos: []
  onError: deny

exempt:
  usernames:
    - system:serviceaccount:argocd:argocd-application-controller
  automated: true
  annotation: promotion-gate.younsl.github.io/skip

argocd:
  namespace: argocd
  serverAddress: https://argocd-server
  caFile: /etc/argocd-promotion-gate/argocd-ca/tls.crt
  insecureSkipVerify: false
  tokenPath: /etc/argocd-promotion-gate/token/token
  timeoutSeconds: 3
  cacheTtlSeconds: 30
```

`caFile` and `tokenPath` are set by the chart from `gate.argocd.caSecret` and `gate.argocd.tokenSecret`, so they never have to be repeated in values.

## The chain

`chain` is the promotion order, lowest environment first. The upstream of an environment is its predecessor, and the head has no upstream, so it is never gated.

```yaml
chain: [stage, prod]
```

| Environment | Upstream |
| --- | --- |
| `stage` | none, chain head |
| `prod` | `stage` |

A longer chain works the same way. `[dev, stage, prod]` makes `stage` wait on `dev` as well.

`gatedEnvs` narrows where the rules are enforced. An empty list means the whole chain except the head, which is the strictest reading. Listing only `prod` gates production and leaves everything below it alone.

An application with no counterpart in its upstream environment is always allowed to sync, and that is not configurable. It has nothing to be promoted from, so refusing it would leave it permanently undeployable rather than governed. A `stage` application that does not exist therefore does not stand in the way of its `prod` counterpart.

Validation rejects a chain shorter than two entries, duplicate entries, a `gatedEnvs` entry that is not in the chain, and a `gatedEnvs` entry that is the chain head. Each of those would otherwise produce a gate that either enforces nothing or can never be satisfied.

Environments outside the chain are never gated.

## Rollback

```yaml
rollback:
  allowPreviouslyDeployedRevision: true
```

A sync whose target revision this Application has already deployed is a rollback, and it is allowed before anything upstream is consulted. The revision ran here before, so it cannot introduce an image this environment has never run, and an incident must not depend on the upstream being healthy enough to satisfy a gate.

Two conditions have to hold. The target revision must appear in the Application's own `status.history`, and it must differ from the revision already live. Without the second test an Application whose revision is a chart version rather than a git commit would look like a rollback on every sync, because its revision does not change when its parameters do.

| Path | Verdict |
| --- | --- |
| Argo CD History and Rollback | allowed, code `Rollback` |
| `argocd app sync --revision <previously deployed>` | allowed |
| a `git revert` commit, then sync | treated as a promotion, because the revert is a new revision |
| any revision this environment has never deployed | treated as a promotion |

Argo CD's rollback deploys the historical manifests without changing `spec.source.targetRevision`, so the Application reads `OutOfSync` afterwards until the desired state is corrected in git. That commit is a new revision and goes through the gate normally, which leaves the emergency path fast and the permanent change governed.

Setting this to `false` puts rollbacks back under the image tag check, and the skip annotation becomes the only way through.

## Per-application opt-out

```bash
kubectl -n argocd annotate application prod-payment-api \
  promotion-gate.younsl.github.io/skip=true
```

The annotation is checked before any upstream lookup, so an opted-out app costs nothing. Only the exact string `true`, case-insensitive, counts.

## The Argo CD API token

Needed only when `imageTag.enabled` is true. The gate reads the upstream's *running* images straight from Kubernetes, but the images a pending sync *would* deploy exist only in Argo CD's cached comparison of git against the cluster.

Create a dedicated account with the narrowest possible RBAC:

```bash
# 1. Declare the account
kubectl -n argocd patch cm argocd-cm --type merge \
  -p '{"data":{"accounts.promotion-gate":"apiKey"}}'

# 2. Grant read-only access to applications
kubectl -n argocd patch cm argocd-rbac-cm --type merge -p '{"data":{"policy.csv":"
p, role:promotion-gate, applications, get, */*, allow
g, promotion-gate, role:promotion-gate
"}}'

# 3. Mint the token and store it
argocd account generate-token --account promotion-gate
kubectl -n argocd create secret generic argocd-promotion-gate-token \
  --from-literal=token=<token>
```

Patching `policy.csv` replaces it. Read the existing value first and append.

The Secret is mounted `optional: true`, so the pod starts without it. Every lookup then fails and `imageTag.onError` decides the verdict, which with the default `deny` means gated syncs are refused with a clear message. That is intentional: a gate that silently stops checking is worse than one that says it cannot check.

## TLS to argocd-server

Argo CD's self-signed serving certificate is its own issuer and carries SANs for `localhost` and `argocd-server` only. So:

- `serverAddress: https://argocd-server` verifies. The fully qualified `argocd-server.argocd.svc.cluster.local` does not, because it is not in the SAN list.
- `caSecret` points at `argocd-secret`, whose `tls.crt` is that certificate, which is enough to verify it.

`insecureSkipVerify: true` exists for clusters that terminate TLS elsewhere. Prefer not to use it: the token this client sends is a full Argo CD API credential, and skipping verification is what makes it interceptable.

## Rollout order

Enabling everything at once is the one way to make this component look broken. In an estate that has never enforced tag equality, most gated applications are not sitting on the upstream tag, and `enforce` blocks all of them on day one.

1. **Install with `imageTag.mode: warn`.** Upstream sync and health are enforced immediately; tag mismatches are only reported.
2. **Watch the metric.** `argocd_promotion_gate_decisions_total{code="ImageTagMismatch"}` counts what `enforce` would have blocked. The warning attached to each allowed sync names the repository and both tags.
3. **Populate `ignoreRepos`.** Sidecars that differ per environment by design (`nginx`, `autoinstrumentation-*`) belong here, not in the comparison.
4. **Switch to `enforce`** once the remaining mismatches are ones you actually want blocked.

To see the blast radius before installing anything, compare running tags directly:

```bash
kubectl -n argocd get applications -o json | jq -r '
  [ .items[]
    | select(.spec.project == "stage" or .spec.project == "prod")
    | { env: .spec.project,
        id: (.metadata.name | sub("^(stage|prod)-"; "")),
        imgs: [ (.status.summary.images // [])[]
                | sub("^.*/"; "") ] } ]
  | group_by(.id) | map(select(length == 2))
  | map({ id: .[0].id, tags: [ .[].imgs ] })
  | .[] | "\(.id)\t\(.tags)"'
```

## Failure policy

`webhook.failurePolicy: Fail` is the default because a gate that can be bypassed by taking one Deployment down is not a gate. It is only safe with more than one replica and a PodDisruptionBudget, which the chart also defaults to.

`Ignore` is the right choice if a gate outage blocking production deploys is worse for you than a promotion skipping a check.

## Match conditions

The chart generates CEL match conditions so the API server only calls the webhook for requests that could possibly be denied:

```yaml
matchConditions:
  - name: only-new-sync-operations
    expression: "has(object.operation) && (oldObject == null || !has(oldObject.operation))"
  - name: only-gated-projects
    expression: "has(object.spec) && has(object.spec.project) && object.spec.project in ['prod']"
  - name: not-system-serviceaccount-argocd-argocd-application-control
    expression: "request.userInfo.username != 'system:serviceaccount:argocd:argocd-application-controller'"
```

This matters at scale. Argo CD writes status to every Application constantly; without the first condition the webhook would be consulted on all of it. The handler re-checks every one of these conditions anyway, so a mistake in the registration cannot turn into a wrong verdict, only into wasted calls.

## Metrics

The admin listener serves `/metrics` on port 8080 alongside `/healthz` and `/readyz`.

| Metric | Labels |
| --- | --- |
| `argocd_promotion_gate_decisions_total` | `env`, `code`, `allowed` |
| `argocd_promotion_gate_admission_requests_total` | `outcome` |
| `argocd_promotion_gate_lookup_failures_total` | `kind` |

Application names are deliberately absent from the labels. A denial costs one log line, but one time series per Application would last forever.
