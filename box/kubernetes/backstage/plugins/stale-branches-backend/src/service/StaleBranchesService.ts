import { LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { parseExpression } from 'cron-parser';
import { GitlabClient, NotFoundError } from './GitlabClient';
import { ConnectionStore } from './ConnectionStore';
import { RunStore } from './RunStore';
import {
  AgeBucket,
  BranchSchedule,
  OverviewStats,
  RunDetail,
  RunProgress,
  RunSummary,
  ScannedProject,
  StaleBranch,
} from './types';

/** Two weeks, the threshold the shell job this plugin replaces used. */
export const DEFAULT_THRESHOLD_DAYS = 14;

/**
 * Long-lived branches nobody is expected to clean up. The default branch is
 * always skipped on top of this, since it differs per project.
 */
export const DEFAULT_IGNORED_BRANCHES = [
  'master',
  'main',
  'develop',
  'devel',
  'master-sandbox',
  'master-stage',
];

export const DEFAULT_CRON = '0 10 * * 1-5';
export const DEFAULT_TIMEZONE = 'UTC';

/** Projects scanned at once. The client rate limits the requests underneath. */
const PROJECT_CONCURRENCY = 5;

/**
 * Age bands the overview splits stale branches into.
 *
 * The lowest band starts at zero rather than at a threshold, since each
 * schedule sets its own and a fixed floor would drop rows from the chart.
 */
const AGE_BANDS: Array<Omit<AgeBucket, 'count'>> = [
  { id: 'recent', label: 'Under 30d', min: 0, max: 30 },
  { id: 'month', label: '30 to 89d', min: 30, max: 90 },
  { id: 'quarter', label: '90 to 179d', min: 90, max: 180 },
  { id: 'stale', label: '180d and older', min: 180, max: null },
];

interface GitlabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  default_branch: string | null;
}

interface GitlabBranch {
  name: string;
  merged: boolean;
  protected: boolean;
  default: boolean;
  web_url: string;
  commit: {
    committed_date?: string;
    created_at?: string;
    author_name?: string;
    author_email?: string;
  };
}

export interface ResolvedCredentials {
  apiBaseUrl: string;
  token: string;
  /** Base of the GitLab web UI, derived from the API URL. */
  webBaseUrl: string;
  source: 'database' | 'app-config' | 'integrations';
}

/** Returns the next fire time, or null when the expression is not valid. */
export function nextRunAt(cron: string, timezone: string): string | null {
  try {
    return parseExpression(cron, { tz: timezone }).next().toDate().toISOString();
  } catch {
    return null;
  }
}

/**
 * The next `count` fire times.
 *
 * One timestamp does not show whether a cron repeats the way its author meant,
 * which is what makes `0 10 * * 1-5` and `0 10 1-5 * *` look alike until the
 * second run is on screen.
 */
export function nextRuns(
  cron: string,
  timezone: string,
  count: number,
): string[] {
  try {
    const interval = parseExpression(cron, { tz: timezone });
    const runs: string[] = [];
    for (let index = 0; index < count; index++) {
      runs.push(interval.next().toDate().toISOString());
    }
    return runs;
  } catch {
    return [];
  }
}

/**
 * True when the cron fired within the last minute in its own timezone.
 *
 * Backstage's scheduler cron is UTC only, so the task ticks every minute and
 * each schedule is gated here instead.
 */
export function isDueNow(
  cron: string,
  timezone: string,
  now: Date,
): boolean {
  try {
    const previous = parseExpression(cron, {
      tz: timezone,
      currentDate: now,
    })
      .prev()
      .toDate();
    return now.getTime() - previous.getTime() <= 60_000;
  } catch {
    return false;
  }
}

/** Stable identity of a branch across runs, used to dedupe notifications. */
export function branchKey(branch: StaleBranch): string {
  return `${branch.projectId}:${branch.name}`;
}

export interface StaleBranchesServiceOptions {
  config: Config;
  logger: LoggerService;
  connectionStore: ConnectionStore;
  runStore: RunStore;
}

export class StaleBranchesService {
  private readonly config: Config;
  private readonly logger: LoggerService;
  private readonly connectionStore: ConnectionStore;
  private readonly runStore: RunStore;

  private connection: Awaited<ReturnType<ConnectionStore['read']>> = null;
  /** Schedule id to its in-flight progress. Empty when nothing is running. */
  private readonly inFlight = new Map<string, RunProgress>();

