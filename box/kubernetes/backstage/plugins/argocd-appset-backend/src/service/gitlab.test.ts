import { ConfigReader } from '@backstage/config';
import { gitLabFileUrl, isValidProjectPath, resolveGitLabApi } from './gitlab';

// The path is interpolated into a GitLab API URL, so `.` and `..` segments
// (which survive encodeURIComponent unchanged) must never pass.
describe('isValidProjectPath', () => {
  it.each([
    'group/project',
    'group/subgroup/project',
    'group/my-repo.name_v2',
  ])('accepts %s', path => {
    expect(isValidProjectPath(path)).toBe(true);
  });

  it.each([
    '..',
    '.',
    'group/..',
    '../group/project',
    'group/.hidden',
    'project',
    '',
    'group//project',
  ])('rejects %s', path => {
    expect(isValidProjectPath(path)).toBe(false);
  });
});

describe('gitLabFileUrl', () => {
  const REPO = 'https://gitlab.example.com/devops/k8s.git';

  it('builds a blob URL anchored to a line', () => {
    expect(gitLabFileUrl(REPO, 'HEAD', 'shared/chart-repo/eck-stack/Chart.yaml', 6)).toBe(
      'https://gitlab.example.com/devops/k8s/-/blob/HEAD/shared/chart-repo/eck-stack/Chart.yaml#L6',
    );
  });

  it('omits the anchor when no line is given', () => {
    expect(gitLabFileUrl(REPO, 'main', 'Chart.yaml')).toBe(
      'https://gitlab.example.com/devops/k8s/-/blob/main/Chart.yaml',
    );
  });

  // A branch with a slash would otherwise be read as extra path segments.
  it('encodes the ref', () => {
    expect(gitLabFileUrl(REPO, 'feature/thing', 'Chart.yaml')).toContain(
      '/-/blob/feature%2Fthing/Chart.yaml',
    );
  });

  it('keeps path separators while encoding each segment', () => {
    expect(gitLabFileUrl(REPO, 'main', 'a b/c#d/Chart.yaml')).toContain(
      '/-/blob/main/a%20b/c%23d/Chart.yaml',
    );
  });

  it.each(['git@gitlab.example.com:devops/k8s.git', 'not-a-url', ''])(
    'returns null for %s',
    repoUrl => {
      expect(gitLabFileUrl(repoUrl, 'main', 'Chart.yaml')).toBeNull();
    },
  );
});

describe('resolveGitLabApi', () => {
  const config = (data: Record<string, any>) => new ConfigReader(data);

  const withIntegration = (extra: Record<string, any> = {}) =>
    config({
      integrations: {
        gitlab: [{ host: 'gitlab.example.com', token: 'secret', ...extra }],
      },
    });

  it('derives the API base URL from the host', () => {
    const result = resolveGitLabApi(
      withIntegration(),
      'https://gitlab.example.com/devops/k8s.git',
    );

    expect(result).toMatchObject({
      apiBaseUrl: 'https://gitlab.example.com/api/v4',
      token: 'secret',
      encodedPath: 'devops%2Fk8s',
    });
  });

  /*
   * Requests are built through this rather than by concatenation, so the host
   * reached is the configured one whatever the path is asked to be.
   */
  describe('url', () => {
    const api = () =>
      resolveGitLabApi(withIntegration(), 'https://gitlab.example.com/devops/k8s.git');

    it('builds a path under the API base', () => {
      expect(String(api().url('projects/devops%2Fk8s/repository/branches'))).toBe(
        'https://gitlab.example.com/api/v4/projects/devops%2Fk8s/repository/branches',
      );
    });

    it('encodes query values', () => {
      const url = api().url('projects/x/repository/files/y/raw', {
        ref: 'feature/thing',
      });

      expect(url.searchParams.get('ref')).toBe('feature/thing');
      expect(String(url)).toContain('ref=feature%2Fthing');
    });

    it('tolerates a leading slash on the path', () => {
      expect(String(api().url('/projects/x'))).toBe(
        'https://gitlab.example.com/api/v4/projects/x',
      );
    });

    // An absolute URL is the one form that would leave the configured host.
    it('refuses an absolute URL', () => {
      expect(() => api().url('https://attacker.example.com/steal')).toThrow(
        /outside the configured host/,
      );
    });

    /*
     * A protocol-relative path is not refused, it is defused: the leading
     * slashes go, so it resolves under the configured host as an ordinary path.
     */
    it('reads a protocol-relative path as a path', () => {
      expect(String(api().url('//attacker.example.com/steal'))).toBe(
        'https://gitlab.example.com/api/v4/attacker.example.com/steal',
      );
    });
  });

  it('prefers a configured apiBaseUrl', () => {
    const result = resolveGitLabApi(
      withIntegration({ apiBaseUrl: 'https://proxy.example.com/api/v4' }),
      'https://gitlab.example.com/devops/k8s.git',
    );

    expect(result.apiBaseUrl).toBe('https://proxy.example.com/api/v4');
  });

  it.each([
    ['no integration configured', config({}), 'https://gitlab.example.com/a/b.git'],
    [
      'a host with no integration',
      withIntegration(),
      'https://other.example.com/a/b.git',
    ],
    ['an unparseable repoUrl', withIntegration(), 'not-a-url'],
    [
      'a traversing project path',
      withIntegration(),
      'https://gitlab.example.com/../etc.git',
    ],
  ])('throws for %s', (_label, cfg, repoUrl) => {
    expect(() => resolveGitLabApi(cfg, repoUrl)).toThrow();
  });
});
