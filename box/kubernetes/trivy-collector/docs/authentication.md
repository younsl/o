# Authentication

trivy-collector supports two authentication modes: `none` (anonymous, default) and `keycloak` ([Keycloak](https://www.keycloak.org/) OIDC SSO). When `keycloak` mode is enabled, users authenticate via [Keycloak](https://www.keycloak.org/) and can also create self-issued API tokens for programmatic access.

## Authentication Modes

| Mode | Description |
|------|-------------|
| `none` | Anonymous access (default). No authentication required. |
| `keycloak` | [Keycloak](https://www.keycloak.org/) OIDC SSO. Users authenticate via Authorization Code Flow. |

## [Keycloak](https://www.keycloak.org/) OIDC Setup

### Prerequisites

- [Keycloak](https://www.keycloak.org/) server with a realm configured
- A confidential client created in Keycloak for trivy-collector

### Keycloak Client Configuration

1. Create a new client in your [Keycloak](https://www.keycloak.org/) realm:
   - **Client ID**: `trivy-collector`
   - **Client Protocol**: `openid-connect`
   - **Access Type**: `confidential`
   - **Valid Redirect URIs**: `https://trivy.example.com/auth/callback`

2. (Optional) To display user groups in the Auth page, add a **Group Membership** mapper:
   - **Mapper type**: Group Membership
   - **Token Claim Name**: `groups`
   - **Full group path**: OFF

### Helm Deployment

```bash
# Create OIDC credentials secret
kubectl create secret generic trivy-oidc \
  --namespace trivy-system \
  --from-literal=client-id=trivy-collector \
  --from-literal=client-secret=<YOUR_CLIENT_SECRET>

# Deploy with Keycloak authentication enabled
helm install trivy-collector oci://ghcr.io/younsl/charts/trivy-collector \
  --namespace trivy-system \
  --create-namespace \
  --set mode=server \
  --set auth.mode=keycloak \
  --set auth.sso.issuer=https://keycloak.example.com/realms/trivy \
  --set auth.sso.redirectUrl=https://trivy.example.com/auth/callback \
  --set auth.sso.clientId.name=trivy-oidc \
  --set auth.sso.clientSecret.name=trivy-oidc \
  --set server.persistence.enabled=true \
  --set server.ingress.enabled=true \
  --set server.ingress.hosts[0].host=trivy.example.com
```

### Environment Variables

When not using Helm, configure authentication via environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `AUTH_MODE` | Authentication mode | `keycloak` |
| `OIDC_ISSUER_URL` | [Keycloak](https://www.keycloak.org/) realm URL | `https://keycloak.example.com/realms/trivy` |
| `OIDC_CLIENT_ID` | OIDC client ID | `trivy-collector` |
| `OIDC_CLIENT_SECRET` | OIDC client secret | `<secret>` |
| `OIDC_REDIRECT_URL` | Callback URL | `https://trivy.example.com/auth/callback` |
| `OIDC_SCOPES` | OIDC scopes (space-separated) | `openid profile email groups` |

## Authentication Flow

```
Browser ──→ /auth/login ──→ Keycloak Login Page
                                    │
                                    ▼
         /auth/callback ◀── Authorization Code
                │
                ▼
         Exchange code for tokens
                │
                ▼
         Set encrypted session cookie (trivy_session)
                │
                ▼
         Redirect to original page
```

- Browser sessions use encrypted cookies (`trivy_session`)
- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` (when using HTTPS)

## API Tokens

API tokens allow programmatic access to the trivy-collector API without browser-based SSO.

### Token Properties

| Property | Detail |
|----------|--------|
| Format | `tc_` prefix + 64 hex characters (67 chars total) |
| Storage | SHA-256 hashed (plaintext never stored) |
| Expiration | 1, 7, 30, 90, 180, or 365 days |
| Limit | 5 tokens per user |
| Name rules | 4-64 characters, letters/digits/hyphens/underscores only |

### Creating Tokens

Tokens are created via the **Auth** page in the web UI. The plaintext token is displayed only once at creation.

### Using Tokens

```bash
# curl
curl -H "Authorization: Bearer tc_<your_token>" https://trivy.example.com/api/v1/stats

# wget
wget -qO- --header="Authorization: Bearer tc_<your_token>" https://trivy.example.com/api/v1/stats
```

### Token Validation Order

When a request contains authentication credentials, the server validates in this order:

1. **Session cookie** (`trivy_session`) — browser-based SSO
2. **Bearer token** with `tc_` prefix — self-issued API token (validated against SQLite)
3. **Bearer token** without `tc_` prefix — Keycloak JWT (validated against JWKS endpoint)

### Security Best Practices

- Store tokens in environment variables or secret managers, never in source code
- Do not share tokens via chat or email; use a secrets vault instead
- Set the shortest expiration that meets your needs
- Revoke tokens immediately when no longer needed

## Token API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/auth/tokens` | List current user's tokens |
| `POST` | `/api/v1/auth/tokens` | Create a new token |
| `DELETE` | `/api/v1/auth/tokens/{id}` | Delete a token |

### Create Token Request

```json
{
  "name": "my-ci-token",
  "description": "CI/CD pipeline token",
  "expires_days": 30
}
```

### Create Token Response

```json
{
  "token": "tc_a1b2c3d4...",
  "info": {
    "id": 1,
    "name": "my-ci-token",
    "description": "CI/CD pipeline token",
    "token_prefix": "tc_a1b2c3d4",
    "created_at": "2025-01-01T00:00:00Z",
    "expires_at": "2025-01-31T00:00:00Z",
    "last_used_at": null
  }
}
```
