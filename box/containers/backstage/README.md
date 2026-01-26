# Backstage with GitLab Discovery

[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Fyounsl%2Fbackstage-black?style=flat-square&logo=github&logoColor=white)](https://ghcr.io/younsl/backstage)
[![Backstage](https://img.shields.io/badge/Backstage-1.47.1-black?style=flat-square&logo=backstage&logoColor=white)](https://backstage.io)

Custom Backstage image with GitLab Auto Discovery, Home dashboard, and API Docs plugins.

## Summary

This is a production-ready Backstage container image designed for internal developer portals. It provides a centralized platform where developers can discover services, view API documentation, and access technical docs across your organization.

### Key Highlights

- **Service Catalog**: Auto-discover and register all services from GitLab repositories
- **Home Dashboard**: Personalized landing page with quick access to frequently used resources
- **API Documentation**: View OpenAPI, AsyncAPI, and GraphQL specs in one place
- **TechDocs**: Markdown-based documentation rendered beautifully
- **GitLab Integration**: Seamless sync with GitLab groups, users, and repositories

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Backstage                              │
├─────────────────────────────────────────────────────────────┤
│  Frontend (React)           │  Backend (Node.js)            │
│  ├─ Home Dashboard          │  ├─ Catalog API               │
│  ├─ Service Catalog         │  ├─ GitLab Discovery          │
│  ├─ API Docs Viewer         │  ├─ Search Indexer            │
│  ├─ TechDocs Reader         │  ├─ TechDocs Builder          │
│  └─ Scaffolder UI           │  └─ Scaffolder Backend        │
├─────────────────────────────────────────────────────────────┤
│                     External Services                       │
│  ├─ GitLab (source of truth)                                │
│  ├─ PostgreSQL (catalog database)                           │
│  └─ S3/GCS (TechDocs storage - optional)                    │
└─────────────────────────────────────────────────────────────┘
```

## Version

| Component | Version |
|-----------|---------|
| [Backstage](https://github.com/backstage/backstage/releases/tag/v1.47.1) | 1.47.1 |
| Node.js | 24.x |
| Yarn | 4.x (Berry) |
| @backstage/cli | 0.35.2 |

## Features

| Feature | Plugin | Description |
|---------|--------|-------------|
| Home Dashboard | `plugin-home` | Customizable home page with widgets |
| GitLab Auto Discovery | `plugin-catalog-backend-module-gitlab` | Auto-discover `catalog-info.yaml` from GitLab repos |
| GitLab Org Sync | `plugin-catalog-backend-module-gitlab-org` | Sync GitLab groups/users to Backstage |
| API Docs | `plugin-api-docs` | OpenAPI, AsyncAPI, GraphQL spec viewer |
| TechDocs | `plugin-techdocs` | Markdown-based technical documentation |
| Scaffolder | `plugin-scaffolder` | Template-based project creation |
| Search | `plugin-search` | Full-text search across catalog |

### Home Dashboard Widgets

| Widget | Description |
|--------|-------------|
| WelcomeTitle | Time-based greeting (Good morning/afternoon/evening) |
| HeaderWorldClock | World clock (Seoul, UTC) |
| SearchBar | Global search |
| QuickLinks | Shortcuts to Catalog, APIs, Docs, Create |
| StarredEntities | Bookmarked components |
| RecentlyVisited | Recently visited entities |
| TopVisited | Most frequently visited entities |
| FeaturedDocsCard | Components with TechDocs |

## Quick Start

### Build

```bash
# Auto-detect container runtime (podman preferred, fallback to docker)
make build

# Explicitly specify runtime
make build CONTAINER_RUNTIME=docker
make build CONTAINER_RUNTIME=podman
```

### Run Locally

```bash
# Option 1: Using .env file
cat > .env << EOF
GITLAB_HOST=gitlab.com
GITLAB_TOKEN=glpat-xxxxxxxxxxxx
EOF
make run

# Option 2: Export environment variables
export GITLAB_HOST=gitlab.com
export GITLAB_TOKEN=glpat-xxxxxxxxxxxx
make run
```

Open http://localhost:7007 in your browser.

### Push to Registry (Manual)

```bash
make push REGISTRY=ghcr.io/your-org
```

### Release via GitHub Actions (Recommended)

Auto-release by pushing a tag:

```bash
git tag backstage/1.47.0
git push origin backstage/1.47.0
```

Or trigger manually via `workflow_dispatch` in GitHub Actions.

## Helm Chart Integration

This custom image is compatible with the official [Backstage Helm Chart](https://github.com/backstage/charts). Simply replace the image reference in your values file.

> **Note**: This image does not include config files (app-config.yaml).
> Inject configuration using the chart's `appConfig`.

```yaml
# values.yaml
backstage:
  image:
    registry: ghcr.io
    repository: your-org/backstage
    tag: latest

  args:
    - "--config"
    - "/app/config/app-config.yaml"

  appConfig:
    app:
      title: Backstage
      baseUrl: https://backstage.example.com

    backend:
      baseUrl: https://backstage.example.com
      listen:
        port: 7007
      database:
        client: pg
        connection:
          host: ${POSTGRES_HOST}
          port: ${POSTGRES_PORT}
          user: ${POSTGRES_USER}
          password: ${POSTGRES_PASSWORD}

    integrations:
      gitlab:
        - host: ${GITLAB_HOST}
          token: ${GITLAB_TOKEN}

    catalog:
      providers:
        gitlab:
          default:
            host: ${GITLAB_HOST}
            branch: main
            fallbackBranch: master
            schedule:
              frequency: { minutes: 30 }
              timeout: { minutes: 3 }
              initialDelay: { seconds: 10 }

  extraEnvVars:
    - name: GITLAB_HOST
      value: "gitlab.com"
    - name: GITLAB_TOKEN
      valueFrom:
        secretKeyRef:
          name: backstage-secrets
          key: gitlab-token
    - name: POSTGRES_HOST
      value: "backstage-postgresql"
    - name: POSTGRES_PORT
      value: "5432"
    - name: POSTGRES_USER
      valueFrom:
        secretKeyRef:
          name: backstage-secrets
          key: postgres-user
    - name: POSTGRES_PASSWORD
      valueFrom:
        secretKeyRef:
          name: backstage-secrets
          key: postgres-password
```

### Install with Helm

Create namespace and secret for sensitive values (e.g., GitLab token, PostgreSQL credentials):

```bash
kubectl create namespace backstage
kubectl create secret generic backstage-secrets \
  --namespace backstage \
  --from-literal=gitlab-token=glpat-xxxxxxxxxxxx \
  --from-literal=postgres-user=backstage \
  --from-literal=postgres-password=changeme
```

Install Backstage using the official Helm chart:

```bash
helm repo add backstage https://backstage.github.io/charts
helm install backstage backstage/backstage \
  --namespace backstage \
  -f values.yaml
```

## Configuration

### GitLab Discovery

Configure GitLab discovery in `app-config.yaml`:

```yaml
catalog:
  providers:
    gitlab:
      yourProviderId:
        host: ${GITLAB_HOST}
        branch: main
        fallbackBranch: master
        # Scan specific group only
        # group: my-team
        schedule:
          frequency: { minutes: 1 }
          timeout: { minutes: 3 }
          initialDelay: { seconds: 10 }
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITLAB_HOST` | Yes | GitLab host (e.g., `gitlab.com`) |
| `GITLAB_TOKEN` | Yes | GitLab Personal Access Token (requires `api` scope) |
| `BACKSTAGE_BASE_URL` | Production | External Backstage URL |

## GitLab Repository Setup

Add `catalog-info.yaml` to your GitLab repositories for auto-discovery.

### Component Example

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: my-service
  description: My awesome microservice
  annotations:
    gitlab.com/project-slug: my-group/my-service
spec:
  type: service
  lifecycle: production
  owner: platform-team
```

### API Spec Example

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: my-service
  description: My service with API docs
spec:
  type: service
  lifecycle: production
  owner: platform-team
  providesApis:
    - my-service-api
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: my-service-api
  description: My Service REST API
spec:
  type: openapi
  lifecycle: production
  owner: platform-team
  definition:
    $text: ./openapi.yaml
```

### Supported API Types

| Type | Spec Format |
|------|-------------|
| `openapi` | OpenAPI 3.x / Swagger 2.0 |
| `asyncapi` | AsyncAPI 2.x |
| `graphql` | GraphQL SDL |
| `grpc` | Protocol Buffers |

## Project Structure

```
backstage/
├── Dockerfile
├── Makefile
├── package.json
├── app-config.yaml              # Default config
├── app-config.production.yaml   # Production overrides
├── tsconfig.json
└── packages/
    ├── app/                     # Frontend
    │   ├── package.json
    │   └── src/
    │       ├── App.tsx
    │       └── components/
    │           ├── Root/
    │           └── home/        # Home dashboard
    └── backend/                 # Backend
        ├── package.json
        └── src/
            └── index.ts         # Plugin registration
```

## Development

### Local Development (without container)

```bash
# Install dependencies
make init

# Run dev server
make dev
```

### Available Make Targets

```bash
make help           # Show help
make runtime-info   # Show detected container runtime
make init           # yarn install
make dev            # Local dev server
make build          # Build container image
make build-nocache  # Build without cache
make push           # Push to registry
make run            # Run container locally
make clean          # Remove build artifacts
```

## Ports

| Port | Description |
|------|-------------|
| 7007 | Backstage Backend (production) |
| 3000 | Frontend dev server (development only) |

In production, only expose port 7007.
