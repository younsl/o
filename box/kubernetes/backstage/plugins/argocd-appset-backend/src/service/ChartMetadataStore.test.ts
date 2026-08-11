import { ConfigReader } from '@backstage/config';
import {
  ChartMetadataStore,
  deriveUpstreamVersion,
  findVersionLines,
  parseChartYaml,
} from './ChartMetadataStore';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as any;

const REPO_URL = 'https://gitlab.example.com/devops/k8s.git';

const WRAPPER_CHART = `name: alloy-operator
version: 0.2.0
appVersion: "1.11.1"
dependencies:
- name: alloy-operator
  version: 0.6.3
  repository: https://grafana.github.io/helm-charts
`;

function createStore(configData: Record<string, any> = {}) {
  return new ChartMetadataStore({
    config: new ConfigReader({
      integrations: {
        gitlab: [{ host: 'gitlab.example.com', token: 'secret' }],
      },
      ...configData,
    }),
    logger: mockLogger,
  });
}

function mockFetchOnce(response: { status?: number; body?: string; ok?: boolean }) {
  const status = response.status ?? 200;
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: response.ok ?? (status >= 200 && status < 300),
    status,
    statusText: 'status',
    text: async () => response.body ?? '',
    json: async () => JSON.parse(response.body ?? '{}'),
  });
}

describe('parseChartYaml', () => {
  it('reads name, version, appVersion and dependencies', () => {
    const result = parseChartYaml(WRAPPER_CHART);

    expect(result).toMatchObject({
      name: 'alloy-operator',
      version: '0.2.0',
      appVersion: '1.11.1',
      upstreamVersion: '0.6.3',
    });
    expect(result!.dependencies).toEqual([
      {
        name: 'alloy-operator',
        version: '0.6.3',
        repository: 'https://grafana.github.io/helm-charts',
      },
    ]);
  });

  it('keeps the file verbatim for display', () => {
    expect(parseChartYaml(WRAPPER_CHART)!.raw).toBe(WRAPPER_CHART);
  });

  // An unquoted appVersion parses as a number, and a version as a string.
  it('coerces non-string versions', () => {
    const result = parseChartYaml('name: thing\nversion: 1\nappVersion: 2.5\n');

    expect(result!.version).toBe('1');
    expect(result!.appVersion).toBe('2.5');
  });

  it('drops dependencies missing a name or version', () => {
    const result = parseChartYaml(
      'name: thing\ndependencies:\n- name: only-name\n- version: 1.0\n',
    );

    expect(result!.dependencies).toEqual([]);
  });

  it('returns null for content that is not a mapping', () => {
    expect(parseChartYaml('just a string')).toBeNull();
    expect(parseChartYaml('')).toBeNull();
  });
});

describe('deriveUpstreamVersion', () => {
  const dep = (name: string, version: string) => ({ name, version, repository: null });

  it('uses the chart version when there are no dependencies', () => {
    expect(deriveUpstreamVersion('thing', '1.2.3', [])).toBe('1.2.3');
  });

  it('prefers the dependency named after the chart', () => {
    const dependencies = [dep('other', '9.9.9'), dep('thing', '1.0.0')];
    expect(deriveUpstreamVersion('thing', '0.1.0', dependencies)).toBe('1.0.0');
  });

  // A wrapper is often named differently from what it wraps.
  it('uses the sole dependency when its name differs from the chart', () => {
    expect(deriveUpstreamVersion('pay-jenkins', '0.1.0', [dep('jenkins', '5.8.16')])).toBe(
      '5.8.16',
    );
  });

  // No single version describes an umbrella of unrelated charts.
  it('returns null for several dependencies with no name match', () => {
    const dependencies = [dep('a', '1.0'), dep('b', '2.0'), dep('c', '3.0')];
    expect(deriveUpstreamVersion('umbrella', '0.1.0', dependencies)).toBeNull();
  });
});

