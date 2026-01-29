# Helm Chart Integration

This custom image is compatible with the official [Backstage Helm Chart](https://github.com/backstage/charts).

## values.yaml

```yaml
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

## Installation

### Create Namespace and Secret

```bash
kubectl create namespace backstage

kubectl create secret generic backstage-secrets \
  --namespace backstage \
  --from-literal=gitlab-token=glpat-xxxxxxxxxxxx \
  --from-literal=postgres-user=backstage \
  --from-literal=postgres-password=changeme
```

### Install with Helm

```bash
helm repo add backstage https://backstage.github.io/charts

helm install backstage backstage/backstage \
  --namespace backstage \
  -f values.yaml
```

## With Keycloak OIDC

See [Keycloak OIDC](keycloak-oidc.md) for authentication configuration.

Add to `extraEnvVars`:

```yaml
extraEnvVars:
  - name: KEYCLOAK_CLIENT_ID
    value: "backstage"
  - name: KEYCLOAK_CLIENT_SECRET
    valueFrom:
      secretKeyRef:
        name: backstage-secrets
        key: keycloak-client-secret
  - name: KEYCLOAK_METADATA_URL
    value: "https://keycloak.example.com/realms/my-realm/.well-known/openid-configuration"
  - name: AUTH_SESSION_SECRET
    valueFrom:
      secretKeyRef:
        name: backstage-secrets
        key: auth-session-secret
```
