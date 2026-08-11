import yaml from 'js-yaml';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import { resolveGitLabApi } from './gitlab';

export interface ChartDependency {
  name: string;
  version: string;
  repository: string | null;
}

/** Chart.yaml files are a few lines; the cap only bounds a pathological file. */
const MAX_RAW_LENGTH = 4000;

export interface ChartMetadata {
  /** The file as written in the repository, for display alongside the version */
  raw: string;
  name: string | null;
  /** Version of the chart living at the path itself */
  version: string | null;
  appVersion: string | null;
  dependencies: ChartDependency[];
  /**
   * Version of the upstream chart being wrapped, when it can be identified
   * without guessing. Null for an umbrella chart pulling several unrelated
   * dependencies, where no single version describes it.
   */
  upstreamVersion: string | null;
}

interface CacheEntry {
  value: ChartMetadata | null;
  expiresAt: number;
}

const DEFAULT_TTL_MINUTES = 60;

/** A `..` segment would escape the chart directory in the GitLab file path. */
function isSafeChartPath(path: string): boolean {
  return path.split('/').every(segment => segment !== '..');
}

/**
 * Which dependency version stands for "the upstream chart". A wrapper chart
 * pins one upstream chart, usually under the same name; an umbrella chart
 * pulling several unrelated charts has no single upstream version, and
 * reporting one of them would be arbitrary.
 */
export function deriveUpstreamVersion(
  chartName: string | null,
  version: string | null,
  dependencies: ChartDependency[],
): string | null {
  if (dependencies.length === 0) return version;

  const named = dependencies.find(dep => dep.name === chartName);
  if (named) return named.version;

  return dependencies.length === 1 ? dependencies[0].version : null;
}

/**
 * 1-indexed lines whose scalar value is `version`. A Chart.yaml carries several
 * versions (the chart's own, each dependency's, sometimes appVersion), so the
 * value is matched rather than the key, which pins the exact line used.
 * `topLevelOnly` distinguishes the chart's own `version:` at column zero from a
 * dependency's nested one when the two happen to hold the same value.
 */
export function findVersionLines(
  content: string,
  version: string,
  topLevelOnly: boolean,
): number[] {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = topLevelOnly
    ? new RegExp(`^version\\s*:\\s*['"]?${escaped}['"]?\\s*$`)
    : new RegExp(`^\\s*(-\\s*)?version\\s*:\\s*['"]?${escaped}['"]?\\s*$`);

  return content
    .split('\n')
    .map((line, index) => (pattern.test(line) ? index + 1 : 0))
    .filter(lineNumber => lineNumber > 0);
}

export function parseChartYaml(content: string): ChartMetadata | null {
  // CORE_SCHEMA admits only plain scalars, maps and sequences, so a tag in a
  // repository's Chart.yaml cannot construct anything.
  const parsed = yaml.load(content, { schema: yaml.CORE_SCHEMA });
  if (!parsed || typeof parsed !== 'object') return null;

  const doc = parsed as Record<string, any>;
  const name: string | null = typeof doc.name === 'string' ? doc.name : null;
  const version: string | null = doc.version != null ? String(doc.version) : null;
  const appVersion: string | null =
    doc.appVersion != null ? String(doc.appVersion) : null;

  const dependencies: ChartDependency[] = (Array.isArray(doc.dependencies)
    ? doc.dependencies
    : []
  )
    .filter((dep: any) => dep?.name && dep?.version != null)
    .map((dep: any) => ({
      name: String(dep.name),
      version: String(dep.version),
      repository: dep.repository != null ? String(dep.repository) : null,
    }));

  return {
    raw: content.length > MAX_RAW_LENGTH ? content.slice(0, MAX_RAW_LENGTH) : content,
    name,
    version,
    appVersion,
    dependencies,
    upstreamVersion: deriveUpstreamVersion(name, version, dependencies),
  };
}

