import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import { parseExpression } from 'cron-parser';
import { GitlabClient, NotFoundError } from './GitlabClient';
import { CoverageHistoryStore } from './CoverageHistoryStore';
import { SettingsStore } from './SettingsStore';
import { ResultStore } from './ResultStore';
import { ExclusionStore } from './ExclusionStore';
import { readWebhookFromConfig } from './SlackNotifier';
import {
  AppliedState,
  CoverageResponse,
  CoverageSummary,
  ExcludedProject,
  ForkliftProject,
  GroupCoverage,
  PipelineFile,
  PipelineResponse,
  ProjectDetail,
  LastCommit,
  ScanProgress,
  ScheduleSettings,
} from './types';

/** GitLab CI entrypoints, including `.gitlab-ci.<suffix>.yml` and `ci/*.yml`. */
const CI_FILE_RE =
  /(^|\/)\.gitlab-ci([-.][A-Za-z0-9_-]+)?\.ya?ml$|^(\.gitlab\/)?ci\/.*\.ya?ml$/;

/** Package-manager and image build files that can pin a registry. */
const REGISTRY_FILE_RE =
  /(^|\/)(\.npmrc|\.yarnrc|\.yarnrc\.yml|package\.json|pnpm-workspace\.yaml|settings\.xml|pom\.xml|build\.gradle|build\.gradle\.kts|settings\.gradle|settings\.gradle\.kts|gradle\.properties|init\.gradle|init\.gradle\.kts|pip\.conf|pip\.ini|requirements[A-Za-z0-9_.-]*\.txt|pyproject\.toml|poetry\.toml|Dockerfile[A-Za-z0-9_.-]*)$/;

const VENDOR_RE = /(^|\/)(node_modules|vendor|\.git|dist|build\/generated)\//;

/** CI jobs often reference the token instead of the host directly. */
const TOKEN_RE = /FORKLIFT_[A-Z0-9_]*TOKEN/;

const DEFAULT_EXCLUDE_TOPIC = 'forklift.excluded';

/** Weekdays at 10:00 in the configured timezone. */
export const DEFAULT_CRON = '0 10 * * 1-5';

/** Per-file cap for the pipeline viewer so one huge YAML cannot flood the UI. */
const PIPELINE_FILE_MAX_BYTES = 128 * 1024;

/** At most this many CI files are returned for one ref. */
const PIPELINE_MAX_FILES = 20;

interface RawProject {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  default_branch: string | null;
  topics?: string[];
  last_activity_at: string;
}

interface RawBranch {
  name: string;
  commit: { committed_date: string };
}

interface RawTreeEntry {
  type: string;
  path: string;
}

interface RawCommit {
  short_id: string;
  title: string;
  author_name: string;
  committed_date: string;
  web_url?: string;
}

interface RawBlobHit {
  path: string;
  data: string;
}

interface BranchVerdict {
  hasCI: boolean;
  hit: boolean;
  ciWired: boolean;
  registryPinned: boolean;
  format: string | null;
  evidence: string[];
}

const EMPTY_VERDICT: BranchVerdict = {
  hasCI: false,
  hit: false,
  ciWired: false,
  registryPinned: false,
  format: null,
  evidence: [],
};

/**
 * Backstage throws on an empty string where a string is expected, so a
 * `group: ''` placeholder in app-config would fail the whole scan. Treat empty
 * as unset instead.
 */
