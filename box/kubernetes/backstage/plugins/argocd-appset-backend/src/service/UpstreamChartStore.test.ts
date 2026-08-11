import { ConfigReader } from '@backstage/config';
import {
  assertFetchableUrl,
  compareVersions,
  isBlockedHost,
  parseIndexCharts,
  parseOciRef,
  parseVersion,
  pickLatestVersion,
  UpstreamChartStore,
} from './UpstreamChartStore';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as any;

const HELM_REPO = 'https://grafana.github.io/helm-charts';

const INDEX_YAML = `apiVersion: v1
entries:
  alloy-operator:
  - version: 0.6.3
    appVersion: 1.11.1
  - version: 0.7.0
    appVersion: 1.12.0
  - version: 0.7.1-rc.1
    appVersion: 1.13.0
  other-chart:
  - version: 9.9.9
`;

function createStore(configData: Record<string, any> = {}) {
  return new UpstreamChartStore({
    config: new ConfigReader(configData),
    logger: mockLogger,
  });
}

function mockResponse(response: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}) {
  const status = response.status ?? 200;
  const headers = response.headers ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'status',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => response.body ?? '',
    json: async () => JSON.parse(response.body ?? '{}'),
  };
}

describe('parseVersion', () => {
  it.each([
    ['1.2.3', [1, 2, 3], null],
    ['v1.2.3', [1, 2, 3], null],
    ['0.7.1-rc.1', [0, 7, 1], 'rc.1'],
    ['5', [5], null],
  ])('parses %s', (version, parts, prerelease) => {
    expect(parseVersion(version)).toEqual({ parts, prerelease });
  });

  it.each(['', 'latest', 'not-a-version'])('returns null for %s', version => {
    expect(parseVersion(version)).toBeNull();
  });

  /*
   * An OCI registry carries date-shaped tags beside real versions. Compared
   * field by field, 20221219 outranks every genuine version there is.
   */
  it.each(['20221219', '202212', '1670000000'])(
    'rejects the date-like tag %s',
    version => {
      expect(parseVersion(version)).toBeNull();
    },
  );

  // Year-based versioning is real, so a four-digit major stays valid.
  it('accepts a four-digit major version', () => {
    expect(parseVersion('2023.1.0')).toEqual({ parts: [2023, 1, 0], prerelease: null });
  });
});

describe('compareVersions', () => {
  // Field-by-field, so a longer field is not read as a bigger number.
  it('orders 0.10.0 above 0.9.0', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });

  it('treats missing fields as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  it('orders a prerelease below its release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });

  // Numeric prerelease identifiers compare as numbers, not as strings.
  it('orders beta.10 above beta.9', () => {
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBeGreaterThan(0);
  });

  it('orders a shorter prerelease first', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBeLessThan(0);
  });
});

describe('pickLatestVersion', () => {
  it('ignores prereleases when a stable version exists', () => {
    expect(pickLatestVersion(['0.6.3', '0.7.0', '0.7.1-rc.1'])).toBe('0.7.0');
  });

  // A chart that only ever publishes prereleases still has a newest one.
  it('falls back to prereleases when nothing else is published', () => {
    expect(pickLatestVersion(['1.0.0-beta.1', '1.0.0-beta.2'])).toBe('1.0.0-beta.2');
  });

  it('skips values that are not versions', () => {
    expect(pickLatestVersion(['latest', '1.0.0', 'sha-abc'])).toBe('1.0.0');
  });

  it('returns null when nothing parses', () => {
    expect(pickLatestVersion(['latest', 'stable'])).toBeNull();
  });

  /*
   * karpenter's registry lists loose tags next to chart versions. Both guards
   * are needed: 20221219 is rejected outright, and a bare 20 would still be set
   * aside for having fewer than three fields.
   */
  it('ignores loose tags when real versions are published', () => {
    const tags = ['20221219', '1.14.0', '1.9.1', 'latest', '20', '0.37.0'];
    expect(pickLatestVersion(tags)).toBe('1.14.0');
  });

  it('prefers three-field versions over shorter ones', () => {
    expect(pickLatestVersion(['99', '1.2.3'])).toBe('1.2.3');
  });

  // A repository publishing only short versions still has a newest one.
  it('falls back to shorter versions when nothing else is published', () => {
    expect(pickLatestVersion(['1.2', '1.3'])).toBe('1.3');
  });
});

