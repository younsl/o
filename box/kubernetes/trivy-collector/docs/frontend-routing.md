# Frontend Routing

trivy-collector frontend uses [react-router-dom](https://reactrouter.com/) v7
for client-side URL routing. Each view has its own URI path, enabling
bookmarking, link sharing, and browser back/forward navigation.

## Routes

| Path | View | Description |
|------|------|-------------|
| `/` | — | Redirects to `/vulnerabilities` |
| `/vulnerabilities` | Reports list | Vulnerability reports with filtering and sorting |
| `/vulnerabilities?cluster=X&namespace=Y&app=Z` | Filtered list | Vulnerability reports filtered by query params |
| `/vulnerabilities/search` | Search | Full-text CVE search across all clusters |
| `/vulnerabilities/:cluster/:namespace/:name` | Detail | Single vulnerability report detail |
| `/sbom` | Reports list | SBOM reports with filtering and sorting |
| `/sbom?cluster=X&namespace=Y&app=Z` | Filtered list | SBOM reports filtered by query params |
| `/sbom/components` | Component search | Search across SBOM component names / versions |
| `/sbom/:cluster/:namespace/:name` | Detail | Single SBOM report detail |
| `/dashboard` | Dashboard | Security trends dashboard with charts |
| `/auth` | Auth | OIDC login status and self-issued API token management |
| `/admin` | — | Redirects to `/admin/clusters` |
| `/admin/clusters` | Clusters | Registered cluster list + two-step registration wizard (admin only) |
| `/admin/audit` | API Audit | HTTP API audit log viewer (admin only) |
| `/version` | Version | Build and runtime version information |
| `*` | — | Any unknown path redirects to `/vulnerabilities` |

## Admin sub-navigation

`/admin/*` pages share a tab-style sub-nav (`AdminSubNav`) with two entries:

- **Clusters** → `/admin/clusters`
- **API Audit** → `/admin/audit`

Both views are gated by the `can_admin` RBAC permission. Users without
`can_admin` hit the route but render an "Access denied" message. `/admin`
without a suffix redirects to `/admin/clusters`.

## Query Parameters

List views (`/vulnerabilities`, `/sbom`) support the following query
parameters for filtering:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `cluster` | Filter by cluster name | `?cluster=edge-a` |
| `namespace` | Filter by namespace | `?namespace=default` |
| `app` | Filter by application name | `?app=nginx` |

Parameters are optional and can be combined. Changing the cluster filter
automatically clears the namespace filter.

## Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `Escape` | Detail view (`/vulnerabilities/:c/:ns/:n`) | Navigate back to `/vulnerabilities` |
| `Escape` | Detail view (`/sbom/:c/:ns/:n`) | Navigate back to `/sbom` |
| `Escape` | Dashboard (`/dashboard`) | Navigate to `/vulnerabilities` |
| `Escape` | Version (`/version`) | Navigate to `/vulnerabilities` |

## SPA Fallback

The Rust backend serves the frontend as a Single Page Application. All
non-API routes (i.e., anything outside `/api/*`, `/auth/*`, `/healthz`,
`/metrics`, `/swagger-ui/*`, `/assets/*`, `/static/*`) fall back to
`index.html`, allowing react-router-dom to handle client-side routing.
Direct URL access (e.g., pasting `/admin/clusters` into the browser address
bar) works without additional server configuration.
