import yaml from 'js-yaml';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';

/**
 * A Helm repository index lists every version of every chart it serves, so for
 * a large repository it runs to tens of megabytes. Parsing one of those would
 * block the event loop for seconds, so an index past this size is reported as
 * unavailable rather than read.
 */
const MAX_INDEX_BYTES = 20 * 1024 * 1024;

const DEFAULT_TTL_MINUTES = 360;

/** A repository may redirect to a CDN, but not indefinitely. */
const MAX_REDIRECTS = 2;

/**
 * Hosts that name the cluster or the node itself. A chart repository never
 * lives at one of these, so a URL pointing at one is either a mistake or an
 * attempt to have the backend read something on the caller's behalf.
 *
 * This checks the literal host: a public name that resolves to a private
 * address still passes, which is why the caller-supplied repository is also
 * restricted to repositories the cluster already depends on.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /\.svc$/i,
  /\.svc\.cluster\.local$/i,
  /\.internal$/i,
];

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(host));
}

/** Only public HTTPS endpoints are read. Plain HTTP is refused outright. */
export function assertFetchableUrl(url: string): URL {
  if (typeof url !== 'string') {
    throw new Error('not a URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('not a URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`refusing to read over ${parsed.protocol}`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error('refusing to read from an internal address');
  }

  return parsed;
}

/**
 * Fetches with redirects followed by hand, so each hop is checked rather than
 * trusted. A repository that redirects to an internal address is refused at the
 * hop instead of being requested.
 */
async function fetchChecked(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<Response> {
  // Fetched as the parsed URL the check returned, never as the caller's string:
  // whatever reaches fetch has been through assertFetchableUrl.
  let target = assertFetchableUrl(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(target, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) return response;
    target = assertFetchableUrl(new URL(location, target).toString());
  }

  throw new Error('too many redirects');
}

export interface UpstreamChart {
  chart: string;
  repository: string;
  /** Highest stable version offered, null when none could be determined */
  latestVersion: string | null;
  /** appVersion the upstream declares for that version */
  latestAppVersion: string | null;
  /** How many versions the repository offers, for context on the result */
  versionCount: number;
  source: 'helm-index' | 'oci-tags';
  /** Why no version was found, when that is the outcome */
  unavailableReason: string | null;
  /**
   * When the repository was last read, as an ISO timestamp. A cached result
   * keeps the stamp of the read that produced it, so a reader can tell a fresh
   * answer from one served out of the cache. A 304 counts as a read: the
   * repository confirmed the value is still current.
   */
  checkedAt: string;
}

interface CacheEntry {
  value: UpstreamChart;
  expiresAt: number;
}

/** One chart's published versions, reduced to the two fields that get used. */
interface IndexEntry {
  version: string;
  appVersion: string | null;
}

/**
 * A parsed repository index. Cached per repository rather than per chart: one
 * index serves every chart in that repository, so keying by chart would fetch
 * and parse the same multi-megabyte file once per chart.
 *
 * Only the version and appVersion of each entry are kept. An index carries
 * descriptions, digests, source URLs and maintainers for every version, which
 * is the bulk of its size and none of what is read here.
 */
interface IndexCacheEntry {
  charts: Map<string, IndexEntry[]>;
  /** Entity tag, so a refresh can be answered with 304 and no body */
  etag: string | null;
  expiresAt: number;
  /** ISO stamp of the last read, revalidations included */
  checkedAt: string;
}

/**
 * A leading field this long is a date or a build number, not a major version.
 * OCI registries carry tags like `20221219` next to real chart versions, and
 * compared field by field such a tag beats every genuine version.
 */
const MAX_MAJOR_DIGITS = 4;

/**
 * Splits a version into comparable parts. A leading `v` is tolerated, and a
 * prerelease suffix is kept separate so it can be excluded from "latest".
 * Returns null for anything that is not a version, date-like tags included.
 */
export function parseVersion(
  version: string,
): { parts: number[]; prerelease: string | null } | null {
  const match = /^v?(\d+(?:\.\d+)*)(?:[-+](.+))?$/.exec(version.trim());
  if (!match) return null;

  const parts = match[1].split('.').map(Number);
  if (String(parts[0]).length > MAX_MAJOR_DIGITS) return null;

  return { parts, prerelease: match[2] ?? null };
}

/** Numeric field-by-field comparison, missing fields treated as zero. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return a.localeCompare(b);

  const length = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // Equal releases: a prerelease sorts below the release it precedes.
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && right.prerelease) {
    return comparePrerelease(left.prerelease, right.prerelease);
  }
  return 0;
}

/**
 * Dot-separated prerelease identifiers, numeric ones compared as numbers so
 * `beta.10` sorts above `beta.9`. A shorter list sorts first, as in semver.
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const leftPart = left[i];
    const rightPart = right[i];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const bothNumeric = /^\d+$/.test(leftPart) && /^\d+$/.test(rightPart);
    const diff = bothNumeric
      ? Number(leftPart) - Number(rightPart)
      : leftPart.localeCompare(rightPart);
    if (diff !== 0) return diff;
  }

  return 0;
}

/**
 * Highest stable version in the list. Prereleases are skipped, since an upgrade
 * suggestion pointing at a release candidate is not actionable, but they are
 * used as a fallback when a chart publishes nothing else.
 *
 * Where a repository offers proper three-field versions, shorter ones are set
 * aside: a registry's tag list mixes real chart versions with loose tags, and a
 * one-field tag compared field by field outranks every version there is.
 */
export function pickLatestVersion(versions: string[]): string | null {
  const parsed = versions
    .map(version => ({ version, parsed: parseVersion(version) }))
    .filter((candidate): candidate is { version: string; parsed: NonNullable<ReturnType<typeof parseVersion>> } =>
      candidate.parsed !== null,
    );
  if (parsed.length === 0) return null;

  const wellFormed = parsed.filter(candidate => candidate.parsed.parts.length >= 3);
  const shaped = wellFormed.length > 0 ? wellFormed : parsed;

  const stable = shaped.filter(candidate => !candidate.parsed.prerelease);
  const pool = stable.length > 0 ? stable : shaped;

  return pool.reduce((best, candidate) =>
    compareVersions(candidate.version, best.version) > 0 ? candidate : best,
  ).version;
}

/** `oci://host/path/chart` addresses a registry repository, not an index. */
export function parseOciRef(
  repository: string,
  chart: string,
): { host: string; repositoryPath: string } | null {
  // Guarded rather than assumed: a repeated query parameter arrives as an array,
  // and calling a string method on one throws where a null return would do.
  if (typeof repository !== 'string' || typeof chart !== 'string') return null;
  if (!repository.startsWith('oci://')) return null;

  const withoutScheme = repository.slice('oci://'.length).replace(/\/$/, '');
  const slash = withoutScheme.indexOf('/');
  if (slash === -1) return null;

  return {
    host: withoutScheme.slice(0, slash),
    repositoryPath: `${withoutScheme.slice(slash + 1)}/${chart}`,
  };
}

/**
 * Reduces a repository index to chart name against published versions. The
 * fields dropped here are most of the file: an index repeats a description,
 * digest, source list and maintainer set for every version of every chart.
 */
export function parseIndexCharts(body: string): Map<string, IndexEntry[]> {
  const index = yaml.load(body, { schema: yaml.CORE_SCHEMA }) as any;
  const charts = new Map<string, IndexEntry[]>();

  for (const [name, entries] of Object.entries(index?.entries ?? {})) {
    if (!Array.isArray(entries)) continue;

    const reduced = entries
      .filter((entry: any) => entry?.version != null)
      .map((entry: any) => ({
        version: String(entry.version),
        appVersion: entry.appVersion != null ? String(entry.appVersion) : null,
      }));

    if (reduced.length > 0) charts.set(name, reduced);
  }

  return charts;
}

/**
 * Looks up the newest version a chart's upstream repository offers, so a reader
 * can tell whether the pinned version is behind. Queried on demand rather than
 * on the refresh schedule: it is only ever needed when someone opens the detail
 * dialog, and a Helm index is far too large to fetch every minute.
 */
export class UpstreamChartStore {
  private readonly logger: LoggerService;
  private readonly ttlMs: number;
  /** Parsed Helm indexes, keyed by repository */
  private readonly indexCache = new Map<string, IndexCacheEntry>();
  /** OCI results, keyed by repository and chart: a registry has no index */
  private readonly ociCache = new Map<string, CacheEntry>();

  constructor(options: { config: Config; logger: LoggerService }) {
    this.logger = options.logger;
    const ttlMinutes =
      options.config.getOptionalNumber(
        'argocdApplicationSet.upstreamChart.ttlMinutes',
      ) ?? DEFAULT_TTL_MINUTES;
    this.ttlMs = ttlMinutes * 60_000;
  }

  async getLatest(repository: string, chart: string): Promise<UpstreamChart> {
    const isOci =
      typeof repository === 'string' && repository.startsWith('oci://');

    try {
      return isOci
        ? await this.getLatestFromOci(repository, chart)
        : await this.getLatestFromHelmIndex(repository, chart);
    } catch (error) {
      this.logger.warn(
        `Failed to read upstream versions for ${chart} from ${repository}: ${error}`,
      );
      // Not cached: a transient failure should not stick for the whole TTL. The
      // detail stays in the log rather than being handed back to the caller.
      return {
        chart,
        repository,
        latestVersion: null,
        latestAppVersion: null,
        versionCount: 0,
        source: isOci ? 'oci-tags' : 'helm-index',
        unavailableReason: 'the repository could not be read',
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /** Every chart in a repository is answered from one parsed index. */
  private async getLatestFromHelmIndex(
    repository: string,
    chart: string,
  ): Promise<UpstreamChart> {
    const index = await this.loadIndex(repository);
    const base: Omit<UpstreamChart, 'latestVersion' | 'latestAppVersion'> = {
      chart,
      repository,
      versionCount: 0,
      source: 'helm-index',
      unavailableReason: null,
      checkedAt:
        typeof index === 'string' ? new Date().toISOString() : index.checkedAt,
    };

    if (typeof index === 'string') {
      return { ...base, latestVersion: null, latestAppVersion: null, unavailableReason: index };
    }

    const entries = index.charts.get(chart);
    if (!entries || entries.length === 0) {
      return {
        ...base,
        latestVersion: null,
        latestAppVersion: null,
        unavailableReason: `no entry named ${chart} in the repository index`,
      };
    }

    const latestVersion = pickLatestVersion(entries.map(entry => entry.version));

    return {
      ...base,
      versionCount: entries.length,
      latestVersion,
      latestAppVersion:
        entries.find(entry => entry.version === latestVersion)?.appVersion ?? null,
    };
  }

  /**
   * The repository's parsed index, or a reason it is unavailable. A refresh
   * revalidates with the entity tag, so an unchanged index costs a 304 and no
   * parse, which is what makes scanning every chart daily affordable.
   */
  private async loadIndex(
    repository: string,
  ): Promise<IndexCacheEntry | string> {
    const cached = this.indexCache.get(repository);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    const indexUrl = `${repository.replace(/\/$/, '')}/index.yaml`;
    const response = await fetchChecked(
      indexUrl,
      cached?.etag ? { headers: { 'If-None-Match': cached.etag } } : undefined,
    );

    // The repository confirmed the value is current, which is a read.
    if (response.status === 304 && cached) {
      cached.expiresAt = Date.now() + this.ttlMs;
      cached.checkedAt = new Date().toISOString();
      return cached;
    }

    if (!response.ok) {
      throw new Error(`index.yaml request failed: ${response.status}`);
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_INDEX_BYTES) {
      return `index.yaml is ${Math.round(
        declaredLength / 1024 / 1024,
      )}MB, above the ${MAX_INDEX_BYTES / 1024 / 1024}MB limit`;
    }

    const body = await response.text();
    if (body.length > MAX_INDEX_BYTES) {
      return 'index.yaml is above the size limit';
    }

    const entry: IndexCacheEntry = {
      charts: parseIndexCharts(body),
      etag: response.headers.get('etag'),
      expiresAt: Date.now() + this.ttlMs,
      checkedAt: new Date().toISOString(),
    };
    this.indexCache.set(repository, entry);
    return entry;
  }

  /**
   * An OCI registry has no index, so the chart's versions are its image tags.
   * Anonymous pulls still need a bearer token, which the registry advertises in
   * the `WWW-Authenticate` header of the rejected first request.
   */
  private async getLatestFromOci(
    repository: string,
    chart: string,
  ): Promise<UpstreamChart> {
    const cacheKey = `${repository}|${chart}`;
    const cached = this.ociCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const value = await this.fetchFromOci(repository, chart);
    this.ociCache.set(cacheKey, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  private async fetchFromOci(
    repository: string,
    chart: string,
  ): Promise<UpstreamChart> {
    const base: Omit<UpstreamChart, 'latestVersion' | 'latestAppVersion'> = {
      chart,
      repository,
      versionCount: 0,
      source: 'oci-tags',
      unavailableReason: null,
      checkedAt: new Date().toISOString(),
    };

    const ref = parseOciRef(repository, chart);
    if (!ref) {
      return {
        ...base,
        latestVersion: null,
        latestAppVersion: null,
        unavailableReason: `could not read a registry path from ${repository}`,
      };
    }

    const tagsUrl = `https://${ref.host}/v2/${ref.repositoryPath}/tags/list?n=1000`;
    let response = await fetchChecked(tagsUrl);

    if (response.status === 401) {
      const token = await this.requestOciToken(
        response.headers.get('www-authenticate'),
        ref.host,
      );
      if (!token) {
        return {
          ...base,
          latestVersion: null,
          latestAppVersion: null,
          unavailableReason: 'registry requires credentials',
        };
      }
      response = await fetchChecked(tagsUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    if (!response.ok) {
      throw new Error(`tag listing failed: ${response.status}`);
    }

    const body: { tags?: string[] } = await response.json();
    const tags = body.tags ?? [];

    return {
      ...base,
      versionCount: tags.length,
      latestVersion: pickLatestVersion(tags),
      // The chart's appVersion lives in its manifest, one request per tag.
      latestAppVersion: null,
      unavailableReason:
        tags.length === 0 ? 'the registry lists no tags' : null,
    };
  }

  /**
   * The realm comes from the registry's own response, so it is checked the same
   * way the repository was and additionally pinned to the registry's host: a
   * registry has no reason to send its token endpoint somewhere else.
   */
  private async requestOciToken(
    challenge: string | null,
    registryHost: string,
  ): Promise<string | null> {
    if (!challenge) return null;

    const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
    const service = /service="([^"]+)"/.exec(challenge)?.[1];
    const scope = /scope="([^"]+)"/.exec(challenge)?.[1];
    if (!realm) return null;

    let url: URL;
    try {
      url = assertFetchableUrl(realm);
    } catch {
      return null;
    }
    if (url.host !== registryHost) {
      this.logger.warn(
        `Ignoring token realm ${url.host} advertised by registry ${registryHost}`,
      );
      return null;
    }

    if (service) url.searchParams.set('service', service);
    if (scope) url.searchParams.set('scope', scope);

    const response = await fetchChecked(url.toString());
    if (!response.ok) return null;

    const body: { token?: string; access_token?: string } = await response.json();
    return body.token ?? body.access_token ?? null;
  }
}
