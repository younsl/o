import type {
  ApiLogEntry,
  ApiLogStats,
  ClusterInfo,
  ComponentSearchResult,
  ConfigResponse,
  VulnSearchResult,
  CreateTokenResponse,
  Filters,
  FullReport,
  ListResponse,
  ReportMeta,
  ReportType,
  Stats,
  StatusResponse,
  TokenInfo,
  TrendResponse,
  VersionResponse,
  WatcherStatusResponse,
} from './types'

async function fetchApi<T>(endpoint: string): Promise<T> {
  const response = await fetch(endpoint)
  if (response.status === 401) {
    // Redirect to login on authentication failure
    const returnTo = encodeURIComponent(window.location.pathname)
    window.location.href = `/auth/login?return_to=${returnTo}`
    // Return a never-resolving promise to prevent further processing
    return new Promise(() => {})
  }
  return response.json() as Promise<T>
}

export function getReports(
  reportType: ReportType,
  filters: Filters,
): Promise<ListResponse<ReportMeta>> {
  const params = new URLSearchParams()
  if (filters.cluster) params.append('cluster', filters.cluster)
  if (filters.namespace) params.append('namespace', filters.namespace)
  if (filters.app) params.append('app', filters.app)
  if (filters.component) params.append('component', filters.component)

  const endpoint =
    reportType === 'vulnerabilityreport'
      ? `/api/v1/vulnerabilityreports?${params}`
      : `/api/v1/sbomreports?${params}`

  return fetchApi(endpoint)
}