/**
 * Reads `Chart.yaml` for Applications whose source is a chart directory in a
 * git repository. Such an Application records only the git revision in
 * `targetRevision`, so the chart and app versions exist nowhere in the cluster
 * and have to come from the file itself.
 *
 * Entries are cached per (repoUrl, path, targetRevision), where the revision
 * is the Application's own branch or `HEAD`, never its synced commit SHA.
 * Keying on the SHA would be more precise but far more expensive: one commit
 * moves the SHA for every Application in that repository at once, so a single
 * push would invalidate hundreds of entries together. A branch name is stable
 * across commits, which keeps the cache warm and bounds it to the number of
 * distinct chart directories. Freshness is then governed by the TTL, which a
 * chart version comfortably outlives.
 */
export class ChartMetadataStore {
  private readonly config: Config;
  private readonly logger: LoggerService;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly defaultBranches = new Map<string, string>();

  constructor(options: { config: Config; logger: LoggerService }) {
    this.config = options.config;
    this.logger = options.logger;
    const ttlMinutes =
      this.config.getOptionalNumber('argocdApplicationSet.chartMetadata.ttlMinutes') ??
      DEFAULT_TTL_MINUTES;
    this.ttlMs = ttlMinutes * 60_000;
  }

  /** True when a GitLab integration exists for the repository's host. */
  isSupported(repoUrl: string): boolean {
    try {
      resolveGitLabApi(this.config, repoUrl);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Chart.yaml at `path` in `repoUrl`, or null when the path holds no chart.
   * `ref` is the Application's `targetRevision`; `HEAD` and empty values fall
   * back to the repository's default branch, which the GitLab files API
   * requires in place of a symbolic ref.
   */
  async get(
    repoUrl: string,
    path: string,
    ref: string | null,
  ): Promise<ChartMetadata | null> {
    const cacheKey = `${repoUrl}|${path}|${ref ?? ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (!isSafeChartPath(path)) {
      this.logger.warn(`Refusing to read chart metadata from unsafe path: ${path}`);
      return null;
    }

    let value: ChartMetadata | null;
    try {
      value = await this.fetchChartYaml(repoUrl, path, ref);
    } catch (error) {
      // Not cached: a transient failure must not blank the version for a
      // whole TTL. The next refresh retries.
      this.logger.warn(`Failed to read Chart.yaml at ${path}: ${error}`);
      return cached?.value ?? null;
    }

    this.cache.set(cacheKey, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  private async fetchChartYaml(
    repoUrl: string,
    path: string,
    ref: string | null,
  ): Promise<ChartMetadata | null> {
    const api = resolveGitLabApi(this.config, repoUrl);
    const resolvedRef =
      !ref || ref === 'HEAD' ? await this.resolveDefaultBranch(repoUrl) : ref;

    const filePath = encodeURIComponent(`${path}/Chart.yaml`);
    const response = await fetch(
      api.url(`projects/${api.encodedPath}/repository/files/${filePath}/raw`, {
        ref: resolvedRef,
      }),
      { headers: { 'PRIVATE-TOKEN': api.token } },
    );

    // A path with no Chart.yaml is a plain manifest or kustomize directory,
    // which is a fact worth caching rather than an error.
    if (response.status === 404) return null;

    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }

    return parseChartYaml(await response.text());
  }

  private async resolveDefaultBranch(repoUrl: string): Promise<string> {
    const cached = this.defaultBranches.get(repoUrl);
    if (cached) return cached;

    const api = resolveGitLabApi(this.config, repoUrl);
    const response = await fetch(api.url(`projects/${api.encodedPath}`), {
      headers: { 'PRIVATE-TOKEN': api.token },
    });

    if (!response.ok) {
      throw new Error(
        `GitLab API error resolving default branch: ${response.status} ${response.statusText}`,
      );
    }

    const project: { default_branch?: string } = await response.json();
    const branch = project.default_branch ?? 'main';
    this.defaultBranches.set(repoUrl, branch);
    return branch;
  }
}
