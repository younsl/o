/**
 * A branch whose newest commit is older than its schedule's threshold.
 *
 * GitLab has no "branch created at" field. `commit.committed_date` on the
 * branch tip is the closest thing, so an old branch here means one nobody has
 * pushed to, not one that was opened long ago.
 */
export interface StaleBranch {
  projectId: number;
  projectName: string;
  /** `group/name` path with namespace. */
  projectPath: string;
  projectWebUrl: string;
  /** Branch list page of the project, the link the Slack message points at. */
  projectBranchesUrl: string;
  name: string;
  webUrl: string;
  /** ISO timestamp of the branch tip commit. */
  lastCommitAt: string;
  /** Whole days between the tip commit and the run. */
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
  /** Branches on the project, before the staleness filter. */
  branchCount: number;
  staleCount: number;
  /** Set when the project could not be scanned, which keeps it out of counts. */
  error: string | null;
}

/** The GitLab credentials every schedule scans through. One per instance. */
export interface GitlabConnection {
  apiBaseUrl: string | null;
  /** Write only. Masked before it leaves the backend. */
  gitlabToken: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ConnectionResponse {
  apiBaseUrl: string | null;
  /** Masked for display. The raw token never leaves the backend. */
  gitlabTokenMasked: string | null;
  /** Where the effective credentials come from. */
  source: 'database' | 'app-config' | 'integrations' | 'unset';
  configured: boolean;
  /** True when app-config pins the credentials, so the UI says it is read only. */
  managedByConfig: boolean;
  /** Username behind the effective token, filled in by a probe on request. */
  username: string | null;
  /** API roots app-config permits. The form may only save one of these. */
  allowedApiBaseUrls: string[];
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Reachability of the API root, answered without any credential. */
export interface EndpointProbeResult {
  reachable: boolean;
  /** HTTP status when something answered at all. */
  status: number | null;
  latencyMs: number;
  /** True when the answer is one only a GitLab API root gives. */
  looksLikeGitlab: boolean;
  error: string | null;
}

export interface CredentialProbeResult {
  reachable: boolean;
  /** HTTP status when GitLab answered at all. */
  status: number | null;
  latencyMs: number;
  error: string | null;
  /** Username behind the token, so an admin can tell which account it is. */
  username: string | null;
}

/**
 * One registered scan. Several can exist side by side, each with its own
 * projects, threshold, cron and Slack destination.
 */
export interface BranchSchedule {
  id: string;
  name: string;
  description: string | null;
  /** Project names or `group/path` values to scan. */
  projectNames: string[];
  thresholdDays: number;
  /** Branch names that never count as stale, on top of the default branch. */
  ignoredBranches: string[];
  ignoreProtected: boolean;
  /** Write only. Masked before it leaves the backend. */
  webhookUrl: string | null;
  /**
   * What the webhook points at, in words. A masked URL is the same string for
   * every Slack workspace, so without this nobody can tell which channel a
   * schedule reports to without opening the secret.
   */
  webhookDescription: string | null;
  webhookEnabled: boolean;
  cron: string;
  timezone: string;
  /** False pauses the schedule without deleting it or its history. */
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

export type RunState = 'running' | 'success' | 'failed';

/** One row in the run history. Carries counts, not the branches themselves. */
export interface RunSummary {
  id: string;
  scheduleId: string;
  state: RunState;
  /** `schedule` for an automatic run, otherwise the user entity ref. */
  triggeredBy: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  staleCount: number;
  totalBranches: number;
  projectCount: number;
  /**
   * Messages the run put on the webhook, after the already-reported filter.
   * On a dry run nothing is sent, and this carries what would have been, which
   * is only meaningful read together with `dryRun`.
   */
  notifiedCount: number;
  /**
   * True when the run scanned but was forbidden from sending, and left the
   * dedupe log untouched so a later real run still reports what it found.
   */
  dryRun: boolean;
  error: string | null;
}

/** A run with the result it produced, which is what the detail page reads. */
export interface RunDetail extends RunSummary {
  branches: StaleBranch[];
  projects: ScannedProject[];
  /** Configured names that matched no GitLab project. */
  unresolvedProjects: string[];
  thresholdDays: number;
}

export interface RunProgress {
  /** `resolving` while the configured names are matched against GitLab. */
  phase: 'resolving' | 'scanning';
  done: number;
  total: number;
  startedAt: string;
  staleFound: number;
}

/** A schedule as the list page reads it, with its recent history attached. */
export interface ScheduleSummary
  extends Omit<BranchSchedule, 'webhookUrl'> {
  /** Masked for display. The raw URL never leaves the backend. */
  webhookUrlMasked: string | null;
  /** Null when the cron cannot be parsed, or the schedule is paused. */
  nextRunAt: string | null;
  /** Newest first, for the run history strip. */
  recentRuns: RunSummary[];
  lastRun: RunSummary | null;
  running: boolean;
  progress: RunProgress | null;
}

/** Age bands the overview charts split stale branches into. */
export interface AgeBucket {
  id: string;
  label: string;
  /** Inclusive lower bound in days. */
  min: number;
  /** Exclusive upper bound, or null for the open ended top band. */
  max: number | null;
  count: number;
}

export interface ScheduleStaleCount {
  scheduleId: string;
  name: string;
  staleCount: number;
  totalBranches: number;
  /** Null when the schedule has never finished a run. */
  lastRunAt: string | null;
}

/**
 * Instance-wide totals, read off the newest finished run of each schedule.
 *
 * A paused schedule still counts: its last verdict is the newest one anybody
 * has, and hiding it would make the total drop for a reason nobody asked for.
 */
export interface OverviewStats {
  scheduleCount: number;
  enabledCount: number;
  pausedCount: number;
  /** Schedules with a run in flight right now. */
  runningCount: number;
  /** Schedules that have never finished a run, so they contribute no counts. */
  neverRunCount: number;
  staleCount: number;
  totalBranches: number;
  projectCount: number;
  /** Oldest stale branch across every schedule, in days. */
  oldestAgeDays: number;
  ageBuckets: AgeBucket[];
  bySchedule: ScheduleStaleCount[];
  /** Outcome counts over the runs the history keeps. */
  runsSucceeded: number;
  runsFailed: number;
  /** Newest finished run across every schedule. */
  lastRunAt: string | null;
}

export interface SchedulesResponse {
  schedules: ScheduleSummary[];
  stats: OverviewStats;
  connected: boolean;
  gitlabWebUrl: string | null;
  backstageUrl: string | null;
}

export interface CronPreview {
  valid: boolean;
  timezone: string;
  /** The next few fire times, so a cron can be read by what it does. */
  nextRuns: string[];
  error: string | null;
}

/** Fields a create or update accepts. Secrets are write only. */
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
