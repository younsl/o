# GitLab API Auto Discovery

Auto-discover and register APIs from GitLab repositories.

## How It Works

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  GitLab Repo    │     │  Backstage Provider  │     │  Backstage UI   │
│                 │     │                      │     │                 │
│ catalog-info.yaml ──▶ │  Scans every 30 min  │────▶│  API Catalog    │
│ openapi.yaml    │     │                      │     │  API Docs       │
└─────────────────┘     └──────────────────────┘     └─────────────────┘
```

1. Add `catalog-info.yaml` to your GitLab repo
2. Backstage scans every 30 minutes
3. API appears in Backstage catalog
4. View API spec in API Docs page

## Quick Start

### 1. Choose Template

| API Type | Spec File |
|----------|-----------|
| REST | `openapi.yaml` |
| Event-driven | `asyncapi.yaml` |
| GraphQL | `schema.graphql` |
| gRPC | `*.proto` |

### 2. Create catalog-info.yaml

Add to your GitLab repo root:

```yaml
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: my-service-api
  title: My Service API
  description: REST API for My Service
  annotations:
    gitlab.com/project-slug: my-group/my-service
  tags:
    - rest
spec:
  type: openapi
  lifecycle: production
  owner: team-backend
  definition:
    $text: ./openapi.yaml
```

### 3. Add API Spec File

Example `openapi.yaml`:

```yaml
openapi: 3.0.0
info:
  title: My Service API
  version: 1.0.0
paths:
  /users:
    get:
      summary: List users
      responses:
        '200':
          description: Success
```

### 4. Push to GitLab

```bash
git add catalog-info.yaml openapi.yaml
git commit -m "Add Backstage catalog info"
git push
```

### 5. Check in Backstage

- Wait up to 30 minutes (or restart Backstage)
- Go to Catalog > APIs
- Click API > Definition tab to view spec

## Link Component and API

Define which service provides or consumes APIs:

```yaml
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: user-api
spec:
  type: openapi
  lifecycle: production
  owner: team-backend
  definition:
    $text: ./openapi.yaml

---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: user-service
spec:
  type: service
  lifecycle: production
  owner: team-backend
  providesApis:
    - user-api
  consumesApis:
    - payment-api
```

## External API Spec URL

Load spec from external URL:

```yaml
spec:
  definition:
    $text: https://api.example.com/openapi.json
```

## Reference

### Lifecycle Values

| Value | Meaning |
|-------|---------|
| `development` | In development |
| `staging` | Test environment |
| `production` | Live |
| `deprecated` | No longer used |

### API Types

| Type | Format |
|------|--------|
| `openapi` | OpenAPI/Swagger |
| `asyncapi` | Kafka, RabbitMQ, WebSocket |
| `graphql` | GraphQL SDL |
| `grpc` | Protocol Buffers |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| API not showing | Check `catalog-info.yaml` filename and YAML syntax |
| Spec not loading | Verify `definition.$text` path is correct |
| Access denied | Check GitLab token has repo access |

### Manual Registration

Skip auto-scan and register now:

1. Backstage UI > Create > Register Existing Component
2. Enter GitLab URL: `https://gitlab.example.com/group/repo/-/blob/main/catalog-info.yaml`
