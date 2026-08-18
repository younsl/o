export interface StaleBranch {
  projectId: number;
  projectName: string;
  projectPath: string;
  projectWebUrl: string;
  projectBranchesUrl: string;
  name: string;
  webUrl: string;
  lastCommitAt: string;
  ageDays: number;
  authorName: string;
  authorEmail: string;
  isProtected: boolean;
  merged: boolean;
}

export interface ScannedProject {
  id: number;
  name: string;
  path: string;
  webUrl: string;
  branchCount: number;
  staleCount: number;
  error: string | null;
}

export type RunState = 'running' | 'success' | 'failed';

export interface RunSummary {
  id: string;
  scheduleId: string;
  state: RunState;
  triggeredBy: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  staleCount: number;
  totalBranches: number;
  projectCount: number;
  /** Messages sent, or on a dry run the count that would have been sent. */
  notifiedCount: number;
  /** True when the run scanned but was forbidden from sending. */
  dryRun: boolean;
  error: string | null;
}

export interface RunDetail extends RunSummary {
  branches: StaleBranch[];
  projects: ScannedProject[];
  unresolvedProjects: string[];
  thresholdDays: number;
}

export interface RunProgress {
  phase: 'resolving' | 'scanning';
  done: number;
  total: number;
  startedAt: string;
  staleFound: number;
}

export interface ScheduleSummary {
  id: string;
  name: string;
  description: string | null;
  projectNames: string[];
  thresholdDays: number;
  ignoredBranches: string[];
  ignoreProtected: boolean;
  webhookUrlMasked: string | null;
  /** What the webhook points at, in words, since the URL is only ever masked. */
  webhookDescription: string | null;
  webhookEnabled: boolean;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  recentRuns: RunSummary[];
  lastRun: RunSummary | null;
  running: boolean;
  progress: RunProgress | null;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface AgeBucket {
  id: string;
  label: string;
  min: number;
  max: number | null;
  count: number;
}

export interface ScheduleStaleCount {
  scheduleId: string;
  name: string;
  staleCount: number;
  totalBranches: number;
  lastRunAt: string | null;
}

export interface OverviewStats {
  scheduleCount: number;
  enabledCount: number;
  pausedCount: number;
  runningCount: number;
  neverRunCount: number;
  staleCount: number;
  totalBranches: number;
  projectCount: number;
  oldestAgeDays: number;
  ageBuckets: AgeBucket[];
  bySchedule: ScheduleStaleCount[];
  runsSucceeded: number;
  runsFailed: number;
  lastRunAt: string | null;
}

export interface SchedulesResponse {
  schedules: ScheduleSummary[];
  stats: OverviewStats;
  connected: boolean;
  gitlabWebUrl: string | null;
  backstageUrl: string | null;
}

export interface ConnectionResponse {
  apiBaseUrl: string | null;
  gitlabTokenMasked: string | null;
  source: 'database' | 'app-config' | 'integrations' | 'unset';
  configured: boolean;
  managedByConfig: boolean;
  username: string | null;
  /** API roots app-config permits. The form may only save one of these. */
  allowedApiBaseUrls: string[];
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface EndpointProbeResult {
  reachable: boolean;
  status: number | null;
  latencyMs: number;
  /** True when the answer is one only a GitLab API root gives. */
  looksLikeGitlab: boolean;
  error: string | null;
}

export interface CredentialProbeResult {
  reachable: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
  username: string | null;
}

export interface CronPreview {
  valid: boolean;
  timezone: string;
  nextRuns: string[];
  error: string | null;
}

/** Fields the create and edit forms submit. Secrets are write only. */
export interface ScheduleInput {
  name: string;
  description?: string | null;
  projectNames: string[];
  thresholdDays: number;
  ignoredBranches: string[];
  ignoreProtected: boolean;
  /** Empty keeps the stored URL, which the UI only ever sees masked. */
  webhookUrl?: string;
  webhookDescription?: string | null;
  webhookEnabled: boolean;
  cron: string;
  timezone: string;
  enabled: boolean;
}
