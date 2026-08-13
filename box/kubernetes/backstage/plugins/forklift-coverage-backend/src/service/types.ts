/**
 * `yes` means both the CI pipeline and a package-manager registry file point
 * at Forklift. `partial` means only one of the two does. `no` means the
 * project has GitLab CI but no Forklift wiring anywhere we looked.
 */
export type AppliedState = 'yes' | 'partial' | 'no' | 'error';

export interface ForkliftProject {
  id: number;
  /** `group/name` path with namespace. */
  path: string;
  group: string;
  name: string;
  webUrl: string;
  defaultBranch: string | null;
  topics: string[];
  applied: AppliedState;
  /** Branch the wiring was found on, or null when nothing was found. */
  branch: string | null;
  /** null when no wiring was found at all. */
  onDefault: boolean | null;
  /** Repository formats derived from the Forklift URL path, e.g. `npm/maven`. */
  format: string | null;
  ciWired: boolean;
  registryPinned: boolean;
  /** File paths that matched, used as the evidence trail in the UI. */
  evidence: string[];
  /** Scan remark such as `branches_truncated:10/28` or an API error. */
  note: string | null;
  /**
   * True when the project has no GitLab CI file at all. Such projects are not
   * integration candidates, so they are counted separately and excluded from
   * the coverage denominator.
   */
  skipped: boolean;
  lastActivityAt: string;
  /**
   * Why the project is out of scope: `manual`, `list`, `topic:<name>`, or
   * null when it counts. Kept on the scanned record rather than moving the
   * project to another list, so toggling the opt-out preserves the verdict.
   */
  excludeReason: string | null;
}

export interface ProjectDetail extends ForkliftProject {
  /**
   * False when the last scan produced no verdict for this project, either
   * because it was excluded at the time or because it was added since. The UI
   * shows that instead of a verdict it does not have.
   */
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

export interface CoverageSummary {
  /** Projects with GitLab CI. The coverage denominator. */
  target: number;
  applied: number;
  partial: number;
  notApplied: number;
  errored: number;
  /** Projects without GitLab CI, out of scope. */
  skipped: number;
  excluded: number;
  percent: number;
}

export interface ScanProgress {
  /** `listing` while the project list is still being paged in. */
  phase: 'listing' | 'scanning';
  /** Projects finished so far. Zero during the listing phase. */
  done: number;
  /** Projects to scan. Zero until the listing phase completes. */
  total: number;
  /** Projects dropped by the exclude list or an exclude topic. */
  excluded: number;
  startedAt: string;
  /** Rolling verdict counts so the page fills in as the scan runs. */
  applied: number;
  partial: number;
  notApplied: number;
  errored: number;
  skipped: number;
}

export interface CoverageResponse extends CoverageSummary {
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
  /** Message of the last scan that threw, cleared when a scan succeeds. */
  lastScanError: string | null;
  scanning: boolean;
  scanProgress: ScanProgress | null;
  gitlabHost: string | null;
  gitlabWebUrl: string | null;
  /** Backstage base URL, used to link the Slack report back to this page. */
  backstageUrl: string | null;
  /** False until a Forklift host is set, which sends the UI to the wizard. */
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

export interface WebhookConfig {
  url: string;
  enabled: boolean;
}

/** Runtime settings, editable in the UI and stored in the database. */
export interface ForkliftSettings {
  forkliftHost: string | null;
  webhookUrl: string | null;
  webhookEnabled: boolean;
  /** Null falls back to app-config and then the built-in default. */
  scanCron: string | null;
  timezone: string | null;
  autoScanEnabled: boolean | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ScheduleSettings {
  cron: string;
  timezone: string;
  autoScanEnabled: boolean;
  /** Next fire time in the configured timezone, for the wizard preview. */
  nextRunAt: string | null;
}

export interface SettingsResponse {
  forkliftHost: string | null;
  /** Masked for display. The raw URL never leaves the backend. */
  webhookUrlMasked: string | null;
  webhookEnabled: boolean;
  schedule: ScheduleSettings;
  /** Where the effective values come from. */
  source: 'database' | 'app-config' | 'unset';
  /** False until a Forklift host is known, which is what gates the wizard. */
  configured: boolean;
  /** True when app-config pins the host, so the UI can say it is read only. */
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
  /** HTTP status when the host answered at all. */
  status: number | null;
  latencyMs: number;
  error: string | null;
}

export interface PipelineFile {
  path: string;
  /** File body, truncated when it exceeds the per-file size cap. */
  content: string;
  truncated: boolean;
  /** True when the file references Forklift, so the UI can highlight it. */
  matchesForklift: boolean;
}

export interface PipelineResponse {
  projectPath: string;
  ref: string;
  files: PipelineFile[];
}