  constructor(options: StaleBranchesServiceOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.connectionStore = options.connectionStore;
    this.runStore = options.runStore;
  }

  async refreshConnection(): Promise<void> {
    this.connection = await this.connectionStore.read();
  }

  isRunning(scheduleId: string): boolean {
    return this.inFlight.has(scheduleId);
  }

  getProgress(scheduleId: string): RunProgress | null {
    return this.inFlight.get(scheduleId) ?? null;
  }

  /**
   * Database first, then app-config, then the integrations block.
   *
   * The UI is the intended source. The config paths exist so an instance can be
   * shipped pre-wired, and an instance already talking to this GitLab has the
   * same pair in its integrations block.
   */
  getCredentials(): ResolvedCredentials | null {
    const build = (
      apiBaseUrl: string,
      token: string,
      source: ResolvedCredentials['source'],
    ): ResolvedCredentials => ({
      apiBaseUrl,
      token,
      webBaseUrl: apiBaseUrl.replace(/\/api\/v\d+\/?$/, ''),
      source,
    });

    if (this.connection?.apiBaseUrl && this.connection.gitlabToken) {
      return build(
        this.connection.apiBaseUrl,
        this.connection.gitlabToken,
        'database',
      );
    }

    const configBase = this.config.getOptional('staleBranches.apiBaseUrl');
    const configToken = this.config.getOptional('staleBranches.token');
    const fromConfigBase =
      typeof configBase === 'string' ? configBase.trim() : '';
    const fromConfigToken =
      typeof configToken === 'string' ? configToken.trim() : '';

    // A half-set database row still contributes, so an admin who saved only a
    // URL keeps the token from wherever it was already coming from.
    const apiBaseUrl = this.connection?.apiBaseUrl || fromConfigBase;
    const token = this.connection?.gitlabToken || fromConfigToken;
    if (apiBaseUrl && token) {
      return build(
        apiBaseUrl,
        token,
        this.connection?.apiBaseUrl ? 'database' : 'app-config',
      );
    }

    const integrations =
      this.config.getOptionalConfigArray('integrations.gitlab') ?? [];
    const first = integrations[0];
    if (!first) return null;
    const host = first.getOptionalString('host');
    const integrationUrl =
      apiBaseUrl ||
      first.getOptionalString('apiBaseUrl') ||
      (host ? `https://${host}/api/v4` : '');
    const integrationToken = token || first.getOptionalString('token') || '';
    if (!integrationUrl || !integrationToken) return null;
    return build(integrationUrl, integrationToken, 'integrations');
  }

  /** True when app-config pins the URL, which the UI reports as read only. */
  isManagedByConfig(): boolean {
    const base = this.config.getOptional('staleBranches.apiBaseUrl');
    return typeof base === 'string' && base.trim() !== '';
  }

  isConnected(): boolean {
    return !!this.getCredentials();
  }

  getGitlabWebUrl(): string | null {
    return this.getCredentials()?.webBaseUrl ?? null;
  }

  getBackstageUrl(): string | null {
    return this.config.getOptionalString('app.baseUrl') ?? null;
  }

  private client(credentials: ResolvedCredentials): GitlabClient {
    return new GitlabClient({
      apiBaseUrl: credentials.apiBaseUrl,
      token: credentials.token,
      logger: this.logger,
    });
  }

  /**
   * Matches configured names against GitLab projects.
   *
   * `search` is a substring match, so the result is filtered down to an exact
   * hit on either the project name or its full path. A bare name that exists in
   * more than one group resolves to every one of them, which is why the path
   * form is the one to prefer.
   */
  private async resolveProjects(
    client: GitlabClient,
    names: string[],
  ): Promise<{ projects: GitlabProject[]; unresolved: string[] }> {
    const byId = new Map<number, GitlabProject>();
    const unresolved: string[] = [];

    for (const name of names) {
      const wanted = name.trim().toLowerCase();
      if (!wanted) continue;
      const term = wanted.includes('/') ? wanted.split('/').pop()! : wanted;
      let candidates: GitlabProject[] = [];
      try {
        candidates = await client.getJsonPages<GitlabProject>(
          `/projects?search=${encodeURIComponent(term)}&simple=true&order_by=id&sort=asc`,
        );
      } catch (err) {
        this.logger.warn(`[stale-branches] lookup of '${name}' failed: ${err}`);
      }

      const matches = candidates.filter(
        project =>
          project.name?.toLowerCase() === wanted ||
          project.path_with_namespace?.toLowerCase() === wanted,
      );
      if (matches.length === 0) {
        unresolved.push(name);
        continue;
      }
      for (const match of matches) byId.set(match.id, match);
    }

    return { projects: [...byId.values()], unresolved };
  }