function optionalString(config: Config, key: string): string | undefined {
  const raw = config.getOptional(key);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Null when the expression does not parse, which the caller reports as such. */
export function nextRunAt(cron: string, timezone: string): string | null {
  try {
    return parseExpression(cron, { tz: timezone }).next().toDate().toISOString();
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitPath(fullPath: string): { group: string; name: string } {
  const idx = fullPath.lastIndexOf('/');
  if (idx < 0) return { group: '', name: fullPath };
  return { group: fullPath.slice(0, idx), name: fullPath.slice(idx + 1) };
}

/** Falls back to guessing the format from filenames when no URL was matched. */
function classifyByFilename(paths: string[]): string | null {
  const joined = paths.join(',');
  const out: string[] = [];
  if (/\.npmrc|\.yarnrc|package\.json|pnpm-workspace/.test(joined)) out.push('npm');
  if (/gradle|pom\.xml|settings\.xml/.test(joined)) out.push('maven');
  if (/pip\.(conf|ini)|requirements.*\.txt|pyproject|poetry/.test(joined)) {
    out.push('pypi');
  }
  if (joined.includes('Dockerfile')) out.push('dockerfile');
  return out.length > 0 ? out.join('/') : null;
}

export interface ForkliftCoverageServiceOptions {
  config: Config;
  logger: LoggerService;
  settingsStore: SettingsStore;
  resultStore: ResultStore;
  exclusionStore: ExclusionStore;
  historyStore?: CoverageHistoryStore;
}

export class ForkliftCoverageService {
  private readonly config: Config;
  private readonly logger: LoggerService;
  private readonly settingsStore: SettingsStore;
  private readonly resultStore: ResultStore;
  private readonly exclusionStore: ExclusionStore;
  private readonly historyStore?: CoverageHistoryStore;

  /**
   * Effective host, resolved from the database first and app-config second.
   * Null until an admin completes the setup wizard, which is what keeps the
   * plugin usable with no app-config at all.
   */
  private forkliftHost: string | null = null;
  private hostFormatRe: RegExp | null = null;
  private webhookReady = false;
  private schedule: ScheduleSettings = {
    cron: DEFAULT_CRON,
    timezone: 'UTC',
    autoScanEnabled: true,
    nextRunAt: null,
  };
  private readonly excludePaths: Set<string>;
  private readonly excludeTopics: Set<string>;
  /** Paths toggled off in the UI, reloaded from the database on change. */
  private manualExclusions = new Set<string>();

  private projects: ForkliftProject[] = [];
  private excludedProjects: ExcludedProject[] = [];
  private lastScannedAt: string | null = null;
  private lastScanDurationMs: number | null = null;
  private lastScanTriggeredBy: string | null = null;
  private lastScanError: string | null = null;
  private scanning = false;
  private scanProgress: ScanProgress | null = null;

  constructor(options: ForkliftCoverageServiceOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.settingsStore = options.settingsStore;
    this.resultStore = options.resultStore;
    this.exclusionStore = options.exclusionStore;
    this.historyStore = options.historyStore;

    this.excludePaths = new Set(
      this.config.getOptionalStringArray('forkliftCoverage.scope.exclude') ?? [],
    );
    const topics = this.config.getOptionalStringArray(
      'forkliftCoverage.scope.excludeTopics',
    ) ?? [DEFAULT_EXCLUDE_TOPIC];
    this.excludeTopics = new Set(topics.map(t => t.trim().toLowerCase()));
  }

  /** Host pinned in app-config, which makes the UI settings read only. */
  private configuredHost(): string | null {
    return optionalString(this.config, 'forkliftCoverage.forkliftHost') ?? null;
  }

  /**
   * Re-reads the stored settings into memory. Called at boot, before each
   * scan, and right after an admin saves, so the rest of the class can stay
   * synchronous.
   */
  async refreshSettings(): Promise<void> {
    const stored = await this.settingsStore.read();
    const host = stored?.forkliftHost ?? this.configuredHost();
    this.forkliftHost = host;

    const webhook = stored?.webhookUrl
      ? { url: stored.webhookUrl, enabled: stored.webhookEnabled }
      : readWebhookFromConfig(this.config);
    this.webhookReady = !!webhook?.url && !!webhook?.enabled;

    const cron =
      stored?.scanCron ??
      optionalString(this.config, 'forkliftCoverage.schedule.cron') ??
      DEFAULT_CRON;
    const timezone =
      stored?.timezone ??
      optionalString(this.config, 'forkliftCoverage.schedule.timezone') ??
      'UTC';
    const autoScanEnabled =
      stored?.autoScanEnabled ??
      this.config.getOptionalBoolean('forkliftCoverage.schedule.enabled') ??
      true;
    this.schedule = {
      cron,
      timezone,
      autoScanEnabled,
      nextRunAt: nextRunAt(cron, timezone),
    };

    // The first path segment after the host is the repository format:
    //   https://forklift.example.com/npm/npmjs/ -> npm
    this.hostFormatRe = host
      ? new RegExp(`${escapeRegExp(host)}/([a-z0-9-]+)`, 'g')
      : null;
  }

  getForkliftHost(): string | null {
    return this.forkliftHost;
  }

  getSchedule(): ScheduleSettings {
    return this.schedule;
  }

  /**
   * Loads the last completed scan at boot, so a restart shows the previous
   * result instead of an empty page. Results are only ever replaced by a
   * scheduled run or a manual scan.
   */
  async restoreLastResult(): Promise<void> {
    const stored = await this.resultStore.read();
    if (!stored) return;
    // Results written before excludeReason existed have no such field, so it
    // is normalised here rather than left undefined across the codebase.
    this.projects = stored.projects.map(project => ({
      ...project,
      excludeReason: project.excludeReason ?? null,
    }));
    this.excludedProjects = stored.excludedProjects;
    this.lastScannedAt = stored.scannedAt;
    this.lastScanDurationMs = stored.durationMs;
    this.lastScanTriggeredBy = stored.triggeredBy ?? null;
    this.logger.info(
      `[forklift-coverage] restored ${stored.projects.length} projects from the scan at ${stored.scannedAt}`,
    );
  }

  isConfigured(): boolean {
    return !!this.forkliftHost;
  }

  /** Effective webhook, database first and app-config second. */
  async getEffectiveWebhook(): Promise<{ url: string | null; enabled: boolean }> {
    const stored = await this.settingsStore.read();
    if (stored && stored.webhookUrl) {
      return { url: stored.webhookUrl, enabled: stored.webhookEnabled };
    }
    const fromConfig = readWebhookFromConfig(this.config);
    return {
      url: fromConfig?.url ?? null,
      enabled: fromConfig?.enabled ?? false,
    };
  }

  async isWebhookConfigured(): Promise<boolean> {
    const webhook = await this.getEffectiveWebhook();
    return !!webhook.url && webhook.enabled;
  }

  isScanning(): boolean {
    return this.scanning;
  }

  private getGitlabConfig(): {
    apiBaseUrl: string;
    token: string;
    host: string;
    webBaseUrl: string;
  } {
    const integrations =
      this.config.getOptionalConfigArray('integrations.gitlab') ?? [];
    const first = integrations[0];
    if (!first) {
      throw new Error('No GitLab integration configured in integrations.gitlab');
    }
    const host = first.getString('host');
    const token = first.getString('token');
    const apiBaseUrl =
      first.getOptionalString('apiBaseUrl') ?? `https://${host}/api/v4`;
    const webBaseUrl = apiBaseUrl.replace(/\/api\/v\d+\/?$/, '');
    return { apiBaseUrl, token, host, webBaseUrl };
  }

  private newClient(): GitlabClient {
    const { apiBaseUrl, token } = this.getGitlabConfig();
    return new GitlabClient({
      apiBaseUrl,
      token,
      logger: this.logger,
      rps: this.config.getOptionalNumber('forkliftCoverage.scan.rps') ?? 20,
      retries: this.config.getOptionalNumber('forkliftCoverage.scan.retries') ?? 3,
      cooldownSeconds:
        this.config.getOptionalNumber('forkliftCoverage.scan.cooldownSeconds') ?? 30,
    });
  }

  /** Re-reads the UI managed opt-outs. */
  async refreshExclusions(): Promise<void> {
    const rows = await this.exclusionStore.list();
    this.manualExclusions = new Set(rows.map(row => row.projectPath));
  }

  /**
   * Toggles a project out of, or back into, the scan.
   *
   * Excluding also moves an already scanned project across in memory, so the
   * page and the coverage number react immediately instead of waiting for the
   * next scan. Re-including cannot invent a verdict, so the project only
   * reappears in the table once it has been scanned again.
   */
  async setManualExclusion(
    projectPath: string,
    excluded: boolean,
    actor: string | null,
  ): Promise<void> {
    if (excluded) {
      await this.exclusionStore.add(projectPath, actor);
    } else {
      await this.exclusionStore.remove(projectPath);
    }
    await this.refreshExclusions();

    // The verdict stays on the record either way, so the coverage number
    // reacts immediately and the toggle is reversible without a rescan.
    const project = this.projects.find(p => p.path === projectPath);
    if (project) {
      project.excludeReason = excluded ? 'manual' : null;
    } else if (!excluded) {
      // Never scanned, only listed as excluded. It returns to the table on
      // the next scan.
      this.excludedProjects = this.excludedProjects.filter(
        p => !(p.path === projectPath && p.reason === 'manual'),
      );
    }

    await this.persistResult();
    this.logger.info(
      `[forklift-coverage] ${projectPath} ${excluded ? 'excluded' : 'included'} by ${actor ?? 'unknown'}`,
    );
  }

  /** Writes the current in-memory result so a restart keeps it. */
  private async persistResult(): Promise<void> {
    if (!this.lastScannedAt) return;
    await this.resultStore.write({
      projects: this.projects,
      excludedProjects: this.excludedProjects,
      scannedAt: this.lastScannedAt,
      durationMs: this.lastScanDurationMs,
      triggeredBy: this.lastScanTriggeredBy,
      forkliftHost: this.forkliftHost,
    });
  }

  /** Returns the exclusion reason, or null when the project is in scope. */
  private excludeReason(raw: RawProject): string | null {
    const { name } = splitPath(raw.path_with_namespace);
    if (this.manualExclusions.has(raw.path_with_namespace)) return 'manual';
    if (
      this.excludePaths.has(raw.path_with_namespace) ||
      this.excludePaths.has(name)
    ) {
      return 'list';
    }
    for (const topic of raw.topics ?? []) {
      if (this.excludeTopics.has(topic.trim().toLowerCase())) {
        return `topic:${topic}`;
      }
    }
    return null;
  }

  /**
   * `triggeredBy` names whoever asked for this scan: a user entity reference
   * from the manual endpoint, or `schedule` / `startup` for the automatic runs.
   * It is recorded only once the scan succeeds, so a failed run cannot rewrite
   * the attribution of the result still on the page.
   */
  async scan(triggeredBy: string = 'schedule'): Promise<void> {
    if (this.scanning) {
      this.logger.info('[forklift-coverage] scan already in progress, skipping');
      return;
    }
    // Settings can change between scans, so resolve them up front rather than
    // trusting whatever the last refresh cached.
    await this.refreshSettings();
    await this.refreshExclusions();
    if (!this.forkliftHost) {
      throw new Error(
        'Forklift host is not configured. Complete the setup first.',
      );
    }

    this.scanning = true;
    const startedAt = Date.now();
    // Published before the first API call so the page can show the scan is
    // alive while the project list is still paging in.
    this.scanProgress = {
      phase: 'listing',
      done: 0,
      total: 0,
      excluded: 0,
      startedAt: new Date(startedAt).toISOString(),
      applied: 0,
      partial: 0,
      notApplied: 0,
      errored: 0,
      skipped: 0,
    };

    try {
      const client = this.newClient();
      const { candidates, excluded } = await this.listProjects(client);
      this.excludedProjects = excluded;
      this.scanProgress = {
        ...this.scanProgress,
        phase: 'scanning',
        total: candidates.length,
        excluded: excluded.length,
      };
      this.logger.info(
        `[forklift-coverage] scanning ${candidates.length} projects (${excluded.length} excluded)`,
      );

      const concurrency =
        this.config.getOptionalNumber('forkliftCoverage.scan.concurrency') ?? 8;
      // Results are published as each project finishes, so the page fills in
      // during the scan instead of staying on the previous run for minutes.
      const live: ForkliftProject[] = [];
      this.projects = live;
      let cursor = 0;

      const worker = async () => {
        for (;;) {
          const index = cursor++;
          if (index >= candidates.length) return;
          const result = await this.scanProject(client, candidates[index]);
          live.push(result);
          const progress = this.scanProgress;
          if (!progress) continue;
          progress.done++;
          if (result.skipped) progress.skipped++;
          else if (result.applied === 'yes') progress.applied++;
          else if (result.applied === 'partial') progress.partial++;
          else if (result.applied === 'error') progress.errored++;
          else progress.notApplied++;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, candidates.length) }, () =>
          worker(),
        ),
      );

      this.lastScannedAt = new Date().toISOString();
      this.lastScanDurationMs = Date.now() - startedAt;
      this.lastScanTriggeredBy = triggeredBy;
      this.lastScanError = null;

      await this.persistResult();

      const summary = this.summarize();
      if (this.historyStore) {
        await this.historyStore.addSnapshot({
          target: summary.target,
          applied: summary.applied,
          partial: summary.partial,
          notApplied: summary.notApplied,
          skipped: summary.skipped,
          percent: summary.percent,
        });
      }

      this.logger.info(
        `[forklift-coverage] scan complete: target=${summary.target} applied=${summary.applied} (${summary.percent}%) partial=${summary.partial} not-applied=${summary.notApplied} errored=${summary.errored} no-ci=${summary.skipped} in ${Math.round(this.lastScanDurationMs / 1000)}s`,
      );
    } catch (error) {
      // The scheduled and manual paths both run detached, so the message is
      // kept here to surface on the page instead of only in the logs.
      this.lastScanError =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`[forklift-coverage] scan failed: ${error}`);
      // A half-finished list is not a result. Fall back to the last completed
      // scan rather than leaving partial rows on the page.
      await this.restoreLastResult().catch(() => undefined);
      throw error;
    } finally {
      this.scanning = false;
      this.scanProgress = null;
    }
  }

  private async listProjects(
    client: GitlabClient,
  ): Promise<{ candidates: RawProject[]; excluded: ExcludedProject[] }> {
    const group = optionalString(this.config, 'forkliftCoverage.scope.group');
    const path = group
      ? `groups/${encodeURIComponent(group)}/projects?per_page=100&archived=false&include_subgroups=true&simple=false`
      : 'projects?per_page=100&archived=false&membership=true&simple=false';

    const all = await client.getJsonPages<RawProject>(path);
    const candidates: RawProject[] = [];
    const excluded: ExcludedProject[] = [];

    for (const raw of all) {
      // An empty repository has no default branch and nothing to scan.
      if (!raw.default_branch) continue;
      const reason = this.excludeReason(raw);
      if (reason) {
        const { group, name } = splitPath(raw.path_with_namespace);
        excluded.push({
          id: raw.id,
          path: raw.path_with_namespace,
          group,
          name,
          webUrl: raw.web_url,
          defaultBranch: raw.default_branch,
          topics: raw.topics ?? [],
          reason,
          lastActivityAt: raw.last_activity_at,
        });
        continue;
      }
      candidates.push(raw);
    }
    return { candidates, excluded };
  }

  private async scanProject(
    client: GitlabClient,
    raw: RawProject,
  ): Promise<ForkliftProject> {
    const { group, name } = splitPath(raw.path_with_namespace);
    const base: ForkliftProject = {
      id: raw.id,
      path: raw.path_with_namespace,
      group,
      name,
      webUrl: raw.web_url,
      defaultBranch: raw.default_branch,
      topics: raw.topics ?? [],
      applied: 'no',
      branch: null,
      onDefault: null,
      format: null,
      ciWired: false,
      registryPinned: false,
      evidence: [],
      note: null,
      skipped: false,
      lastActivityAt: raw.last_activity_at,
      excludeReason: null,
    };

    const fail = (stage: string, branch: string | null, err: unknown) => ({
      ...base,
      applied: 'error' as AppliedState,
      branch,
      note: `${stage}: ${err instanceof Error ? err.message : String(err)}`,
    });

    const maxBranches =
      this.config.getOptionalNumber('forkliftCoverage.scan.maxBranches') ?? 10;
    const sinceDays =
      this.config.getOptionalNumber('forkliftCoverage.scan.sinceDays') ?? 180;
    const useSearch =
      this.config.getOptionalBoolean('forkliftCoverage.scan.useSearch') ?? false;

    // Fast path. The blob search endpoint answers for the default branch in a
    // single call, but it runs on a much lower rate limit than the plain API,
    // so it stays opt-in.
    if (useSearch) {
      try {
        const verdict = await this.searchDefaultBranch(client, raw.id);
        if (verdict.hit) {
          return {
            ...base,
            applied: verdict.ciWired && verdict.registryPinned ? 'yes' : 'partial',
            branch: raw.default_branch,
            onDefault: true,
            format: verdict.format,
            ciWired: verdict.ciWired,
            registryPinned: verdict.registryPinned,
            evidence: verdict.evidence,
          };
        }
      } catch (err) {
        return fail('search_api_failed', null, err);
      }
    }

    let branches: RawBranch[];
    try {
      branches = await client.getJsonPages<RawBranch>(
        `projects/${raw.id}/repository/branches?per_page=100`,
      );
    } catch (err) {
      if (err instanceof NotFoundError) return { ...base, skipped: true };
      return fail('branches_api_failed', null, err);
    }

    const cutoff = Date.now() - sinceDays * 86_400_000;
    const others = branches
      .filter(b => b.name !== raw.default_branch)
      .filter(b => new Date(b.commit.committed_date).getTime() >= cutoff)
      .sort(
        (a, b) =>
          new Date(b.commit.committed_date).getTime() -
          new Date(a.commit.committed_date).getTime(),
      );

    const order: string[] = [];
    if (branches.some(b => b.name === raw.default_branch)) {
      order.push(raw.default_branch as string);
    }
    order.push(...others.map(b => b.name));

    let anyCI = false;
    let scannedOthers = 0;

    for (const branchName of order) {
      // The default branch is always checked; the cap applies to the rest.
      if (branchName !== raw.default_branch) {
        if (scannedOthers >= maxBranches) break;
        scannedOthers++;
      } else if (useSearch) {
        continue; // already covered by the fast path
      }

      let verdict: BranchVerdict;
      try {
        verdict = await this.scanBranch(client, raw.id, branchName);
      } catch (err) {
        return fail('branch_api_failed', branchName, err);
      }
      if (verdict.hasCI) anyCI = true;
      if (!verdict.hit) continue;

      // Wiring found. The remaining branches add nothing to the verdict.
      return {
        ...base,
        applied: verdict.ciWired && verdict.registryPinned ? 'yes' : 'partial',
        branch: branchName,
        onDefault: branchName === raw.default_branch,
        format: verdict.format,
        ciWired: verdict.ciWired,
        registryPinned: verdict.registryPinned,
        evidence: verdict.evidence,
      };
    }

    // No CI file anywhere means the project was never an integration target.
    if (!anyCI) return { ...base, skipped: true };

    return {
      ...base,
      note:
        others.length > maxBranches
          ? `branches_truncated:${scannedOthers}/${others.length}`
          : null,
    };
  }

  /** Single blob-search call. Only works on the default branch. */
  private async searchDefaultBranch(
    client: GitlabClient,
    projectId: number,
  ): Promise<BranchVerdict> {
    let hits: RawBlobHit[];
    try {
      hits = await client.getJson<RawBlobHit[]>(
        `projects/${projectId}/search?scope=blobs&search=forklift&per_page=100`,
      );
    } catch (err) {
      if (err instanceof NotFoundError) return EMPTY_VERDICT;
      throw err;
    }

    const paths: string[] = [];
    const seen = new Set<string>();
    const bodies: string[] = [];

    for (const hit of hits) {
      // A README that merely mentions Forklift is not evidence. Only CI and
      // registry config files count, same as the per-branch scan.
      if (!CI_FILE_RE.test(hit.path) && !REGISTRY_FILE_RE.test(hit.path)) continue;
      if (VENDOR_RE.test(hit.path)) continue;
      if (!this.bodyMatches(hit.data)) continue;
      if (!seen.has(hit.path)) {
        seen.add(hit.path);
        paths.push(hit.path);
      }
      bodies.push(hit.data);
    }

    if (paths.length === 0) return EMPTY_VERDICT;
    return { hasCI: true, hit: true, ...this.summarizeEvidence(paths, bodies) };
  }

  /** Walks the tree of one ref and reads every candidate file. */
  private async scanBranch(
    client: GitlabClient,
    projectId: number,
    ref: string,
  ): Promise<BranchVerdict> {
    let tree: RawTreeEntry[];
    try {
      tree = await client.getJsonPages<RawTreeEntry>(
        `projects/${projectId}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100`,
      );
    } catch (err) {
      if (err instanceof NotFoundError) return EMPTY_VERDICT;
      throw err;
    }

    let hasCI = false;
    const candidates: string[] = [];
    for (const entry of tree) {
      if (entry.type !== 'blob' || VENDOR_RE.test(entry.path)) continue;
      const isCI = CI_FILE_RE.test(entry.path);
      if (isCI) hasCI = true;
      if (isCI || REGISTRY_FILE_RE.test(entry.path)) candidates.push(entry.path);
    }
    if (candidates.length === 0) return { ...EMPTY_VERDICT, hasCI };

    const paths: string[] = [];
    const bodies: string[] = [];
    for (const filePath of candidates) {
      let body: string;
      try {
        body = await client.getText(
          `projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`,
        );
      } catch (err) {
        if (err instanceof NotFoundError) continue;
        throw err;
      }
      if (!this.bodyMatches(body)) continue;
      paths.push(filePath);
      bodies.push(body);
    }

    if (paths.length === 0) return { ...EMPTY_VERDICT, hasCI };
    return { hasCI, hit: true, ...this.summarizeEvidence(paths, bodies) };
  }

  private bodyMatches(body: string): boolean {
    if (!this.forkliftHost) return false;
    return body.includes(this.forkliftHost) || TOKEN_RE.test(body);
  }

  private summarizeEvidence(
    paths: string[],
    bodies: string[],
  ): Omit<BranchVerdict, 'hasCI' | 'hit'> {
    const sortedPaths = [...paths].sort();
    let ciWired = false;
    let registryPinned = false;
    for (const p of sortedPaths) {
      if (CI_FILE_RE.test(p)) ciWired = true;
      else registryPinned = true;
    }

    const formats = new Set<string>();
    const joined = bodies.join('\n');
    const hostFormatRe = this.hostFormatRe;
    if (hostFormatRe) {
      // A global regex keeps lastIndex between calls; reset before reuse.
      hostFormatRe.lastIndex = 0;
      for (
        let match = hostFormatRe.exec(joined);
        match !== null;
        match = hostFormatRe.exec(joined)
      ) {
        formats.add(match[1]);
      }
    }

    const format =
      formats.size > 0
        ? Array.from(formats).sort().join('/')
        : classifyByFilename(sortedPaths);

    return { ciWired, registryPinned, format, evidence: sortedPaths };
  }

  private summarize(): CoverageSummary {
    const inScope = this.projects.filter(p => !p.skipped && !p.excludeReason);
    const target = inScope.length;
    const applied = inScope.filter(p => p.applied === 'yes').length;
    return {
      target,
      applied,
      partial: inScope.filter(p => p.applied === 'partial').length,
      notApplied: inScope.filter(p => p.applied === 'no').length,
      errored: inScope.filter(p => p.applied === 'error').length,
      skipped: this.projects.filter(p => p.skipped).length,
      excluded:
        this.excludedProjects.length +
        this.projects.filter(p => !!p.excludeReason).length,
      percent: target > 0 ? Math.round((applied / target) * 100) : 0,
    };
  }

  getCoverage(): CoverageResponse {
    let gitlabHost: string | null = null;
    let gitlabWebUrl: string | null = null;
    try {
      const cfg = this.getGitlabConfig();
      gitlabHost = cfg.host;
      gitlabWebUrl = cfg.webBaseUrl;
    } catch {
      // Reported as a null host rather than failing the whole response.
    }

    return {
      ...this.summarize(),
      projects: this.projects,
      excludedProjects: this.excludedProjects,
      lastScannedAt: this.lastScannedAt,
      lastScanDurationMs: this.lastScanDurationMs,
      lastScanTriggeredBy: this.lastScanTriggeredBy,
      lastScanError: this.lastScanError,
      scanning: this.scanning,
      scanProgress: this.scanProgress,
      gitlabHost,
      gitlabWebUrl,
      backstageUrl:
        optionalString(this.config, 'app.baseUrl')?.replace(/\/+$/, '') ?? null,
      configured: this.isConfigured(),
      forkliftHost: this.forkliftHost,
      scanCron:
        optionalString(this.config, 'forkliftCoverage.schedule.cron') ??
        '0 10 * * 1-5',
      timezone:
        optionalString(this.config, 'forkliftCoverage.schedule.timezone') ??
        'UTC',
      webhookConfigured: this.webhookReady,
    };
  }

  getGroupCoverage(): GroupCoverage[] {
    const byGroup = new Map<string, GroupCoverage>();
    for (const project of this.projects) {
      if (project.skipped || project.excludeReason) continue;
      const key = project.group || '(root)';
      const entry = byGroup.get(key) ?? {
        group: key,
        target: 0,
        applied: 0,
        partial: 0,
        notApplied: 0,
        percent: 0,
      };
      entry.target++;
      if (project.applied === 'yes') entry.applied++;
      else if (project.applied === 'partial') entry.partial++;
      else if (project.applied === 'no') entry.notApplied++;
      byGroup.set(key, entry);
    }
    return Array.from(byGroup.values())
      .map(entry => ({
        ...entry,
        percent:
          entry.target > 0 ? Math.round((entry.applied / entry.target) * 100) : 0,
      }))
      .sort((a, b) => a.percent - b.percent || a.group.localeCompare(b.group));
  }

  getProject(path: string): ForkliftProject | undefined {
    return this.projects.find(p => p.path === path);
  }

  /**
   * Detail view of one project, including the ones that were excluded before
   * they could be scanned. Without that an opt-out would be a one way door,
   * since the detail page is where it gets toggled back on.
   */
  /**
   * Detail view of one project. Falls back to a GitLab lookup so a valid path
   * never dead ends on a 404: a project can be missing from the last scan
   * because it was excluded at the time, or because it was created since.
   */
  async getProjectDetail(path: string): Promise<ProjectDetail | undefined> {
    const scanned = this.projects.find(p => p.path === path);
    if (scanned) return { ...scanned, scanned: true };

    const excluded = this.excludedProjects.find(p => p.path === path);
    const base = (raw: {
      id: number;
      path: string;
      group: string;
      name: string;
      webUrl: string;
      defaultBranch: string | null;
      topics: string[];
      lastActivityAt: string;
      excludeReason: string | null;
    }): ProjectDetail => ({
      ...raw,
      applied: 'no',
      branch: null,
      onDefault: null,
      format: null,
      ciWired: false,
      registryPinned: false,
      evidence: [],
      note: null,
      skipped: false,
      scanned: false,
    });

    if (excluded) {
      return base({
        id: excluded.id,
        path: excluded.path,
        group: excluded.group,
        name: excluded.name,
        webUrl: excluded.webUrl,
        defaultBranch: excluded.defaultBranch,
        topics: excluded.topics,
        lastActivityAt: excluded.lastActivityAt,
        excludeReason: excluded.reason,
      });
    }

    try {
      const raw = await this.newClient().getJson<RawProject>(
        `projects/${encodeURIComponent(path)}`,
      );
      const { group, name } = splitPath(raw.path_with_namespace);
      return base({
        id: raw.id,
        path: raw.path_with_namespace,
        group,
        name,
        webUrl: raw.web_url,
        defaultBranch: raw.default_branch,
        topics: raw.topics ?? [],
        lastActivityAt: raw.last_activity_at,
        excludeReason: this.manualExclusions.has(path) ? 'manual' : null,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Returns the CI definitions of one ref for the pipeline viewer.
   *
   * Only paths matching the GitLab CI pattern are ever read. That whitelist is
   * the whole security boundary of this endpoint: it must never widen to
   * arbitrary repository files, since the viewer is meant to expose pipelines
   * and not source code.
   */
  async getPipeline(
    projectPath: string,
    requestedRef?: string,
  ): Promise<PipelineResponse> {
    const known = this.getProject(projectPath);
    const client = this.newClient();

    let projectId: number;
    let defaultBranch: string | null;
    if (known) {
      projectId = known.id;
      defaultBranch = known.defaultBranch;
    } else {
      const raw = await client.getJson<RawProject>(
        `projects/${encodeURIComponent(projectPath)}`,
      );
      projectId = raw.id;
      defaultBranch = raw.default_branch;
    }

    // Default to the branch the wiring was found on, so the viewer shows the
    // pipeline the verdict was actually based on.
    const ref =
      requestedRef ?? known?.branch ?? defaultBranch ?? 'HEAD';

    const tree = await client.getJsonPages<RawTreeEntry>(
      `projects/${projectId}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100`,
    );

    const ciPaths = tree
      .filter(
        entry =>
          entry.type === 'blob' &&
          !VENDOR_RE.test(entry.path) &&
          CI_FILE_RE.test(entry.path),
      )
      .map(entry => entry.path)
      .sort()
      .slice(0, PIPELINE_MAX_FILES);

    const files: PipelineFile[] = [];
    for (const filePath of ciPaths) {
      // Re-check the whitelist on the exact path we are about to read.
      if (!CI_FILE_RE.test(filePath)) continue;
      let body: string;
      try {
        body = await client.getText(
          `projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`,
        );
      } catch (err) {
        if (err instanceof NotFoundError) continue;
        throw err;
      }
      const truncated = Buffer.byteLength(body, 'utf8') > PIPELINE_FILE_MAX_BYTES;
      files.push({
        path: filePath,
        content: truncated
          ? Buffer.from(body, 'utf8')
              .subarray(0, PIPELINE_FILE_MAX_BYTES)
              .toString('utf8')
          : body,
        truncated,
        matchesForklift: this.bodyMatches(body),
      });
    }

    return { projectPath, ref, files };
  }

  /**
   * Latest commit on the branch the verdict came from, or the default branch.
   * Fetched on demand rather than during the scan, so the detail page costs
   * one request instead of adding one per project to every scan.
   */
  async getLastCommit(projectPath: string): Promise<LastCommit | null> {
    const known = this.getProject(projectPath);
    const client = this.newClient();

    let projectId: number;
    let defaultBranch: string | null;
    if (known) {
      projectId = known.id;
      defaultBranch = known.defaultBranch;
    } else {
      const raw = await client.getJson<RawProject>(
        `projects/${encodeURIComponent(projectPath)}`,
      );
      projectId = raw.id;
      defaultBranch = raw.default_branch;
    }

    const ref = known?.branch ?? defaultBranch;
    if (!ref) return null;

    try {
      const commits = await client.getJson<RawCommit[]>(
        `projects/${projectId}/repository/commits?ref_name=${encodeURIComponent(ref)}&per_page=1`,
      );
      const commit = commits[0];
      if (!commit) return null;
      return {
        ref,
        shortId: commit.short_id,
        title: commit.title,
        authorName: commit.author_name,
        committedAt: commit.committed_date,
        webUrl: commit.web_url ?? null,
      };
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  /** Projects that have CI but no full Forklift wiring, worst first. */
  getNotAppliedProjects(): ForkliftProject[] {
    return this.projects
      .filter(
        p =>
          !p.skipped &&
          !p.excludeReason &&
          (p.applied === 'no' || p.applied === 'partial'),
      )
      .sort(
        (a, b) =>
          (a.applied === 'no' ? 0 : 1) - (b.applied === 'no' ? 0 : 1) ||
          a.path.localeCompare(b.path),
      );
  }
}
