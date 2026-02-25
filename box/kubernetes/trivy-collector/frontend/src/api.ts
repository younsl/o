import type {
  ClusterInfo,
  ConfigResponse,
  Filters,
  FullReport,
  ListResponse,
  ReportMeta,
  ReportType,
  Stats,
  StatusResponse,
  TrendResponse,
  VersionResponse,
  WatcherStatusResponse,
} from './types'

async function fetchApi<T>(endpoint: string): Promise<T> {
  const response = await fetch(endpoint)
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
