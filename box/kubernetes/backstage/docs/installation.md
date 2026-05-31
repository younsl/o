---
plugins: []
---

# Installation

This guide walks platform engineers through deploying the custom Backstage image to a Kubernetes cluster. It assumes you already have a cluster, Helm, and a PostgreSQL database available.

There is no custom chart. Install with the official [Backstage Helm chart](https://github.com/backstage/charts) and only swap the image for this one.

## Minimal values.yaml

Override only the image block so the official chart pulls this custom image instead of the upstream default. Everything else falls back to the chart defaults. Pin the tag to a released version in production rather than latest.

```yaml
backstage:
  image:
    registry: ghcr.io
    repository: younsl/backstage
    tag: latest
```

## Secrets

Backstage reads every credential from environment variables at runtime, so secrets never live in values.yaml. The full set is large because each plugin adds its own keys (Grafana, SonarQube, Slack, OpenCost, and more). To keep this guide manageable, only the keys required to boot and log in are listed here. Plugin-specific keys are documented in their own pages and are added the same way once you enable the feature.

### Boot minimum

These keys are needed for the backend to start, authenticate through Keycloak, and run GitLab discovery. Everything else is optional.

```bash
kubectl create namespace backstage

kubectl create secret generic backstage-secrets \
  --namespace backstage \
  --from-literal=postgres-user=backstage \
  --from-literal=postgres-password=changeme \
  --from-literal=gitlab-token=glpat-xxxxxxxxxxxx \
  --from-literal=keycloak-client-secret=xxxxxxxxxxxx \
  --from-literal=auth-session-secret=$(openssl rand -base64 32)
```

Plugin keys (Grafana, SonarQube, Slack, OpenCost, IAM audit) are covered in [Plugins](plugins.md) and the per-feature docs. Add them as extra entries in the same Secret only when you turn the plugin on.

### Managing secrets on AWS

Creating and rotating this many keys by hand does not scale. On EKS, manage them with the [External Secrets Operator](https://external-secrets.io). Store the values once in AWS Secrets Manager or SSM Parameter Store, then sync them into the backstage-secrets Secret with a single ExternalSecret resource. This keeps the source of truth in AWS, handles rotation automatically, and lets you add new plugin keys without re-running kubectl.

## Install with Helm

This image is developed to be compatible with the official Backstage Helm chart (the [backstage chart](https://github.com/backstage/charts/tree/main/charts/backstage) from the [backstage/charts](https://github.com/backstage/charts) repository), so no custom chart is required. Add the official chart repository, then install the release with your values.yaml. Re-run the same command with helm upgrade to apply later changes.

```bash
helm repo add backstage https://backstage.github.io/charts

helm install backstage backstage/backstage \
  --namespace backstage \
  -f values.yaml
```

## Next Steps

See [Helm Chart](helm-chart.md) for the full values, secrets, and Keycloak OIDC setup.
