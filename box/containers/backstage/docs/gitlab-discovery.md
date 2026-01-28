# GitLab Discovery

Auto-discover `catalog-info.yaml` files from GitLab repositories.

## Configuration

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
        skipForkedRepos: false
        entityFilename: catalog-info.yaml
        schedule:
          frequency: { minutes: 1 }
          timeout: { minutes: 3 }
          initialDelay: { seconds: 10 }

    # Sync GitLab groups/users to Backstage
    gitlabOrg:
      yourOrgProviderId:
        host: ${GITLAB_HOST}
        schedule:
          frequency: { hours: 1 }
          timeout: { minutes: 5 }
          initialDelay: { seconds: 30 }
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITLAB_HOST` | Yes | GitLab host (e.g., `gitlab.com`) |
| `GITLAB_TOKEN` | Yes | Personal Access Token with `api` scope |

## catalog-info.yaml Examples

### Component

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

### API Spec

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

## Supported API Types

| Type | Spec Format |
|------|-------------|
| `openapi` | OpenAPI 3.x / Swagger 2.0 |
| `asyncapi` | AsyncAPI 2.x |
| `graphql` | GraphQL SDL |
| `grpc` | Protocol Buffers |
