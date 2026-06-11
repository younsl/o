---
plugins:
  - "@backstage/plugin-auth-backend-module-oidc-provider"
  - "@backstage-community/plugin-catalog-backend-module-keycloak"
---

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
| `KEYCLOAK_BASE_URL` | Yes | Keycloak base URL for catalog sync |
| `KEYCLOAK_REALM` | Yes | Realm to synchronize into the catalog |
| `KEYCLOAK_CATALOG_CLIENT_ID` | Yes | Service account client ID for catalog sync |
| `KEYCLOAK_CATALOG_CLIENT_SECRET` | Yes | Service account client secret for catalog sync |
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

catalog:
  providers:
    keycloakOrg:
      yourProviderId:
        baseUrl: ${KEYCLOAK_BASE_URL}
        loginRealm: ${KEYCLOAK_REALM}
        realm: ${KEYCLOAK_REALM}
        clientId: ${KEYCLOAK_CATALOG_CLIENT_ID}
        clientSecret: ${KEYCLOAK_CATALOG_CLIENT_SECRET}
        briefRepresentation: false
        schedule:
          frequency: { minutes: 30 }
          timeout: { minutes: 3 }
          initialDelay: { seconds: 30 }
```

## Keycloak Catalog Sync

Create a separate confidential client for catalog synchronization. Use placeholders in repository config and inject real values through the deployment environment.

| Setting | Value |
|---------|-------|
| Client ID | `<catalog-sync-client-id>` |
| Client authentication | ON |
| Service accounts roles | ON |
| Standard flow | OFF |
| Direct access grants | OFF |
| Valid redirect URIs | empty |

Assign these `realm-management` client roles to the service account:

| Role | Purpose |
|------|---------|
| `query-users` | List users |
| `view-users` | Read user profile fields such as email |
| `query-groups` | List groups and memberships |

The default Keycloak catalog transformer creates `User.metadata.name` from the Keycloak username and `User.spec.profile.email` from the Keycloak email. This matches `emailLocalPartMatchingUserEntityName` when usernames are the email local-part.

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
    catalog:
      providers:
        keycloakOrg:
          yourProviderId:
            baseUrl: ${KEYCLOAK_BASE_URL}
            loginRealm: ${KEYCLOAK_REALM}
            realm: ${KEYCLOAK_REALM}
            clientId: ${KEYCLOAK_CATALOG_CLIENT_ID}
            clientSecret: ${KEYCLOAK_CATALOG_CLIENT_SECRET}
            briefRepresentation: false
            schedule:
              frequency: { minutes: 30 }
              timeout: { minutes: 3 }
              initialDelay: { seconds: 30 }

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
    - name: KEYCLOAK_BASE_URL
      value: "https://keycloak.example.com"
    - name: KEYCLOAK_REALM
      value: "my-realm"
    - name: KEYCLOAK_CATALOG_CLIENT_ID
      value: "<catalog-sync-client-id>"
    - name: KEYCLOAK_CATALOG_CLIENT_SECRET
      valueFrom:
        secretKeyRef:
          name: backstage-secrets
          key: KEYCLOAK_CATALOG_CLIENT_SECRET
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
  --from-literal=KEYCLOAK_CATALOG_CLIENT_SECRET=<catalog-sync-client-secret> \
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
