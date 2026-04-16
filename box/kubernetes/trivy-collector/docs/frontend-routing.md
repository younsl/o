# Frontend Routing

trivy-collector frontend uses [react-router-dom](https://reactrouter.com/) v7 for client-side URL routing. Each view has its own URI path, enabling bookmarking, link sharing, and browser back/forward navigation.

## Routes

| Path | View | Description |
|------|------|-------------|
| `/` | — | Redirects to `/vulnerabilities` |
| `/vulnerabilities` | Reports list | Vulnerability reports with filtering and sorting |
| `/vulnerabilities?cluster=X&namespace=Y&app=Z` | Filtered list | Vulnerability reports filtered by query params |
| `/vulnerabilities/:cluster/:namespace/:name` | Detail | Single vulnerability report detail |
| `/sbom` | Reports list | SBOM reports with filtering and sorting |
| `/sbom?cluster=X&namespace=Y&app=Z` | Filtered list | SBOM reports filtered by query params |
| `/sbom/:cluster/:namespace/:name` | Detail | Single SBOM report detail |
| `/dashboard` | Dashboard | Security trends dashboard with charts |
| `/version` | Version | Build and runtime version information |
| `*` | — | Any unknown path redirects to `/vulnerabilities` |

## Query Parameters

List views (`/vulnerabilities`, `/sbom`) support the following query parameters for filtering:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `cluster` | Filter by cluster name | `?cluster=production` |
| `namespace` | Filter by namespace | `?namespace=default` |
| `app` | Filter by application name | `?app=nginx` |

Parameters are optional and can be combined. Changing the cluster filter automatically clears the namespace filter.

## Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `Escape` | Detail view (`/vulnerabilities/:c/:ns/:n`) | Navigate back to `/vulnerabilities` |
| `Escape` | Detail view (`/sbom/:c/:ns/:n`) | Navigate back to `/sbom` |
| `Escape` | Dashboard (`/dashboard`) | Navigate to `/vulnerabilities` |
| `Escape` | Version (`/version`) | Navigate to `/vulnerabilities` |

## SPA Fallback

The Rust backend serves the frontend as a Single Page Application. All non-API routes (`/api/*`) fall back to `index.html`, allowing react-router-dom to handle client-side routing. Direct URL access (e.g., pasting `/sbom` into the browser address bar) works without additional server configuration.
