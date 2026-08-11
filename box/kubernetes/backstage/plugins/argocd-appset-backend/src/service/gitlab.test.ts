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

    expect(result).toEqual({
      apiBaseUrl: 'https://gitlab.example.com/api/v4',
      token: 'secret',
      encodedPath: 'devops%2Fk8s',
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
