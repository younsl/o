# Backstage with GitLab Discovery

[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Fyounsl%2Fbackstage-black?style=flat-square&logo=github&logoColor=white)](https://ghcr.io/younsl/backstage)
[![Backstage](https://img.shields.io/badge/Backstage-1.52.1-black?style=flat-square&logo=backstage&logoColor=white)](https://github.com/backstage/backstage/releases/tag/v1.52.1)

Custom Backstage image with GitLab auto-discovery, Keycloak OIDC, and in-house plugins built on [Backstage UI](https://backstage.io/docs/getting-started/ui) (BUI). Optimized for the official [Backstage Helm chart](https://github.com/backstage/charts): just swap the image.

## Quick Start

```bash
make init   # install deps
make dev    # frontend :3000, backend :7007
make build  # build container image
make run    # run container locally (requires .env)
```

Authentication is Keycloak OIDC only. Guest login is disabled.

## Documentation

- [Installation](docs/installation.md)
- [Plugins](docs/plugins.md)
- [Helm Chart](docs/helm-chart.md)

### Plugin Docs

- [Keycloak OIDC](docs/plugins/auth-backend-module-oidc-provider/overview.md)
- [GitLab Discovery](docs/plugins/catalog-backend-module-gitlab/discovery.md)
- [GitLab API Discovery](docs/plugins/catalog-backend-module-gitlab/api-discovery.md)
- [GitLab CI/CD](docs/plugins/gitlab/overview.md)
- [IAM User Audit](docs/plugins/iam-user-audit/overview.md)
- [Kafka Topic](docs/plugins/kafka-topic/overview.md)
- [OpenCost](docs/plugins/opencost/overview.md)
- [OpenCost ERD](docs/plugins/opencost/erd.md)
- [Grafana Dashboard Map ERD](docs/plugins/grafana-dashboard-map/erd.md)
- [OpenSearch Account](docs/plugins/opensearch-account/overview.md)