  private async scanProject(
    client: GitlabClient,
    project: GitlabProject,
    schedule: BranchSchedule,
    ignored: Set<string>,
    now: number,
  ): Promise<{ summary: ScannedProject; stale: StaleBranch[] }> {
    const summary: ScannedProject = {
      id: project.id,
      name: project.name,
      path: project.path_with_namespace,
      webUrl: project.web_url,
      branchCount: 0,
      staleCount: 0,
      error: null,
    };

    let branches: GitlabBranch[];
    try {
      branches = await client.getJsonPages<GitlabBranch>(
        `/projects/${project.id}/repository/branches`,
      );
    } catch (err) {
      summary.error =
        err instanceof NotFoundError
          ? 'No access to the repository'
          : err instanceof Error
            ? err.message
            : String(err);
      return { summary, stale: [] };
    }

    summary.branchCount = branches.length;
    const stale: StaleBranch[] = [];

    for (const branch of branches) {
      if (branch.default) continue;
      if (ignored.has(branch.name.toLowerCase())) continue;
      if (schedule.ignoreProtected && branch.protected) continue;

      // GitLab exposes no branch creation time. The tip commit date is what
      // "old" is measured against, so the verdict is really "not pushed to
      // since", which is the signal worth acting on anyway.
      const tip = branch.commit?.committed_date ?? branch.commit?.created_at;
      if (!tip) continue;
      const tipMs = Date.parse(tip);
      if (!Number.isFinite(tipMs)) continue;

      const ageDays = Math.floor((now - tipMs) / 86_400_000);
      if (ageDays < schedule.thresholdDays) continue;

      stale.push({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path_with_namespace,
        projectWebUrl: project.web_url,
        projectBranchesUrl: `${project.web_url}/-/branches`,
        name: branch.name,
        webUrl:
          branch.web_url ||
          `${project.web_url}/-/tree/${encodeURIComponent(branch.name)}`,
        lastCommitAt: new Date(tipMs).toISOString(),
        ageDays,
        authorName: branch.commit?.author_name ?? 'unknown',
        authorEmail: branch.commit?.author_email ?? '',
        isProtected: !!branch.protected,
        merged: !!branch.merged,
      });
    }

    summary.staleCount = stale.length;
    return { summary, stale };
  }

