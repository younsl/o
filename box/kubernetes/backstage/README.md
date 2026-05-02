# Backstage with GitLab Discovery

[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Fyounsl%2Fbackstage-black?style=flat-square&logo=github&logoColor=white)](https://ghcr.io/younsl/backstage)
[![Backstage](https://img.shields.io/badge/Backstage-1.50.3-black?style=flat-square&logo=backstage&logoColor=white)](https://backstage.io)

Custom Backstage image with GitLab auto-discovery, Keycloak OIDC, and a set of in-house plugins.

## Quick Start

```bash
make init   # install deps
make dev    # frontend :3000, backend :7007
make build  # build container image
make run    # run container locally (requires .env)
```

Authentication is Keycloak OIDC only — guest login is disabled.

## Documentation

- [Plugins](docs/plugins.md) — full inventory of native, community, and custom plugins
- [Keycloak OIDC](docs/keycloak-oidc.md)
- [GitLab Discovery](docs/gitlab-discovery.md)
- [GitLab CI/CD](docs/gitlab-cicd.md)
- [GitLab API Discovery](docs/gitlab-api-discovery.md)
- [IAM User Audit](docs/iam-user-audit.md)
- [Kafka Topic](docs/kafka-topic.md)
- [OpenCost](docs/opencost.md) · [OpenCost ERD](docs/opencost-erd.md)
- [Helm Chart](docs/helm-chart.md)