describe('findVersionLines', () => {
  // Line 2 is the wrapper's own version, line 6 the dependency's.
  it('finds a dependency version rather than the chart version', () => {
    expect(findVersionLines(WRAPPER_CHART, '0.6.3', false)).toEqual([6]);
  });

  it('finds the chart version when restricted to the top level', () => {
    expect(findVersionLines(WRAPPER_CHART, '0.2.0', true)).toEqual([2]);
  });

  // At the top level a nested match must not be mistaken for the chart's own.
  it('ignores an indented match when restricted to the top level', () => {
    expect(findVersionLines(WRAPPER_CHART, '0.6.3', true)).toEqual([]);
  });

  it('matches a quoted value', () => {
    expect(findVersionLines('name: a\nversion: "1.2.3"\n', '1.2.3', true)).toEqual([2]);
  });

  // Dots are regex metacharacters and must not match arbitrary characters.
  it('does not treat the version as a pattern', () => {
    expect(findVersionLines('version: 1x2x3\n', '1.2.3', true)).toEqual([]);
  });

  it('returns every line when a value repeats', () => {
    const content = 'dependencies:\n- name: a\n  version: 1.0\n- name: b\n  version: 1.0\n';
    expect(findVersionLines(content, '1.0', false)).toEqual([3, 5]);
  });

  it('returns nothing when the version is absent', () => {
    expect(findVersionLines(WRAPPER_CHART, '9.9.9', false)).toEqual([]);
  });
});

describe('ChartMetadataStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as any;
  });

  it('reads Chart.yaml at the requested ref', async () => {
    mockFetchOnce({ body: WRAPPER_CHART });

    const result = await createStore().get(
      REPO_URL,
      'shared/chart-repo/alloy-operator',
      'sandbox',
    );

    expect(result!.upstreamVersion).toBe('0.6.3');
    const [rawUrl, options] = (global.fetch as jest.Mock).mock.calls[0];
    const url = String(rawUrl);
    expect(url).toBe(
      'https://gitlab.example.com/api/v4/projects/devops%2Fk8s/repository/files/' +
        'shared%2Fchart-repo%2Falloy-operator%2FChart.yaml/raw?ref=sandbox',
    );
    expect(options.headers['PRIVATE-TOKEN']).toBe('secret');
  });

  // HEAD is a symbolic ref the GitLab files API does not accept.
  it('resolves HEAD to the default branch', async () => {
    mockFetchOnce({ body: '{"default_branch":"master"}' });
    mockFetchOnce({ body: WRAPPER_CHART });

    await createStore().get(REPO_URL, 'shared/chart-repo/alloy-operator', 'HEAD');

    const projectUrl = String((global.fetch as jest.Mock).mock.calls[0][0]);
    const fileUrl = String((global.fetch as jest.Mock).mock.calls[1][0]);
    expect(projectUrl).toBe('https://gitlab.example.com/api/v4/projects/devops%2Fk8s');
    expect(fileUrl).toContain('ref=master');
  });

  it('serves a repeated read from the cache', async () => {
    mockFetchOnce({ body: WRAPPER_CHART });
    const store = createStore();

    await store.get(REPO_URL, 'a/b', 'main');
    await store.get(REPO_URL, 'a/b', 'main');

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // The same chart directory on two branches holds two different versions.
  it('caches separately per ref', async () => {
    mockFetchOnce({ body: WRAPPER_CHART });
    mockFetchOnce({ body: WRAPPER_CHART });
    const store = createStore();

    await store.get(REPO_URL, 'a/b', 'devel');
    await store.get(REPO_URL, 'a/b', 'prod');

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('caches the absence of a Chart.yaml', async () => {
    mockFetchOnce({ status: 404 });
    const store = createStore();

    expect(await store.get(REPO_URL, 'a/manifest', 'main')).toBeNull();
    expect(await store.get(REPO_URL, 'a/manifest', 'main')).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // Caching a transient failure would blank the version for a whole TTL.
  it('does not cache a server error', async () => {
    mockFetchOnce({ status: 500 });
    mockFetchOnce({ body: WRAPPER_CHART });
    const store = createStore();

    expect(await store.get(REPO_URL, 'a/b', 'main')).toBeNull();
    expect((await store.get(REPO_URL, 'a/b', 'main'))!.upstreamVersion).toBe('0.6.3');
  });

  it('refuses a path that escapes the chart directory', async () => {
    const result = await createStore().get(REPO_URL, 'a/../../etc', 'main');

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reports repositories with no GitLab integration as unsupported', () => {
    const store = createStore();

    expect(store.isSupported(REPO_URL)).toBe(true);
    expect(store.isSupported('https://github.com/org/repo.git')).toBe(false);
    expect(store.isSupported('not-a-url')).toBe(false);
  });

  it('expires an entry once the TTL passes', async () => {
    mockFetchOnce({ body: WRAPPER_CHART });
    mockFetchOnce({ body: WRAPPER_CHART });
    const store = createStore({
      argocdApplicationSet: { chartMetadata: { ttlMinutes: 0 } },
    });

    await store.get(REPO_URL, 'a/b', 'main');
    await store.get(REPO_URL, 'a/b', 'main');

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