  /**
   * Runs one schedule and records the outcome.
   *
   * Every exit records a run, including a failure, so the history shows what
   * happened rather than a gap where a run should have been.
   */
  async run(
    schedule: BranchSchedule,
    triggeredBy: string,
    dryRun = false,
  ): Promise<RunDetail> {
    if (this.inFlight.has(schedule.id)) {
      throw new Error('A run is already in progress for this schedule');
    }
    const credentials = this.getCredentials();
    if (!credentials) {
      throw new Error('GitLab connection is not configured');
    }
    if (schedule.projectNames.length === 0) {
      throw new Error('The schedule has no projects');
    }

    const startedAt = new Date();
    const run = await this.runStore.start(schedule.id, triggeredBy, dryRun);
    this.inFlight.set(schedule.id, {
      phase: 'resolving',
      done: 0,
      total: 0,
      startedAt: startedAt.toISOString(),
      staleFound: 0,
    });

    try {
      const client = this.client(credentials);
      const ignored = new Set(
        schedule.ignoredBranches.map(name => name.toLowerCase()),
      );
      const now = startedAt.getTime();

      const { projects, unresolved } = await this.resolveProjects(
        client,
        schedule.projectNames,
      );
      this.inFlight.set(schedule.id, {
        ...this.inFlight.get(schedule.id)!,
        phase: 'scanning',
        total: projects.length,
      });

      const summaries: ScannedProject[] = [];
      const stale: StaleBranch[] = [];
      let cursor = 0;

      const worker = async () => {
        for (;;) {
          const index = cursor++;
          if (index >= projects.length) return;
          const outcome = await this.scanProject(
            client,
            projects[index],
            schedule,
            ignored,
            now,
          );
          summaries.push(outcome.summary);
          stale.push(...outcome.stale);
          const progress = this.inFlight.get(schedule.id);
          if (progress) {
            this.inFlight.set(schedule.id, {
              ...progress,
              done: progress.done + 1,
              staleFound: stale.length,
            });
          }
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(PROJECT_CONCURRENCY, projects.length) },
          worker,
        ),
      );

      // Oldest first: the branch at the top is the one that has been sitting
      // the longest, which is the order a cleanup is worked through.
      stale.sort((a, b) => b.ageDays - a.ageDays);
      summaries.sort((a, b) => a.path.localeCompare(b.path));

      const totalBranches = summaries.reduce(
        (sum, project) => sum + project.branchCount,
        0,
      );
      await this.runStore.finish(run.id, {
        state: 'success',
        staleCount: stale.length,
        totalBranches,
        projectCount: summaries.length,
        error: null,
        payload: {
          branches: stale,
          projects: summaries,
          unresolvedProjects: unresolved,
          thresholdDays: schedule.thresholdDays,
        },
      });

      this.logger.info(
        `[stale-branches] '${schedule.name}'${dryRun ? ' (dry run)' : ''} scanned ${summaries.length} projects, ${stale.length} stale over ${schedule.thresholdDays} days`,
      );

      const detail = await this.runStore.get(run.id);
      if (!detail) throw new Error('The run record disappeared mid-run');
      return detail;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.runStore.finish(run.id, {
        state: 'failed',
        staleCount: 0,
        totalBranches: 0,
        projectCount: 0,
        error: message,
        payload: null,
      });
      this.logger.error(
        `[stale-branches] '${schedule.name}' run failed: ${message}`,
      );
      throw err;
    } finally {
      this.inFlight.delete(schedule.id);
    }
  }

  /**
   * Instance-wide totals, read off the newest finished run of each schedule.
   *
   * A schedule that has never finished a run contributes nothing but is counted
   * separately, so a zero total cannot be mistaken for a clean estate.
   */
  async buildOverview(
    schedules: BranchSchedule[],
    recentRuns: Map<string, RunSummary[]>,
  ): Promise<OverviewStats> {
    const buckets: AgeBucket[] = AGE_BANDS.map(band => ({ ...band, count: 0 }));
    const bySchedule: OverviewStats['bySchedule'] = [];
    let staleCount = 0;
    let totalBranches = 0;
    let projectCount = 0;
    let oldestAgeDays = 0;
    let neverRunCount = 0;
    let lastRunAt: string | null = null;

    for (const schedule of schedules) {
      const latest = await this.runStore.latestFinished(schedule.id);
      if (!latest || latest.state !== 'success') {
        neverRunCount++;
        bySchedule.push({
          scheduleId: schedule.id,
          name: schedule.name,
          staleCount: 0,
          totalBranches: 0,
          lastRunAt: latest?.finishedAt ?? null,
        });
        continue;
      }

      staleCount += latest.staleCount;
      totalBranches += latest.totalBranches;
      projectCount += latest.projectCount;
      bySchedule.push({
        scheduleId: schedule.id,
        name: schedule.name,
        staleCount: latest.staleCount,
        totalBranches: latest.totalBranches,
        lastRunAt: latest.finishedAt,
      });
      if (
        latest.finishedAt &&
        (!lastRunAt || latest.finishedAt > lastRunAt)
      ) {
        lastRunAt = latest.finishedAt;
      }

      for (const branch of latest.branches) {
        if (branch.ageDays > oldestAgeDays) oldestAgeDays = branch.ageDays;
        const bucket = buckets.find(
          band =>
            branch.ageDays >= band.min &&
            (band.max === null || branch.ageDays < band.max),
        );
        if (bucket) bucket.count++;
      }
    }

    let runsSucceeded = 0;
    let runsFailed = 0;
    for (const runs of recentRuns.values()) {
      for (const run of runs) {
        if (run.state === 'success') runsSucceeded++;
        else if (run.state === 'failed') runsFailed++;
      }
    }

    // Biggest first, so the chart puts the schedule worth acting on at the top.
    bySchedule.sort((a, b) => b.staleCount - a.staleCount);

    return {
      scheduleCount: schedules.length,
      enabledCount: schedules.filter(schedule => schedule.enabled).length,
      pausedCount: schedules.filter(schedule => !schedule.enabled).length,
      runningCount: schedules.filter(schedule => this.isRunning(schedule.id))
        .length,
      neverRunCount,
      staleCount,
      totalBranches,
      projectCount,
      oldestAgeDays,
      ageBuckets: buckets,
      bySchedule,
      runsSucceeded,
      runsFailed,
      lastRunAt,
    };
  }
}
