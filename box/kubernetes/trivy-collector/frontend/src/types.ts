// API response types matching the Rust backend

export interface VulnSummary {
  critical: number
  high: number
  medium: number
  low: number
  unknown: number
}

export interface ReportMeta {
  cluster: string
  namespace: string
  name: string
  app: string
  image: string
  registry: string
  summary: VulnSummary
  components_count: number
  notes: string
  notes_created_at: string | null
  notes_updated_at: string | null
  updated_at: string
}

export interface FullReport {
  meta: ReportMeta
  data: Record<string, unknown>
}

export interface ClusterInfo {
  name: string
  vuln_report_count: number
  sbom_report_count: number
}

export interface Stats {
  total_clusters: number
  total_vuln_reports: number
  total_sbom_reports: number
  total_critical: number
  total_high: number
  total_medium: number
  total_low: number
  total_unknown: number
  sqlite_version: string
  db_size_bytes: number
  db_size_human: string
}

export interface ListResponse<T> {
  items: T[]
  total: number
}

export interface WatcherInfo {
  running: boolean
  initial_sync_done: boolean
  reports_count: number
}

export interface WatcherStatusResponse {
  vuln_watcher: WatcherInfo
  sbom_watcher: WatcherInfo
}

export interface VersionResponse {
  version: string
  commit: string
  build_date: string
  rust_version: string
  rust_channel: string
  llvm_version: string
  platform: string
}

export interface StatusResponse {
  hostname: string
  uptime: string
  collectors: number
}

export interface ConfigItem {
  env: string
  value: string
  sensitive: boolean
}

export interface ConfigResponse {
  items: ConfigItem[]
}

export interface TrendDataPoint {
  date: string
  vuln_reports: number
  sbom_reports: number
  critical: number
  high: number
  medium: number
  low: number
  unknown: number
  clusters_count: number
}

export interface TrendMeta {
  range_start: string
  range_end: string
  granularity: string
  clusters: string[]
  data_from: string | null
  data_to: string | null
}

export interface TrendResponse {
  meta: TrendMeta
  series: TrendDataPoint[]
}

export interface TokenInfo {
  id: number
  name: string
  description: string
  token_prefix: string
  created_at: string
  expires_at: string
  last_used_at: string | null
}

export interface CreateTokenResponse {
  token: string
  info: TokenInfo
}

export type ReportType = 'vulnerabilityreport' | 'sbomreport'

export interface AuthUser {
  sub: string
  email: string | null
  name: string | null
  preferred_username: string | null
  groups: string[]
}

export interface AuthStatus {
  authenticated: boolean
  auth_mode: string
  user?: AuthUser
}


export interface Filters {
  cluster: string
  namespace: string
  app: string
}

export interface Vulnerability {
  vulnerabilityID?: string
  vulnerability_id?: string
  severity: string
  score: number | null
  resource: string
  installedVersion?: string
  installed_version?: string
  fixedVersion?: string
  fixed_version?: string
  title: string
  primaryLink?: string
  primary_link?: string
}

export interface SbomComponent {
  name: string
  version: string
  type?: string
  component_type?: string
  purl?: string
  'bom-ref'?: string
  bomRef?: string
  bom_ref?: string
  licenses?: Array<{ license?: { name: string }; name?: string }>
}

export interface SbomDependency {
  ref: string
  dependsOn?: string[]
}
