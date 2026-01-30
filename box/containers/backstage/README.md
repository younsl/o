# Backstage with GitLab Discovery

[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Fyounsl%2Fbackstage-black?style=flat-square&logo=github&logoColor=white)](https://ghcr.io/younsl/backstage)
[![Backstage](https://img.shields.io/badge/Backstage-1.47.1-black?style=flat-square&logo=backstage&logoColor=white)](https://backstage.io)

Custom Backstage image with GitLab Auto Discovery, Keycloak OIDC, and API Docs plugins.

## Features

| Feature | Plugin | Native | Description |
|---------|--------|:------:|-------------|
| Home Dashboard | `plugin-home` | Yes | Customizable home page with widgets |
| Platforms | - | No | Internal platform services link cards with search and tag filtering |
| GitLab Auto Discovery | `plugin-catalog-backend-module-gitlab` | Yes | Auto-discover `catalog-info.yaml` from GitLab repos |
| GitLab Org Sync | `plugin-catalog-backend-module-gitlab-org` | Yes | Sync GitLab groups/users to Backstage |
| OIDC Authentication | `plugin-auth-backend-module-oidc-provider` | Yes | Keycloak/OIDC SSO authentication |
| API Docs | `plugin-api-docs` | Yes | OpenAPI, AsyncAPI, GraphQL spec viewer |
| OpenAPI Registry | `openapi-registry` | No | Register external OpenAPI specs by URL with search and filters |
| TechDocs | `plugin-techdocs` | Yes | Markdown-based technical documentation |
| Scaffolder | `plugin-scaffolder` | Yes | Template-based project creation |
| Search | `plugin-search` | Yes | Full-text search across catalog |

## Quick Start

### Build & Run

```bash
# Build container image
make build

# Run locally (requires .env file)
cat > .env << EOF
GITLAB_HOST=gitlab.com
GITLAB_TOKEN=glpat-xxxxxxxxxxxx
EOF
make run
```

Open http://localhost:7007

### Development

```bash
make init   # Install dependencies
make dev    # Run dev server (localhost:3000)
```

### Release

```bash
git tag backstage/1.48.0
git push origin backstage/1.48.0
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITLAB_HOST` | Yes | GitLab host |
| `GITLAB_TOKEN` | Yes | GitLab Personal Access Token |
| `KEYCLOAK_CLIENT_ID` | OIDC | Keycloak client ID |
| `KEYCLOAK_CLIENT_SECRET` | OIDC | Keycloak client secret |
| `KEYCLOAK_METADATA_URL` | OIDC | OIDC metadata URL |
| `AUTH_SESSION_SECRET` | OIDC | Session secret (min 32 chars) |

## Documentation

- [Keycloak OIDC](docs/keycloak-oidc.md) - SSO authentication with Keycloak
- [GitLab Discovery](docs/gitlab-discovery.md) - Auto-discover services from GitLab
- [GitLab API Discovery](docs/gitlab-api-discovery.md) - Auto-register APIs from GitLab
- [Helm Chart](docs/helm-chart.md) - Kubernetes deployment with Helm

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Backstage                              │
├─────────────────────────────────────────────────────────────┤
│  Frontend (React)           │  Backend (Node.js)            │
│  ├─ Home Dashboard          │  ├─ Catalog API               │
│  ├─ Service Catalog         │  ├─ GitLab Discovery          │
│  ├─ API Docs Viewer         │  ├─ Search Indexer            │
│  ├─ OpenAPI Registry        │  ├─ OpenAPI Registry API      │
│  ├─ TechDocs Reader         │  ├─ TechDocs Builder          │
│  └─ Scaffolder UI           │  └─ Scaffolder Backend        │
├─────────────────────────────────────────────────────────────┤
│                     External Services                       │
│  ├─ GitLab (source of truth)                                │
│  ├─ Keycloak (OIDC authentication - optional)               │
│  ├─ PostgreSQL (catalog database)                           │
│  └─ S3/GCS (TechDocs storage - optional)                    │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
backstage/
├── docs/                        # Documentation
│   ├── keycloak-oidc.md
│   ├── gitlab-discovery.md
│   ├── gitlab-api-discovery.md
│   └── helm-chart.md
├── packages/
│   ├── app/                     # Frontend
│   └── backend/                 # Backend
├── plugins/
│   ├── openapi-registry/        # OpenAPI Registry frontend plugin
│   └── openapi-registry-backend/# OpenAPI Registry backend plugin
├── templates/
│   └── register-component/      # Scaffolder template for catalog-info.yaml
├── app-config.yaml              # Default config
├── app-config.local.yaml        # Local overrides
├── values.yaml                  # Helm chart values
├── Dockerfile
└── Makefile
```

## Platforms

Internal platform services page for developers to discover tools and services.

**Features:**
- Card-based UI with platform logos
- Category grouping (Developer Portal, Observability, CI/CD, Security, Infrastructure, Data, Registry, Documentation)
- Favorites (즐겨찾기) - starred platforms appear at the top, persisted in localStorage
- Text search across name, description, category, tags
- Tag-based filtering (multi-select)
- Clickable cards open in new tab
- VPN warning badge for platforms with `prd` tag

**Configuration:**

Platforms are configured via `app-config.yaml` or Helm values:

```yaml
app:
  platforms:
    - name: Grafana
      category: Observability
      description: 메트릭 시각화 및 대시보드
      url: https://grafana.example.com
      logo: https://cdn.jsdelivr.net/gh/grafana/grafana@main/public/img/grafana_icon.svg
      tags: shared,kubernetes
```

For local development, override in `app-config.local.yaml` (gitignored).

## OpenAPI Registry

Custom plugin for registering external OpenAPI specs without `catalog-info.yaml`.

**Features:**
- Protocol selection (https/http)
- Spec preview before registration
- Search by name, title, or owner
- Filter by Lifecycle and Owner
- Refresh spec from source URL
- Delete registration

**Workflow:**
1. Enter OpenAPI spec URL → Preview
2. Fill metadata (name, owner, lifecycle, tags)
3. Register → Auto-sync to Catalog

## Authentication

Authentication is configured via Keycloak OIDC. Guest login is **disabled in production**.

> **Note:** Backstage does not support dynamically enabling/disabling guest login via config.
> The `guest` provider in `SignInPage` (`packages/app/src/App.tsx`) is hardcoded in frontend.
> To enable guest login, add `'guest'` to the providers array and rebuild the image.
> See [Guest Authentication Provider](https://backstage.io/docs/auth/guest/provider/) for details.

## Ports

The container image is **monolithic** - backend serves the built frontend on a single port.

| Port | Environment | Description |
|------|-------------|-------------|
| 7007 | Production | Backend + Frontend (single port) |
| 3000 | Development | Frontend dev server with hot reload |
| 7007 | Development | Backend API server |

In production, only expose port **7007**. The frontend is bundled and served by the backend.