describe('parseIndexCharts', () => {
  it('keeps only the version and appVersion of each entry', () => {
    const charts = parseIndexCharts(`entries:
  thing:
  - version: 1.0.0
    appVersion: 2.0.0
    description: a long description
    digest: abc123
    urls:
    - https://example.com/thing-1.0.0.tgz
`);

    expect(charts.get('thing')).toEqual([{ version: '1.0.0', appVersion: '2.0.0' }]);
  });

  it('indexes every chart in the repository', () => {
    const charts = parseIndexCharts(INDEX_YAML);

    expect([...charts.keys()].sort()).toEqual(['alloy-operator', 'other-chart']);
    expect(charts.get('alloy-operator')).toHaveLength(3);
  });

  it('drops entries with no version and charts left empty', () => {
    const charts = parseIndexCharts('entries:\n  thing:\n  - description: no version\n');

    expect(charts.has('thing')).toBe(false);
  });

  it.each(['', 'entries: {}', 'not: an index'])('returns empty for %s', body => {
    expect(parseIndexCharts(body).size).toBe(0);
  });
});

describe('parseOciRef', () => {
  it('appends the chart to the registry path', () => {
    expect(parseOciRef('oci://ghcr.io/org/charts', 'thing')).toEqual({
      host: 'ghcr.io',
      repositoryPath: 'org/charts/thing',
    });
  });

  it('tolerates a trailing slash', () => {
    expect(parseOciRef('oci://ghcr.io/org/', 'thing')?.repositoryPath).toBe('org/thing');
  });

  it.each([
    'https://example.com/charts',
    'oci://ghcr.io',
  ])('returns null for %s', repository => {
    expect(parseOciRef(repository, 'thing')).toBeNull();
  });
});

// The backend fetches these URLs itself, so a caller must not be able to aim it
// at the cluster or the node.
describe('isBlockedHost', () => {
  it.each([
    'localhost',
    'app.localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
    '10.1.2.3',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    'kubernetes.default.svc',
    'argocd-server.argocd.svc.cluster.local',
    'metadata.internal',
  ])('blocks %s', hostname => {
    expect(isBlockedHost(hostname)).toBe(true);
  });

  it.each([
    'grafana.github.io',
    'charts.bitnami.com',
    'ghcr.io',
    '172.32.0.1',
    '11.0.0.1',
  ])('allows %s', hostname => {
    expect(isBlockedHost(hostname)).toBe(false);
  });
});

describe('assertFetchableUrl', () => {
  it('accepts a public https URL', () => {
    expect(assertFetchableUrl('https://grafana.github.io/helm-charts').hostname).toBe(
      'grafana.github.io',
    );
  });

  it.each([
    ['http://grafana.github.io', /refusing to read over http:/],
    ['file:///etc/passwd', /refusing to read over file:/],
    ['https://169.254.169.254/latest/meta-data', /internal address/],
    ['not-a-url', /not a URL/],
  ])('rejects %s', (url, message) => {
    expect(() => assertFetchableUrl(url)).toThrow(message);
  });
});

