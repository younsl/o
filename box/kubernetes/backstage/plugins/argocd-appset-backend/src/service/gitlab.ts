import { Config } from '@backstage/config';

// One bounded quantifier, anchored: no polynomial backtracking.
const PROJECT_PATH_SEGMENT_RE = /^[a-z0-9_][a-z0-9_.-]{0,254}$/i;

/**
 * A GitLab project path is `group/subgroup/.../project`. Each segment must
 * start with an alphanumeric, which also rules out `.` and `..` segments:
 * those survive encodeURIComponent unchanged and would let a caller-supplied
 * repoUrl escape `/projects/<path>/` into arbitrary GitLab API endpoints.
 */
export function isValidProjectPath(path: string): boolean {
  const segments = path.split('/');
  if (segments.length < 2) return false;
  return segments.every(segment => PROJECT_PATH_SEGMENT_RE.test(segment));
}

/**
 * Browser URL for a file in a GitLab repository, optionally anchored to a line.
 * Returns null for a remote that is not an HTTP URL, such as an SSH remote,
 * where the web host cannot be derived reliably.
 */
export function gitLabFileUrl(
  repoUrl: string,
  ref: string,
  filePath: string,
  line?: number,
): string | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(repoUrl);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return null;
  }

  const project = parsedUrl.pathname.replace(/\.git$/, '').replace(/\/$/, '');
  const encodedPath = filePath
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');

  return (
    `${parsedUrl.origin}${project}/-/blob/${encodeURIComponent(ref)}/${encodedPath}` +
    (line ? `#L${line}` : '')
  );
}

export interface GitLabApiTarget {
  apiBaseUrl: string;
  token: string;
  /** Project path, URL-encoded for use as a `/projects/:id` path segment */
  encodedPath: string;
  /**
   * Builds a URL under the configured API base. Requests go through this rather
   * than through a concatenated string, so the host being reached is always the
   * one the integration configured and never anything a caller supplied.
   */
  url(path: string, query?: Record<string, string>): URL;
}

/**
 * Resolve a git remote URL to the GitLab integration that serves it. Throws
 * rather than returning null, since every failure here is a configuration
 * problem the caller should surface, not a missing-data case.
 */
export function resolveGitLabApi(config: Config, repoUrl: string): GitLabApiTarget {
  const gitlabConfigs = config.getOptionalConfigArray('integrations.gitlab') ?? [];
  if (gitlabConfigs.length === 0) {
    throw new Error('No GitLab integration configured');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(repoUrl);
  } catch {
    throw new Error(`Invalid repoUrl: ${repoUrl}`);
  }

  const gitlabConfig = gitlabConfigs.find(
    cfg => cfg.getString('host') === parsedUrl.hostname,
  );
  if (!gitlabConfig) {
    throw new Error(`No GitLab integration found for host: ${parsedUrl.hostname}`);
  }

  const projectPath = parsedUrl.pathname.replace(/^\//, '').replace(/\.git$/, '');
  if (!isValidProjectPath(projectPath)) {
    throw new Error(`Invalid GitLab project path in repoUrl: ${repoUrl}`);
  }

  const apiBaseUrl =
    gitlabConfig.getOptionalString('apiBaseUrl') ??
    `https://${parsedUrl.hostname}/api/v4`;
  const base = new URL(`${apiBaseUrl.replace(/\/$/, '')}/`);

  return {
    apiBaseUrl,
    token: gitlabConfig.getString('token'),
    encodedPath: encodeURIComponent(projectPath),
    url(path, query) {
      // Every leading slash goes, so `//host/x` cannot be read as
      // protocol-relative and resolves under the configured host as a path.
      const target = new URL(path.replace(/^\/+/, ''), base);
      // A relative path cannot leave the configured host, but a path that
      // resolved elsewhere would, so the origin is confirmed rather than assumed.
      if (target.origin !== base.origin) {
        throw new Error('Refusing to build a URL outside the configured host');
      }
      for (const [key, value] of Object.entries(query ?? {})) {
        target.searchParams.set(key, value);
      }
      return target;
    },
  };
}
