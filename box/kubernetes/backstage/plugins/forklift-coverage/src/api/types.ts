export type AppliedState = 'yes' | 'partial' | 'no' | 'error';

export interface ForkliftProject {
  id: number;
  path: string;
  group: string;
  name: string;
  webUrl: string;
  defaultBranch: string | null;
  topics: string[];
  applied: AppliedState;
  branch: string | null;
  onDefault: boolean | null;
  format: string | null;
  ciWired: boolean;
  registryPinned: boolean;
  evidence: string[];
  note: string | null;
  skipped: boolean;
  lastActivityAt: string;
  /** `manual`, `list`, `topic:<name>`, or null when the project counts. */
  excludeReason: string | null;
}

export interface ProjectDetail extends ForkliftProject {
  /** False when the last scan produced no verdict for this project. */
  scanned: boolean;
}

export interface ExcludedProject {
  id: number;
  path: string;
  group: string;
  name: string;
  webUrl: string;
  defaultBranch: string | null;
  topics: string[];
  /** `topic:<name>` or `list`. */
  reason: string;
  lastActivityAt: string;
}

export interface ScanProgress {
  phase: 'listing' | 'scanning';
  done: number;
  total: number;
  excluded: number;
  startedAt: string;
  applied: number;
  partial: number;
  notApplied: number;
  errored: number;
  skipped: number;
}

export interface CoverageResponse {
  target: number;
  applied: number;
  partial: number;
  notApplied: number;
  errored: number;
  skipped: number;
  excluded: number;
  percent: number;
  projects: ForkliftProject[];
  excludedProjects: ExcludedProject[];
  lastScannedAt: string | null;
  lastScanDurationMs: number | null;
  /**
   * Who started the last scan: a user entity reference for a manual run, or
   * `schedule` / `startup` for the two automatic ones. Null for a result stored
   * before this was recorded.
   */
  lastScanTriggeredBy: string | null;
  lastScanError: string | null;
  scanning: boolean;
  scanProgress: ScanProgress | null;
  gitlabHost: string | null;
  gitlabWebUrl: string | null;
  backstageUrl: string | null;
  configured: boolean;
  forkliftHost: string | null;
  scanCron: string;
  timezone: string;
  webhookConfigured: boolean;
}

export interface GroupCoverage {
  group: string;
  target: number;
  applied: number;
  partial: number;
  notApplied: number;
  percent: number;
}

export interface PipelineFile {
  path: string;
  content: string;
  truncated: boolean;
  matchesForklift: boolean;
}

export interface PipelineResponse {
  projectPath: string;
  ref: string;
  files: PipelineFile[];
}

export interface ScheduleSettings {
  cron: string;
  timezone: string;
  autoScanEnabled: boolean;
  /** Next fire time in the configured timezone. Null when the cron is bad. */
  nextRunAt: string | null;
}

export interface SettingsResponse {
  forkliftHost: string | null;
  /** Masked for display. The raw URL never leaves the backend. */
  webhookUrlMasked: string | null;
  webhookEnabled: boolean;
  schedule: ScheduleSettings;
  source: 'database' | 'app-config' | 'unset';
  configured: boolean;
  managedByConfig: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface LastCommit {
  ref: string;
  shortId: string;
  title: string;
  authorName: string;
  committedAt: string;
  webUrl: string | null;
}

export interface HostProbeResult {
  reachable: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
}

export interface CoverageSnapshot {
  id: string;
  target: number;
  applied: number;
  partial: number;
  notApplied: number;
  skipped: number;
  percent: number;
  scannedAt: string;
}
