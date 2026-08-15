export const MUTE_ANNOTATION = 'backstage.io/muted';

export interface VersionOrigin {
  kind: 'helm-repository' | 'chart-yaml';
  location: string;
  url: string | null;
  content: string;
  highlightLines: number[];
}

export interface UpstreamChart {
  chart: string;
  repository: string;
  latestVersion: string | null;
  latestAppVersion: string | null;
  versionCount: number;
  source: 'helm-index' | 'oci-tags';
  unavailableReason: string | null;
  checkedAt: string;
}

export interface ScanStatus {
  running: boolean;
  done: number;
  total: number;
  completedAt: string | null;
  /** Seconds before another scan may start, 0 when one may start now */
  cooldownSeconds: number;
  failed: number;
}

export interface ApplicationInfo {
  name: string;
  chart: string | null;
  chartVersion: string | null;
  chartVersionOrigin: VersionOrigin | null;
  upstreamChart: string | null;
  upstreamRepository: string | null;
  appVersion: string | null;
  appVersionSource: 'image-tag' | 'chart-yaml' | null;
  /** The deployed chart declares `deprecated: true` in its Chart.yaml */
  deprecated: boolean;
  images: string[];
  syncStatus: string;
  healthStatus: string;
  revision: string | null;
}

export interface ApplicationSetResponse {
  name: string;
  namespace: string;
  generators: string[];
  applicationCount: number;
  syncedCount: number;
  applications: string[];
  syncedApplications: string[];
  applicationStatuses: Record<string, string>;
  applicationInfos: Record<string, ApplicationInfo>;
  charts: string[];
  chartVersions: string[];
  repoUrl: string;
  repoName: string;
  targetRevisions: string[];
  isHeadRevision: boolean;
  muted: boolean;
  createdAt: string;
}

export interface PluginStatus {
  cron: string;
  fetchCron: string;
  slackConfigured: boolean;
  lastFetchedAt: string | null;
  /**
   * Whether the backend can list Applications. Null before the first fetch.
   * False means every version field is empty because of a missing permission,
   * not because the charts carry no version.
   */
  applicationsReadable: boolean | null;
}

export interface BranchCommit {
  id: string;
  shortId: string;
  title: string;
  authorName: string;
  committedDate: string;
  webUrl: string | null;
}

export interface BranchInfo {
  name: string;
  isDefault: boolean;
  commit: BranchCommit | null;
}

export interface BranchListResponse {
  branches: BranchInfo[];
  defaultBranch: string | null;
}

export interface AuditLogEntry {
  id: string;
  seq: number;
  action: 'mute' | 'unmute' | 'set_target_revision';
  appsetNamespace: string;
  appsetName: string;
  userRef: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}
