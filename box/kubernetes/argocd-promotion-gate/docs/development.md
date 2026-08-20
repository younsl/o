# Development

## Overview

Where the code lives, what each package is allowed to depend on, how to run the gate against a real cluster, and the end to end tier. Also the tests that pin decisions which are easy to undo by accident.

For anyone changing the code. Behaviour and settings live in [docs/configuration.md](configuration.md) instead.

```bash
make          # fmt, vet, lint, test, build
make test     # go test -race ./...
make coverage # enforce the 70% floor
make fix      # go fix modernizations
```

## Layout

| Package | Responsibility | External deps |
| --- | --- | --- |
| `internal/gate` | the rules: chain, image parsing, verdict | none |
| `internal/config` | load and validate the config file | `yaml.v3` |
| `internal/argocd` | read Applications, resolve desired images | `client-go`, `net/http` |
| `internal/engine` | gather facts, delegate the verdict | the above |
| `internal/admission` | AdmissionReview in, verdict out | `internal/engine` |
| `internal/extension` | read-only API for the UI panel | `internal/engine` |
| `internal/observability` | Prometheus registry and metric set | `client_golang` |

`internal/gate` holds no I/O at all. Every fact a verdict depends on arrives in a `gate.Input`, which is why the rules are covered by table tests with no cluster and no fake client.

The engine exists so the webhook and the UI API cannot diverge. Both call `Engine.Evaluate`; neither has rules of its own.

## Running against a live cluster

The gate needs a serving certificate for the webhook listener, but the extension API and probes are plain HTTP, so the read paths can be exercised without one:

```bash
cat > /tmp/gate.yaml <<'EOF'
chain: [stage, prod]
gatedEnvs: [prod]
imageTag:
  enabled: false
EOF

go run ./cmd/argocd-promotion-gate \
  --config /tmp/gate.yaml \
  --kubeconfig ~/.kube/config \
  --log-format text --log-level debug &

curl -s 'localhost:8080/api/v1/gate?app=prod-payment-api' | jq
curl -s localhost:8080/api/v1/config | jq
```

The webhook listener fails to start without `--tls-cert-file` and `--tls-key-file`, which is the intended behaviour in-cluster. For a local self-signed pair:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=localhost' -keyout /tmp/tls.key -out /tmp/tls.crt
```

With `imageTag.enabled: true`, point `argocd.serverAddress` at a port-forwarded argocd-server and mint a token as described in [configuration.md](configuration.md).

## Exercising the webhook by hand

The endpoint takes an ordinary `AdmissionReview`, so a denial can be reproduced without touching Argo CD:

```bash
curl -sk https://localhost:8443/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "apiVersion": "admission.k8s.io/v1",
    "kind": "AdmissionReview",
    "request": {
      "uid": "test-1",
      "name": "prod-payment-api",
      "namespace": "argocd",
      "operation": "UPDATE",
      "userInfo": {"username": "system:serviceaccount:argocd:argocd-server"},
      "object": {
        "metadata": {"name": "prod-payment-api"},
        "spec": {"project": "prod"},
        "operation": {"sync": {}, "initiatedBy": {"username": "dev@example.com"}}
      },
      "oldObject": {"metadata": {"name": "prod-payment-api"}, "spec": {"project": "prod"}}
    }
  }' | jq
```

Drop the `operation` field from `object` and the response flips to an unconditional allow: that is the "not a sync request" path, which every status write from the application controller takes.

## Testing conventions

Table tests where the cases are genuinely parallel, named subtests otherwise. Assertions say what broke rather than dumping a struct, because the failure message is the only thing a future reader gets.

`internal/argocd`, `internal/admission`, `internal/engine`, and `internal/extension` use `dynamicfake` with `NewSimpleDynamicClientWithCustomListKinds`. The Application CRD is in no built-in scheme, so the list kind has to be declared:

```go
dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
    runtime.NewScheme(),
    map[schema.GroupVersionResource]string{argocd.ApplicationGVR: "ApplicationList"},
    objects...,
)
```

Tests worth keeping in mind when changing behaviour, because each pins a decision that is easy to undo by accident:

- `TestReaderGetNotFoundIsNotAnError` — a missing upstream must reach the gate as "absent", not as an error, or every app without a counterpart hits the `onError` policy.
- `TestEvaluateKubernetesFailureIsNotAMissingUpstream` — the reverse: a read failure must never be mistaken for an absent upstream, which would open the gate on any API hiccup.
- `TestEvaluateSkipsImageLookupWhenUpstreamAlreadyFails` — the remote call must not happen on a path that is already a denial.
- `TestDesiredImagesFailsWholeLookupOnPartialFailure` — a partial image list would let a mismatch through on the kind that failed to load.
- `TestHandlerFailsOpenOnMalformedInput` — the gate cannot judge what it cannot parse, and refusing everything would take all syncs down with it.

## End to end

`hack/e2e` drives a local kind cluster. Nothing in it touches the real kubeconfig: each mode writes its own `.kubeconfig-*` file, and every script refuses to run against a context that is not on localhost.

| Script | What it does |
| --- | --- |
| `up.sh` | cluster with the Application CRD, fixtures, and the gate. No Argo CD, because a running controller would keep rewriting the statuses the tests set |
| `test.sh` | the assertions, driven through real admission: denials, exemptions, the match conditions, the panel API agreeing with the webhook, the metrics |
| `tag-test.sh` | the image tag comparison, with the gate on the host and `stub-argocd-server.py` standing in for the one Argo CD route it calls |
| `up-argocd.sh` | a second cluster with a real Argo CD and the UI extension wired in, for pressing Sync by hand |
| `setup-rollback.sh` | drives that cluster to the state a rollback test starts from |
| `down.sh` | removes both clusters and their kubeconfigs |

```bash
hack/e2e/up.sh && hack/e2e/test.sh && hack/e2e/tag-test.sh
hack/e2e/down.sh
```

kind runs on podman when no docker daemon answers, which `common.sh` decides once and `down.sh` reuses so a teardown looks for node containers with the same engine. `BUILDER` and `KIND_EXPERIMENTAL_PROVIDER` override it.

## Release

Bump `org.opencontainers.image.version` in the `Dockerfile` and merge to `main`; the workflow builds and pushes to GHCR, skipping if the version already exists. Bump `version` in `charts/argocd-promotion-gate/Chart.yaml` to publish the chart.

Chart README is generated by helm-docs from `values.yaml` comments. Regenerate with `make -C ../charts docs` and never edit it directly.
