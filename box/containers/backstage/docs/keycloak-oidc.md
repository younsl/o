# Keycloak OIDC Authentication

Backstage supports Keycloak OIDC authentication for SSO.

## Keycloak Client Setup

Create a client in Keycloak Admin Console:

| Setting | Value |
|---------|-------|
| Client type | OpenID Connect |
| Client ID | `backstage` |
| Client authentication | ON (confidential) |
| Valid redirect URIs | `https://backstage.example.com/api/auth/oidc/handler/frame` |
| Valid post logout redirect URIs | `https://backstage.example.com` |
| Web origins | `https://backstage.example.com` |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KEYCLOAK_CLIENT_ID` | Yes | Keycloak client ID |
| `KEYCLOAK_CLIENT_SECRET` | Yes | Keycloak client secret |
| `KEYCLOAK_METADATA_URL` | Yes | OIDC metadata URL |
| `AUTH_SESSION_SECRET` | Yes | Session secret (min 32 chars) |

Generate session secret:

```bash
openssl rand -base64 32
```

## app-config.yaml

```yaml
auth:
  environment: production
  session:
    secret: ${AUTH_SESSION_SECRET}
  providers:
    oidc:
      production:
        clientId: ${KEYCLOAK_CLIENT_ID}
        clientSecret: ${KEYCLOAK_CLIENT_SECRET}
        metadataUrl: ${KEYCLOAK_METADATA_URL}
        # Example: https://keycloak.example.com/realms/my-realm/.well-known/openid-configuration
        prompt: auto
        signIn:
          resolvers:
            - resolver: emailLocalPartMatchingUserEntityName
              dangerouslyAllowSignInWithoutUserInCatalog: true
```

## Helm Chart Configuration

```yaml
backstage:
  appConfig:
    auth:
      environment: production
      session:
        secret: ${AUTH_SESSION_SECRET}
      providers:
        oidc:
          production:
            clientId: ${KEYCLOAK_CLIENT_ID}
            clientSecret: ${KEYCLOAK_CLIENT_SECRET}
            metadataUrl: ${KEYCLOAK_METADATA_URL}
            prompt: auto
            signIn:
              resolvers:
                - resolver: emailLocalPartMatchingUserEntityName
                  dangerouslyAllowSignInWithoutUserInCatalog: true

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

## Kubernetes Secret

```bash
AUTH_SESSION_SECRET=$(openssl rand -base64 32)

kubectl create secret generic backstage-secrets \
  --namespace backstage \
  --from-literal=keycloak-client-secret=<your-client-secret> \
  --from-literal=auth-session-secret=$AUTH_SESSION_SECRET
```

## Sign-in Resolvers

| Resolver | Description |
|----------|-------------|
| `emailLocalPartMatchingUserEntityName` | Match email prefix to User entity name |
| `emailMatchingUserEntityProfileEmail` | Match full email to User entity email |

> **Note**: `dangerouslyAllowSignInWithoutUserInCatalog: true` allows login even without a matching User entity in the catalog.

## Local Development

For local development (3000 + 7007 ports):

| Setting | Value |
|---------|-------|
| Valid redirect URIs | `http://localhost:7007/api/auth/oidc/handler/frame` |
| Web origins | `http://localhost:3000` |

## Monolithic Setup (7007 only)

For production-like single port setup:

| Setting | Value |
|---------|-------|
| Valid redirect URIs | `http://localhost:7007/api/auth/oidc/handler/frame` |
| Web origins | `http://localhost:7007` |

Run with:

```bash
yarn build:all
yarn start-backend
```

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| `Invalid redirect_uri` | URI not registered in Keycloak | Add exact URI to Valid redirect URIs |
| `CORS error` | Web origins missing | Add origin to Web origins |
| `PopupClosedError` | Popup closed before completion | Check redirect URI and browser console |
| `Unable to resolve user identity` | No matching User entity | Enable `dangerouslyAllowSignInWithoutUserInCatalog` |