export function getReportDetail(
  reportType: ReportType,
  cluster: string,
  namespace: string,
  name: string,
): Promise<FullReport> {
  const base =
    reportType === 'vulnerabilityreport'
      ? '/api/v1/vulnerabilityreports'
      : '/api/v1/sbomreports'
  return fetchApi(
    `${base}/${encodeURIComponent(cluster)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
  )
}

export function getStats(): Promise<Stats> {
  return fetchApi('/api/v1/stats')
}

export function getClusters(): Promise<ListResponse<ClusterInfo>> {
  return fetchApi('/api/v1/clusters')
}

export function getNamespaces(
  cluster?: string,
): Promise<ListResponse<string>> {
  const endpoint = cluster
    ? `/api/v1/namespaces?cluster=${encodeURIComponent(cluster)}`
    : '/api/v1/namespaces'
  return fetchApi(endpoint)
}

export function getWatcherStatus(): Promise<WatcherStatusResponse> {
  return fetchApi('/api/v1/watcher/status')
}

export function getVersion(): Promise<VersionResponse> {
  return fetchApi('/api/v1/version')
}

export function getStatus(): Promise<StatusResponse> {
  return fetchApi('/api/v1/status')
}

export function getConfig(): Promise<ConfigResponse> {
  return fetchApi('/api/v1/config')
}

export function getDashboardTrends(
  range: string,
  cluster?: string,
): Promise<TrendResponse> {
  const params = new URLSearchParams({ range })
  if (cluster) params.append('cluster', cluster)
  return fetchApi(`/api/v1/dashboard/trends?${params}`)
}

export async function listTokens(): Promise<{ tokens: TokenInfo[] }> {
  return fetchApi('/api/v1/auth/tokens')
}

export async function createToken(
  name: string,
  description: string,
  expiresDays: number,
): Promise<CreateTokenResponse> {
  const response = await fetch('/api/v1/auth/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, expires_days: expiresDays }),
  })
  if (response.status === 401) {
    const returnTo = encodeURIComponent(window.location.pathname)
    window.location.href = `/auth/login?return_to=${returnTo}`
    return new Promise(() => {})
  }
  if (!response.ok) {
    let message = 'Failed to create token'
    try {
      const err = await response.json()
      if (err.error) message = err.error
    } catch {
      // response body is not JSON
    }
    throw new Error(message)
  }
  return response.json()
}

export async function deleteToken(tokenId: number): Promise<boolean> {
  const response = await fetch(`/api/v1/auth/tokens/${tokenId}`, {
    method: 'DELETE',
  })
  if (response.status === 401) {
    const returnTo = encodeURIComponent(window.location.pathname)
    window.location.href = `/auth/login?return_to=${returnTo}`
    return new Promise(() => {})
  }
  return response.ok
}

export function searchVulnerabilities(
  q: string,
  limit?: number,
  offset?: number,
): Promise<ListResponse<VulnSearchResult>> {
  const params = new URLSearchParams({ q })
  if (limit !== undefined) params.append('limit', String(limit))
  if (offset !== undefined) params.append('offset', String(offset))
  return fetchApi(`/api/v1/vulnerabilityreports/vulnerabilities/search?${params}`)
}

export function suggestVulnerabilities(
  q: string,
  limit?: number,
): Promise<string[]> {
  const params = new URLSearchParams({ q })
  if (limit !== undefined) params.append('limit', String(limit))
  return fetchApi(`/api/v1/vulnerabilityreports/vulnerabilities/suggest?${params}`)
}

export function suggestSbomComponents(
  q: string,
  limit?: number,
): Promise<string[]> {
  const params = new URLSearchParams({ q })
  if (limit !== undefined) params.append('limit', String(limit))
  return fetchApi(`/api/v1/sbomreports/components/suggest?${params}`)
}

export function searchSbomComponents(
  component: string,
  limit?: number,
  offset?: number,
): Promise<ListResponse<ComponentSearchResult>> {
  const params = new URLSearchParams({ component })
  if (limit !== undefined) params.append('limit', String(limit))
  if (offset !== undefined) params.append('offset', String(offset))
  return fetchApi(`/api/v1/sbomreports/components/search?${params}`)
}

// ───── Admin API ─────

export interface AdminLogsParams {
  method?: string
  path?: string
  status_min?: number
  status_max?: number
  user?: string
  limit?: number
  offset?: number
}

export function getApiLogs(
  params: AdminLogsParams = {},
): Promise<ListResponse<ApiLogEntry>> {
  const search = new URLSearchParams()
  if (params.method) search.append('method', params.method)
  if (params.path) search.append('path', params.path)
  if (params.status_min !== undefined)
    search.append('status_min', String(params.status_min))
  if (params.status_max !== undefined)
    search.append('status_max', String(params.status_max))
  if (params.user) search.append('user', params.user)
  if (params.limit !== undefined) search.append('limit', String(params.limit))
  if (params.offset !== undefined)
    search.append('offset', String(params.offset))
  return fetchApi(`/api/v1/admin/logs?${search}`)
}

export function getApiLogStats(): Promise<ApiLogStats> {
  return fetchApi('/api/v1/admin/logs/stats')
}

export async function cleanupApiLogs(
  retentionDays: number,
): Promise<{ deleted: number; retention_days: number }> {
  const response = await fetch(
    `/api/v1/admin/logs?retention_days=${retentionDays}`,
    { method: 'DELETE' },
  )
  if (response.status === 401) {
    const returnTo = encodeURIComponent(window.location.pathname)
    window.location.href = `/auth/login?return_to=${returnTo}`
    return new Promise(() => {})
  }
  if (response.status === 403) {
    throw new Error('Access denied')
  }
  return response.json()
}

// ── Hub-pull cluster registration ──

export interface RegisteredCluster {
  name: string
  server: string
  namespaces: string[]
  insecure: boolean
  /** True for the auto-registered Hub-self entry. */
  in_cluster?: boolean
  /** Live probe result computed at list time (server calls /version on each Edge). */
  reachable?: boolean
  /** Human-readable probe outcome (Kubernetes version, error, or timeout). */
  reachability_message?: string
  /** Probe wall-clock duration in milliseconds. */
  reachability_latency_ms?: number
}

export async function getRegisteredClusters(): Promise<RegisteredCluster[]> {
  const res = await fetch('/api/v1/hub/clusters')
  if (res.status === 401) {
    const returnTo = encodeURIComponent(window.location.pathname)
    window.location.href = `/auth/login?return_to=${returnTo}`
    return new Promise(() => {})
  }
  if (!res.ok) {
    // Hub mode may be inactive (412) or the API may have failed. Treat as empty list.
    return []
  }
  const body = await res.json()
  return Array.isArray(body) ? body : []
}

export interface RegisterClusterRequest {
  name: string
  server: string
  bearer_token: string
  ca_data?: string
  insecure?: boolean
  namespaces?: string[]
}

export async function registerCluster(
  req: RegisterClusterRequest,
): Promise<RegisteredCluster> {
  const res = await fetch('/api/v1/hub/clusters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (res.status === 401) {
    const returnTo = encodeURIComponent(window.location.pathname)
    window.location.href = `/auth/login?return_to=${returnTo}`
    return new Promise(() => {})
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.error || `Registration failed (${res.status})`)
  }
  return body as RegisteredCluster
}

export async function deleteRegisteredCluster(name: string): Promise<boolean> {
  const res = await fetch(`/api/v1/hub/clusters/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
  return res.ok
}

export interface RegistrationManifests {
  edge_rbac: string
  extract_commands: string
  hub_secret_template: string
  edge_namespace: string
  hub_namespace: string
  cluster_name: string
}

export interface ManifestParams {
  edgeNamespace?: string
  hubNamespace?: string
  clusterName?: string
}

export async function getRegistrationManifests(
  params: ManifestParams = {},
): Promise<RegistrationManifests> {
  const qs = new URLSearchParams()
  if (params.edgeNamespace) qs.set('edge_namespace', params.edgeNamespace)
  if (params.hubNamespace) qs.set('hub_namespace', params.hubNamespace)
  if (params.clusterName) qs.set('cluster_name', params.clusterName)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const res = await fetch(`/api/v1/hub/manifests${suffix}`)
  if (res.status === 401) {
    const returnTo = encodeURIComponent(window.location.pathname)
    window.location.href = `/auth/login?return_to=${returnTo}`
    return new Promise(() => {})
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch manifests: ${res.status}`)
  }
  return res.json()
}

export async function updateNotes(
  cluster: string,
  reportType: ReportType,
  namespace: string,
  name: string,
  notes: string,
): Promise<boolean> {
  const response = await fetch(
    `/api/v1/reports/${encodeURIComponent(cluster)}/${encodeURIComponent(reportType)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/notes`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    },
  )
  return response.ok
}
