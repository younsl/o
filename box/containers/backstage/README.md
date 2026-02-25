# Backstage with GitLab Discovery

[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Fyounsl%2Fbackstage-black?style=flat-square&logo=github&logoColor=white)](https://ghcr.io/younsl/backstage)
[![Backstage](https://img.shields.io/badge/Backstage-1.47.3-black?style=flat-square&logo=backstage&logoColor=white)](https://backstage.io)

Custom Backstage image with GitLab Auto Discovery, Keycloak OIDC, and API Docs plugins.

## Features

| Feature | Plugin | Type | Description |
|---------|--------|:----:|-------------|
| Home Dashboard | [`@backstage/plugin-home`](https://www.npmjs.com/package/@backstage/plugin-home) | Native | Customizable home page with widgets |
| Platforms | - | Custom† | Internal platform services link cards with search and tag filtering |
| GitLab Auto Discovery | [`@backstage/plugin-catalog-backend-module-gitlab`](https://www.npmjs.com/package/@backstage/plugin-catalog-backend-module-gitlab) | Native | Auto-discover `catalog-info.yaml` from GitLab repos |
| GitLab Org Sync | [`@backstage/plugin-catalog-backend-module-gitlab-org`](https://www.npmjs.com/package/@backstage/plugin-catalog-backend-module-gitlab-org) | Native | Sync GitLab groups/users to Backstage |
| GitLab CI/CD | [`@immobiliarelabs/backstage-plugin-gitlab`](https://www.npmjs.com/package/@immobiliarelabs/backstage-plugin-gitlab) | Community | View pipelines, MRs, releases, README on Entity page |
| SonarQube | [`@backstage-community/plugin-sonarqube`](https://www.npmjs.com/package/@backstage-community/plugin-sonarqube) | Community | Code quality metrics with auto annotation injection |
| OIDC Authentication | [`@backstage/plugin-auth-backend-module-oidc-provider`](https://www.npmjs.com/package/@backstage/plugin-auth-backend-module-oidc-provider) | Native | Keycloak/OIDC SSO authentication |
| API Docs | [`@backstage/plugin-api-docs`](https://www.npmjs.com/package/@backstage/plugin-api-docs) | Native | OpenAPI, AsyncAPI, GraphQL spec viewer |
| OpenAPI Registry | `openapi-registry` | Custom† | Register external OpenAPI specs by URL with search and filters |
| ArgoCD AppSets | `argocd-appset` | Custom† | View and manage ArgoCD ApplicationSets with mute/unmute and Slack alerts |
| TechDocs | [`@backstage/plugin-techdocs`](https://www.npmjs.com/package/@backstage/plugin-techdocs) | Native | Markdown-based technical documentation |
| Scaffolder | [`@backstage/plugin-scaffolder`](https://www.npmjs.com/package/@backstage/plugin-scaffolder) | Native | Template-based project creation |
| Search | [`@backstage/plugin-search`](https://www.npmjs.com/package/@backstage/plugin-search) | Native | Full-text search across catalog |
| Simple Icons | [`@dweber019/backstage-plugin-simple-icons`](https://www.npmjs.com/package/@dweber019/backstage-plugin-simple-icons) | Community | Brand icons from [simpleicons.org](https://simpleicons.org/) for sidebar and links |

† Custom plugins currently use legacy `@backstage/core-components` with Material-UI v4. Migration to [`@backstage/ui`](https://www.npmjs.com/package/@backstage/ui) is recommended as `@backstage/core-components` will be deprecated in favor of the new design system.

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
| `SONARQUBE_URL` | SonarQube | SonarQube server URL |
| `SONARQUBE_TOKEN` | SonarQube | SonarQube API token |
| `KEYCLOAK_CLIENT_ID` | OIDC | Keycloak client ID |
| `KEYCLOAK_CLIENT_SECRET` | OIDC | Keycloak client secret |
| `KEYCLOAK_METADATA_URL` | OIDC | OIDC metadata URL |
| `AUTH_SESSION_SECRET` | OIDC | Session secret (min 32 chars) |
| `K8S_SA_TOKEN` | ArgoCD AppSet | Kubernetes service account token |
| `SLACK_WEBHOOK_URL` | ArgoCD AppSet | Slack Incoming Webhook URL for alerts |

## Documentation

- [Keycloak OIDC](docs/keycloak-oidc.md) - SSO authentication with Keycloak
- [GitLab Discovery](docs/gitlab-discovery.md) - Auto-discover services from GitLab
- [GitLab CI/CD](docs/gitlab-cicd.md) - View pipelines, MRs, releases on Entity page
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
│  ├─ GitLab CI/CD Tab        │  ├─ GitLab CI/CD API          │
│  ├─ API Docs Viewer         │  ├─ Search Indexer            │
│  ├─ OpenAPI Registry        │  ├─ OpenAPI Registry API      │
│  ├─ ArgoCD AppSets          │  ├─ ArgoCD AppSet API         │
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
│   ├── argocd-appset/           # ArgoCD AppSet frontend plugin
│   ├── argocd-appset-backend/   # ArgoCD AppSet backend plugin
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
- Audit logging via Backstage Auditor Service

**Workflow:**
1. Enter OpenAPI spec URL → Preview
2. Fill metadata (name, owner, lifecycle, tags)
3. Register → Auto-sync to Catalog

**Audit Logging:**

Data-modifying operations are logged via Backstage's built-in Auditor Service.

Audit target criteria:
- **Audited**: Data-modifying operations (Create, Update, Delete)
- **Not audited**: Read-only operations (List, Get, Health check)

Audit logs include `isAuditEvent=true` for easy filtering and capture actor info (IP, User-Agent), request details, and success/failure status.

## SonarQube

Code quality integration with automatic annotation injection.

**Features:**
- Auto-inject `sonarqube.org/project-key` from GitLab project slug or entity name
- Auto-inject `sonarqube.org/base-url` from app-config.yaml
- Real-time connection status badge (Connected/Not connected)
- Source indicator badge (AUTO/MANUAL)
- YAML-formatted annotation viewer

**Auto Annotation Injection:**

The `SonarQubeAnnotationProcessor` automatically adds SonarQube annotations to Component entities:

| Annotation | Source | Description |
|------------|--------|-------------|
| `sonarqube.org/project-key` | GitLab slug or entity name | SonarQube project key |
| `sonarqube.org/project-key-source` | `auto-injected` or `manual` | How the key was set |
| `sonarqube.org/base-url` | app-config.yaml | SonarQube server URL |
| `sonarqube.org/base-url-source` | `auto-injected` or `manual` | How the URL was set |

**Configuration:**

```yaml
# app-config.yaml
sonarqube:
  baseUrl: https://sonarqube.example.com
  apiKey: ${SONARQUBE_TOKEN}
```

## Authentication

Authentication is configured via Keycloak OIDC with [redirect flow](https://backstage.io/docs/auth/oauth/). For better user experience, [`enableExperimentalRedirectFlow`](https://backstage.io/docs/auth/#sign-in-configuration) is enabled to use in-window redirect instead of the default popup on auto sign-in.

**Flow:** Backstage → `SignInPage` auto trigger → Keycloak login (redirect) → Backstage home

**Config (`app-config.yaml`):**

```yaml
enableExperimentalRedirectFlow: true
```

> **Note:** `enableExperimentalRedirectFlow` applies to the `auto` sign-in path only.
> If auto sign-in fails (e.g., Keycloak outage), the sign-in page shows a Keycloak button as fallback.
> Clicking the button uses popup, which is the standard Backstage behavior.
> See [Backstage Auth documentation](https://backstage.io/docs/auth/) for details.

## Ports

The container image is **monolithic** - backend serves the built frontend on a single port.

| Port | Environment | Description |
|------|-------------|-------------|
| 7007 | Production | Backend + Frontend (single port) |
| 3000 | Development | Frontend dev server with hot reload |
| 7007 | Development | Backend API server |

In production, only expose port **7007**. The frontend is bundled and served by the backend.