describe('UpstreamChartStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as any;
  });

  it('reads the newest stable version from index.yaml', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockResponse({ body: INDEX_YAML }),
    );

    const result = await createStore().getLatest(HELM_REPO, 'alloy-operator');

    expect(result).toMatchObject({
      latestVersion: '0.7.0',
      latestAppVersion: '1.12.0',
      versionCount: 3,
      source: 'helm-index',
      unavailableReason: null,
    });
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toBe(
      'https://grafana.github.io/helm-charts/index.yaml',
    );
  });

  it('reports a chart the index does not carry', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockResponse({ body: INDEX_YAML }),
    );

    const result = await createStore().getLatest(HELM_REPO, 'absent');

    expect(result.latestVersion).toBeNull();
    expect(result.unavailableReason).toContain('no entry named absent');
  });

  // Parsing a very large index would block the event loop for seconds.
  it('refuses an index above the size limit', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockResponse({ body: '', headers: { 'content-length': String(50 * 1024 * 1024) } }),
    );

    const result = await createStore().getLatest(HELM_REPO, 'alloy-operator');

    expect(result.latestVersion).toBeNull();
    expect(result.unavailableReason).toContain('above the');
  });

  it('refuses a repository on an internal address', async () => {
    const result = await createStore().getLatest(
      'https://argocd-server.argocd.svc/charts',
      'thing',
    );

    expect(result.latestVersion).toBeNull();
    expect(result.unavailableReason).toBe('the repository could not be read');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // A repository that redirects to the cluster is refused at the hop.
  it('validates each redirect rather than following it blindly', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockResponse({
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      }),
    );

    const result = await createStore().getLatest(HELM_REPO, 'alloy-operator');

    expect(result.latestVersion).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to another public host', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        mockResponse({
          status: 302,
          headers: { location: 'https://cdn.example.com/charts/index.yaml' },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ body: INDEX_YAML }));

    const result = await createStore().getLatest(HELM_REPO, 'alloy-operator');

    expect(result.latestVersion).toBe('0.7.0');
    expect(String((global.fetch as jest.Mock).mock.calls[1][0])).toBe(
      'https://cdn.example.com/charts/index.yaml',
    );
  });

  it('does not leak the underlying failure to the caller', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.0.5:443'),
    );

    const result = await createStore().getLatest(HELM_REPO, 'alloy-operator');

    expect(result.unavailableReason).toBe('the repository could not be read');
  });

  it('reports a failed request without caching it', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockResponse({ status: 503 }))
      .mockResolvedValueOnce(mockResponse({ body: INDEX_YAML }));
    const store = createStore();

    expect((await store.getLatest(HELM_REPO, 'alloy-operator')).latestVersion).toBeNull();
    expect((await store.getLatest(HELM_REPO, 'alloy-operator')).latestVersion).toBe('0.7.0');
  });

  it('serves a repeated lookup from the cache', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockResponse({ body: INDEX_YAML }),
    );
    const store = createStore();

    await store.getLatest(HELM_REPO, 'alloy-operator');
    await store.getLatest(HELM_REPO, 'alloy-operator');

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  /*
   * The whole point of caching per repository: one index answers every chart in
   * it, so a second chart must not fetch and parse the same file again.
   */
  // A cached answer must not present itself as freshly read.
  it('keeps the original checkedAt on a cached answer', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockResponse({ body: INDEX_YAML }),
    );
    const store = createStore();

    const first = await store.getLatest(HELM_REPO, 'alloy-operator');
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await store.getLatest(HELM_REPO, 'alloy-operator');

    expect(second.checkedAt).toBe(first.checkedAt);
  });

  it('answers a second chart from the same index without refetching', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockResponse({ body: INDEX_YAML }),
    );
    const store = createStore();

    const first = await store.getLatest(HELM_REPO, 'alloy-operator');
    const second = await store.getLatest(HELM_REPO, 'other-chart');

    expect(first.latestVersion).toBe('0.7.0');
    expect(second.latestVersion).toBe('9.9.9');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('expires an entry once the TTL passes', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockResponse({ body: INDEX_YAML }))
      .mockResolvedValueOnce(mockResponse({ body: INDEX_YAML }));
    const store = createStore({
      argocdApplicationSet: { upstreamChart: { ttlMinutes: 0 } },
    });

    await store.getLatest(HELM_REPO, 'alloy-operator');
    await store.getLatest(HELM_REPO, 'alloy-operator');

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  describe('revalidation', () => {
    const expiredStore = () =>
      createStore({ argocdApplicationSet: { upstreamChart: { ttlMinutes: 0 } } });

    it('sends the entity tag on a refresh', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(
          mockResponse({ body: INDEX_YAML, headers: { etag: 'W/"abc"' } }),
        )
        .mockResolvedValueOnce(mockResponse({ status: 304 }));
      const store = expiredStore();

      await store.getLatest(HELM_REPO, 'alloy-operator');
      await store.getLatest(HELM_REPO, 'alloy-operator');

      expect((global.fetch as jest.Mock).mock.calls[1][1].headers).toEqual({
        'If-None-Match': 'W/"abc"',
      });
    });

    // A 304 carries no body, so the previously parsed index must be reused.
    it('reuses the parsed index on a 304', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(
          mockResponse({ body: INDEX_YAML, headers: { etag: 'W/"abc"' } }),
        )
        .mockResolvedValueOnce(mockResponse({ status: 304 }));
      const store = expiredStore();

      await store.getLatest(HELM_REPO, 'alloy-operator');
      const result = await store.getLatest(HELM_REPO, 'alloy-operator');

      expect(result.latestVersion).toBe('0.7.0');
      expect(result.versionCount).toBe(3);
    });

    // A 304 confirms the value is current, so it counts as a read.
    it('restamps checkedAt on a 304', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(
          mockResponse({ body: INDEX_YAML, headers: { etag: 'W/"abc"' } }),
        )
        .mockResolvedValueOnce(mockResponse({ status: 304 }));
      const store = expiredStore();

      const first = await store.getLatest(HELM_REPO, 'alloy-operator');
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = await store.getLatest(HELM_REPO, 'alloy-operator');

      expect(
        new Date(second.checkedAt).getTime(),
      ).toBeGreaterThan(new Date(first.checkedAt).getTime());
    });

    it('omits the header when no entity tag was given', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(mockResponse({ body: INDEX_YAML }))
        .mockResolvedValueOnce(mockResponse({ body: INDEX_YAML }));
      const store = expiredStore();

      await store.getLatest(HELM_REPO, 'alloy-operator');
      await store.getLatest(HELM_REPO, 'alloy-operator');

      expect((global.fetch as jest.Mock).mock.calls[1][1].headers).toBeUndefined();
    });
  });

  describe('OCI registries', () => {
    it('reads versions from the tag listing', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockResponse({ body: '{"tags":["1.0.0","1.2.0","0.9.0"]}' }),
      );

      const result = await createStore().getLatest('oci://ghcr.io/org/charts', 'thing');

      expect(result).toMatchObject({
        latestVersion: '1.2.0',
        versionCount: 3,
        source: 'oci-tags',
      });
      expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toBe(
        'https://ghcr.io/v2/org/charts/thing/tags/list?n=1000',
      );
    });

    // Anonymous pulls still need a bearer token the registry advertises.
    it('follows the token challenge on a 401', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(
          mockResponse({
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:org/charts/thing:pull"',
            },
          }),
        )
        .mockResolvedValueOnce(mockResponse({ body: '{"token":"abc"}' }))
        .mockResolvedValueOnce(mockResponse({ body: '{"tags":["2.0.0"]}' }));

      const result = await createStore().getLatest('oci://ghcr.io/org/charts', 'thing');

      expect(result.latestVersion).toBe('2.0.0');
      const tokenUrl = String((global.fetch as jest.Mock).mock.calls[1][0]);
      expect(tokenUrl).toContain('https://ghcr.io/token?');
      expect(tokenUrl).toContain('service=ghcr.io');
      expect((global.fetch as jest.Mock).mock.calls[2][1].headers.Authorization).toBe(
        'Bearer abc',
      );
    });

    // The realm is registry-supplied, so a realm pointing elsewhere is ignored.
    it('ignores a token realm on a different host', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockResponse({
          status: 401,
          headers: {
            'www-authenticate': 'Bearer realm="https://attacker.example.com/token"',
          },
        }),
      );

      const result = await createStore().getLatest('oci://ghcr.io/org/charts', 'thing');

      expect(result.unavailableReason).toBe('registry requires credentials');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('reports a registry that will not issue a token', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockResponse({ status: 401, headers: {} }),
      );

      const result = await createStore().getLatest('oci://ghcr.io/org/charts', 'thing');

      expect(result.unavailableReason).toBe('registry requires credentials');
    });

    it('reports an empty tag listing', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockResponse({ body: '{"tags":[]}' }),
      );

      const result = await createStore().getLatest('oci://ghcr.io/org/charts', 'thing');

      expect(result.latestVersion).toBeNull();
      expect(result.unavailableReason).toBe('the registry lists no tags');
    });
  });
});
