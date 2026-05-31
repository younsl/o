# Backstage with GitLab Discovery

[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Fyounsl%2Fbackstage-black?style=flat-square&logo=github&logoColor=white)](https://ghcr.io/younsl/backstage)
[![Backstage](https://img.shields.io/badge/Backstage-1.51.0-black?style=flat-square&logo=backstage&logoColor=white)](https://github.com/backstage/backstage/releases/tag/v1.51.0)

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
- [Keycloak OIDC](docs/keycloak-oidc.md)
- [GitLab Discovery](docs/gitlab-discovery.md)
- [GitLab CI/CD](docs/gitlab-cicd.md)
- [GitLab API Discovery](docs/gitlab-api-discovery.md)
- [IAM User Audit](docs/iam-user-audit.md)
- [Kafka Topic](docs/kafka-topic.md)
- [OpenCost](docs/opencost.md)
- [OpenCost ERD](docs/opencost-erd.md)
- [Helm Chart](docs/helm-chart.md)
