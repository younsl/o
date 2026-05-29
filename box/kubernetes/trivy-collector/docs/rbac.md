# RBAC (Role-Based Access Control)

trivy-collector implements ArgoCD-style RBAC using CSV policy files. When `keycloak` authentication is enabled, RBAC controls which API resources each user can access based on their Keycloak group memberships.

> When `auth_mode=none`, RBAC is not enforced and all endpoints are accessible.

## Policy Format

Policies use the same CSV format as [ArgoCD RBAC](https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/):

```csv
# Policy rules: p, <subject>, <resource>, <action>, <effect>
p, role:readonly, reports, get, allow
p, role:admin, *, *, allow

# Group bindings: g, <keycloak-group>, <role>
g, security-team, role:readonly
g, platform-team, role:admin
```

- Lines starting with `#` are comments
- `*` is a wildcard that matches any resource or action

## Built-in Roles

| Role | Permissions | Use Case |
|------|-------------|----------|
| `role:readonly` | `reports:get`, `clusters:get`, `stats:get`, `tokens:get`, `tokens:create`, `alerts:get` | Security engineers — view reports and alert rules, create personal API tokens |
| `role:admin` | `*:*` (all resources, all actions) | Administrators — full access including admin console, alert rule management, and destructive operations |

## Resources and Actions

| Resource | Action | API Endpoints |
|----------|--------|---------------|
| `reports` | `get` | `GET /api/v1/vulnerabilityreports`, `GET /api/v1/sbomreports`, search, suggest, individual report detail |
| `reports` | `delete` | `DELETE /api/v1/reports/{cluster}/{type}/{namespace}/{name}` |
| `reports` | `update` | `PUT /api/v1/reports/{...}/notes` |
| `clusters` | `get` | `GET /api/v1/clusters`, `GET /api/v1/namespaces` |
| `stats` | `get` | `GET /api/v1/stats`, `GET /api/v1/dashboard/trends`, `GET /api/v1/watcher/status`, `GET /api/v1/version`, `GET /api/v1/status`, `GET /api/v1/config` |
| `admin` | `get` | `GET /api/v1/admin/logs`, `GET /api/v1/admin/logs/stats`, `GET /api/v1/admin/info` |
| `admin` | `delete` | `DELETE /api/v1/admin/logs` |
| `tokens` | `get` | `GET /api/v1/auth/tokens` |
| `tokens` | `create` | `POST /api/v1/auth/tokens` |
| `tokens` | `delete` | `DELETE /api/v1/auth/tokens/{id}` |
| `alerts` | `get` | `GET /api/v1/alerts`, `GET /api/v1/alerts/{name}`, `POST /api/v1/alerts/preview` |
| `alerts` | `create` | `POST /api/v1/alerts` (create rule), `POST /api/v1/alerts/test` (send Slack test) |
| `alerts` | `update` | `PUT /api/v1/alerts/{name}` |
| `alerts` | `delete` | `DELETE /api/v1/alerts/{name}` |

## Default Policy

The `RBAC_DEFAULT_POLICY` environment variable determines the role assigned to authenticated users who have no explicit group bindings in the policy.

| Value | Behavior |
|-------|----------|
| `role:readonly` (default) | All authenticated users get read-only access |
| `role:admin` | All authenticated users get full admin access |
| `""` (empty) | Users without explicit group bindings are denied all access |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RBAC_POLICY_CSV` | `""` (uses built-in default) | Inline CSV policy string or file path |
| `RBAC_DEFAULT_POLICY` | `role:readonly` | Default role for users without explicit group bindings |

### Helm Values

```yaml
server:
  auth:
    rbac:
      policy: |
        p, role:readonly, reports, get, allow
        p, role:readonly, clusters, get, allow
        p, role:readonly, stats, get, allow
        p, role:readonly, tokens, get, allow
        p, role:readonly, tokens, create, allow
        p, role:readonly, alerts, get, allow
        p, role:admin, *, *, allow
        g, security-team, role:readonly
        g, platform-team, role:admin
      defaultPolicy: "role:readonly"
```

## Configuration Examples

### Example 1: Two-tier access (default)

Security engineers can view reports and create tokens. Platform team has full admin access.

```csv
p, role:readonly, reports, get, allow
p, role:readonly, clusters, get, allow
p, role:readonly, stats, get, allow
p, role:readonly, tokens, get, allow
p, role:readonly, tokens, create, allow
p, role:readonly, alerts, get, allow
p, role:admin, *, *, allow

g, security-team, role:readonly
g, platform-team, role:admin
```

With `RBAC_DEFAULT_POLICY=role:readonly`, any authenticated user not in `platform-team` gets readonly access.

### Example 2: Strict access — deny by default

Only explicitly mapped groups get access. All other users are denied.

```csv
p, role:viewer, reports, get, allow
p, role:viewer, clusters, get, allow
p, role:viewer, stats, get, allow
p, role:editor, reports, get, allow
p, role:editor, reports, update, allow
p, role:editor, clusters, get, allow
p, role:editor, stats, get, allow
p, role:editor, tokens, get, allow
p, role:editor, tokens, create, allow
p, role:admin, *, *, allow

g, security-viewers, role:viewer
g, security-editors, role:editor
g, platform-admins, role:admin
```

Set `RBAC_DEFAULT_POLICY=""` to deny users without explicit bindings.

### Example 3: Everyone is admin (development)

```csv
p, role:admin, *, *, allow
```

With `RBAC_DEFAULT_POLICY=role:admin`, all authenticated users have full access.

## How It Works

1. User authenticates via Keycloak OIDC (groups are included in the ID token)
2. On each API request, the RBAC middleware:
   - Maps the HTTP method + path to a `(resource, action)` pair
   - Resolves the user's Keycloak groups to roles via `g` (group binding) rules
   - If no group bindings match, assigns the `RBAC_DEFAULT_POLICY` role
   - Evaluates `p` (policy) rules for the resolved roles
   - Returns **403 Forbidden** if no matching allow rule is found

## Frontend Integration

The `/api/v1/auth/me` endpoint returns a `permissions` object:

```json
{
  "authenticated": true,
  "auth_mode": "keycloak",
  "user": { "sub": "...", "groups": ["platform-team"] },
  "permissions": {
    "can_admin": true,
    "can_delete_reports": true,
    "can_manage_tokens": true
  }
}
```

The frontend uses these flags to conditionally render UI elements (e.g., the Admin nav link only appears when `can_admin` is `true`).
