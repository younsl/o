import { ConfigReader } from '@backstage/config';
import {
  ApplicationSetService,
  deriveAppVersion,
  lastPathSegment,
  mapBranchCommit,
  parseImageRef,
} from './ApplicationSetService';
import { MUTE_ANNOTATION } from './types';

const mockListNamespacedCustomObject = jest.fn();

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    loadFromCluster: jest.fn(),
    loadFromClusterAndUser: jest.fn(),
    makeApiClient: jest.fn(() => ({
      listNamespacedCustomObject: mockListNamespacedCustomObject,
    })),
  })),
  CustomObjectsApi: jest.fn(),
  KubernetesObjectApi: { makeApiClient: jest.fn() },
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as any;

function createService(configData: Record<string, any> = {}, chartMetadata?: any) {
  return new ApplicationSetService({
    config: new ConfigReader(configData),
    logger: mockLogger,
    chartMetadata,
  });
}

/** A store that answers every path with the same Chart.yaml. */
function stubChartMetadata(metadata: any) {
  return {
    isSupported: () => true,
    get: jest.fn().mockResolvedValue(metadata),
  };
}

function makeItem(options: {
  name?: string;
  namespace?: string;
  annotations?: Record<string, string>;
  generators?: Record<string, any>[];
  source?: Record<string, any>;
  sources?: Record<string, any>[];
  gitGeneratorRevision?: string;
  resources?: { name: string; status?: string }[];
} = {}): any {
  const spec: any = {
    generators: options.generators ?? [{ git: {} }],
    template: { spec: {} },
  };

  if (options.source) {
    spec.template.spec.source = options.source;
  }
  if (options.sources) {
    spec.template.spec.sources = options.sources;
  }
  if (options.gitGeneratorRevision) {
    spec.generators = [
      {
        git: {
          template: {
            spec: { source: { targetRevision: options.gitGeneratorRevision } },
          },
        },
      },
    ];
  }

  return {
    metadata: {
      name: options.name ?? 'test-appset',
      namespace: options.namespace ?? 'argocd',
      creationTimestamp: '2024-01-01T00:00:00Z',
      annotations: options.annotations ?? {},
    },
    spec,
    status: {
      resources: options.resources ?? [],
    },
  };
}

function makeApp(options: {
  name: string;
  namespace?: string;
  owner?: string | null;
  source?: Record<string, any>;
  sources?: Record<string, any>[];
  images?: string[];
  syncStatus?: string;
  healthStatus?: string;
  revision?: string;
}): any {
  const owner = options.owner === undefined ? 'test-appset' : options.owner;

  return {
    metadata: {
      name: options.name,
      namespace: options.namespace ?? 'argocd',
      ownerReferences: owner
        ? [{ apiVersion: 'argoproj.io/v1alpha1', kind: 'ApplicationSet', name: owner }]
        : undefined,
    },
    spec: {
      ...(options.source ? { source: options.source } : {}),
      ...(options.sources ? { sources: options.sources } : {}),
    },
    status: {
      summary: options.images ? { images: options.images } : {},
      sync: {
        status: options.syncStatus ?? 'Synced',
        ...(options.revision ? { revision: options.revision } : {}),
      },
      health: { status: options.healthStatus ?? 'Healthy' },
    },
  };
}

// listApplicationSets lists ApplicationSets first, then Applications.
async function listOne(item: any, applications: any[] = [], chartMetadata?: any) {
  mockListNamespacedCustomObject
    .mockResolvedValueOnce({ items: [item] })
    .mockResolvedValueOnce({ items: applications });
  const service = createService({}, chartMetadata);
  const results = await service.listApplicationSets();
  return results[0];
}

describe('ApplicationSetService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('targetRevision detection', () => {
    it('treats "HEAD" as head revision', async () => {
      const result = await listOne(
        makeItem({ source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'HEAD' } }),
      );
      expect(result.targetRevisions).toEqual(['HEAD']);
      expect(result.isHeadRevision).toBe(true);
    });

    it('treats explicit version tag as non-head', async () => {
      const result = await listOne(
        makeItem({ source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'v1.2.3' } }),
      );
      expect(result.targetRevisions).toEqual(['v1.2.3']);
      expect(result.isHeadRevision).toBe(false);
    });

    it('treats missing targetRevision as HEAD', async () => {
      const result = await listOne(
        makeItem({ source: { repoURL: 'https://github.com/org/repo.git' } }),
      );
      expect(result.targetRevisions).toEqual(['HEAD']);
      expect(result.isHeadRevision).toBe(true);
    });

    it('treats Go template expression as head revision', async () => {
      const result = await listOne(
        makeItem({ source: { repoURL: 'https://github.com/org/repo.git', targetRevision: '{{.branch}}' } }),
      );
      expect(result.targetRevisions).toEqual(['{{.branch}}']);
      expect(result.isHeadRevision).toBe(true);
    });

    it('treats mixed HEAD + version in multi-source as non-head', async () => {
      const result = await listOne(
        makeItem({
          sources: [
            { repoURL: 'https://github.com/org/repo.git', targetRevision: 'HEAD' },
            { repoURL: 'https://github.com/org/chart.git', targetRevision: 'v1.0' },
          ],
        }),
      );
      expect(result.targetRevisions).toContain('HEAD');
      expect(result.targetRevisions).toContain('v1.0');
      expect(result.isHeadRevision).toBe(false);
    });

    it('extracts revision from git generator', async () => {
      const result = await listOne(
        makeItem({
          source: { repoURL: 'https://github.com/org/repo.git' },
          gitGeneratorRevision: 'release-1.0',
        }),
      );
      expect(result.targetRevisions).toContain('release-1.0');
      expect(result.isHeadRevision).toBe(false);
    });

    it('deduplicates revisions', async () => {
      const item = makeItem({
        source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'main' },
      });
      // Also add same revision in git generator
      item.spec.generators = [
        { git: { template: { spec: { source: { targetRevision: 'main' } } } } },
      ];
      const result = await listOne(item);
      expect(result.targetRevisions).toEqual(['main']);
    });
  });

  describe('repoURL and repoName', () => {
    it('parses HTTPS URL and strips .git suffix', async () => {
      const result = await listOne(
        makeItem({ source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'HEAD' } }),
      );
      expect(result.repoUrl).toBe('https://github.com/org/repo.git');
      expect(result.repoName).toBe('org/repo');
    });

    it('parses SSH URL', async () => {
      const result = await listOne(
        makeItem({ source: { repoURL: 'git@github.com:org/repo.git', targetRevision: 'HEAD' } }),
      );
      expect(result.repoName).toBe('org/repo');
    });

    it('returns empty string for missing repoURL', async () => {
      const result = await listOne(makeItem({ source: { targetRevision: 'HEAD' } }));
      expect(result.repoUrl).toBe('');
      expect(result.repoName).toBe('');
    });
  });

  describe('generators', () => {
    it('extracts generator type keys', async () => {
      const result = await listOne(
        makeItem({
          generators: [{ git: {} }, { list: {} }],
          source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'HEAD' },
        }),
      );
      expect(result.generators).toEqual(['git', 'list']);
    });
  });

  describe('muted annotation', () => {
    it('returns muted=true when annotation is set', async () => {
      const result = await listOne(
        makeItem({
          annotations: { [MUTE_ANNOTATION]: 'true' },
          source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'HEAD' },
        }),
      );
      expect(result.muted).toBe(true);
    });

    it('defaults muted to false', async () => {
      const result = await listOne(
        makeItem({ source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'HEAD' } }),
      );
      expect(result.muted).toBe(false);
    });
  });

  describe('applications', () => {
    it('sorts applications alphabetically from status.resources', async () => {
      const result = await listOne(
        makeItem({
          source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'HEAD' },
          resources: [{ name: 'charlie' }, { name: 'alpha' }, { name: 'bravo' }],
        }),
      );
      expect(result.applications).toEqual(['alpha', 'bravo', 'charlie']);
      expect(result.applicationCount).toBe(3);
    });

    it('counts synced applications from status.resources[].status', async () => {
      const result = await listOne(
        makeItem({
          source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'HEAD' },
          resources: [
            { name: 'app-a', status: 'Synced' },
            { name: 'app-b', status: 'OutOfSync' },
            { name: 'app-c', status: 'Synced' },
          ],
        }),
      );
      expect(result.syncedCount).toBe(2);
      expect(result.syncedApplications).toEqual(['app-a', 'app-c']);
      expect(result.applicationCount).toBe(3);
    });

    it('returns syncedCount 0 when no resources', async () => {
      const result = await listOne(
        makeItem({ source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'HEAD' } }),
      );
      expect(result.syncedCount).toBe(0);
      expect(result.syncedApplications).toEqual([]);
    });
  });

  describe('parseImageRef', () => {
    it.each([
      ['docker.io/bitnami/redis:7.4.1', 'docker.io/bitnami/redis', '7.4.1'],
      ['registry.local:5000/team/app:1.0.0', 'registry.local:5000/team/app', '1.0.0'],
      ['nginx:1.27', 'nginx', '1.27'],
    ])('parses %s', (ref, repo, tag) => {
      expect(parseImageRef(ref)).toEqual({ repo, tag });
    });

    it('returns null tag for an untagged reference', () => {
      expect(parseImageRef('docker.io/library/nginx')).toEqual({
        repo: 'docker.io/library/nginx',
        tag: null,
      });
    });

    // A registry port must not be mistaken for a tag separator.
    it('returns null tag for a digest pin', () => {
      expect(parseImageRef('registry.local:5000/app@sha256:abc123')).toEqual({
        repo: 'registry.local:5000/app',
        tag: null,
      });
    });
  });

  describe('mapBranchCommit', () => {
    it('reads the commit a branch listing embeds', () => {
      expect(
        mapBranchCommit({
          id: '446e2842aabbccddeeff',
          short_id: '446e2842',
          title: 'Bump alloy-operator to 0.6.3',
          author_name: 'Someone',
          committed_date: '2026-08-10T04:05:06.000Z',
          web_url: 'https://gitlab.example.com/devops/k8s/-/commit/446e2842',
        }),
      ).toEqual({
        id: '446e2842aabbccddeeff',
        shortId: '446e2842',
        title: 'Bump alloy-operator to 0.6.3',
        authorName: 'Someone',
        committedDate: '2026-08-10T04:05:06.000Z',
        webUrl: 'https://gitlab.example.com/devops/k8s/-/commit/446e2842',
      });
    });

    it('derives a short id and falls back to created_at', () => {
      const result = mapBranchCommit({
        id: 'abcdef1234567890',
        created_at: '2026-08-10T04:05:06.000Z',
      });

      expect(result).toMatchObject({
        id: 'abcdef1234567890',
        shortId: 'abcdef12',
        title: '',
        authorName: 'unknown',
        committedDate: '2026-08-10T04:05:06.000Z',
        webUrl: null,
      });
    });

    it.each([undefined, null, {}])('returns null for %s', commit => {
      expect(mapBranchCommit(commit)).toBeNull();
    });
  });

  describe('listBranches', () => {
    const config = {
      integrations: { gitlab: [{ host: 'gitlab.example.com', token: 'secret' }] },
    };

    beforeEach(() => {
      global.fetch = jest.fn() as any;
    });

    it('returns each branch with its tip commit', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            name: 'master',
            default: true,
            commit: {
              id: 'aaaa1111bbbb',
              short_id: 'aaaa1111',
              title: 'Initial',
              author_name: 'Someone',
              committed_date: '2026-08-10T00:00:00.000Z',
              web_url: 'https://gitlab.example.com/c/aaaa1111',
            },
          },
          { name: 'devel', default: false, commit: null },
        ],
      });

      const result = await createService(config).listBranches(
        'https://gitlab.example.com/devops/k8s.git',
      );

      expect(result.defaultBranch).toBe('master');
      expect(result.branches).toEqual([
        {
          name: 'master',
          isDefault: true,
          commit: {
            id: 'aaaa1111bbbb',
            shortId: 'aaaa1111',
            title: 'Initial',
            authorName: 'Someone',
            committedDate: '2026-08-10T00:00:00.000Z',
            webUrl: 'https://gitlab.example.com/c/aaaa1111',
          },
        },
        { name: 'devel', isDefault: false, commit: null },
      ]);
    });

    it('throws on a GitLab error', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      await expect(
        createService(config).listBranches('https://gitlab.example.com/devops/k8s.git'),
      ).rejects.toThrow('GitLab API error: 401 Unauthorized');
    });
  });

  describe('lastPathSegment', () => {
    it.each([
      ['shared/chart-repo/alloy-operator', 'alloy-operator'],
      ['alloy-operator', 'alloy-operator'],
      ['charts/redis/', 'redis'],
    ])('reads %s as %s', (path, expected) => {
      expect(lastPathSegment(path)).toBe(expected);
    });

    it.each([undefined, null, '', '.', './'])('returns null for %s', path => {
      expect(lastPathSegment(path)).toBeNull();
    });
  });

  describe('deriveAppVersion', () => {
    it('prefers the image whose basename matches a hint', () => {
      const images = [
        'docker.io/bitnami/redis-exporter:1.60.0',
        'docker.io/bitnami/redis:7.4.1',
      ];
      expect(deriveAppVersion(images, ['redis'])).toBe('7.4.1');
    });

    it('falls back to the only image when no hint matches', () => {
      expect(deriveAppVersion(['ghcr.io/org/thing:2.0'], ['other'])).toBe('2.0');
    });

    it('returns null when several images match no hint', () => {
      const images = ['ghcr.io/org/a:1.0', 'ghcr.io/org/b:2.0'];
      expect(deriveAppVersion(images, ['redis'])).toBeNull();
    });

    it('ignores untagged images', () => {
      expect(deriveAppVersion(['ghcr.io/org/a@sha256:abc'], [null])).toBeNull();
    });
  });

  describe('application version detail', () => {
    const appSetItem = () =>
      makeItem({
        source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'HEAD' },
        resources: [{ name: 'redis', status: 'Synced' }],
      });

    it('reads chart, chart version and app version from the Application CR', async () => {
      const result = await listOne(appSetItem(), [
        makeApp({
          name: 'redis',
          source: {
            repoURL: 'https://charts.bitnami.com/bitnami',
            chart: 'redis',
            targetRevision: '20.1.0',
          },
          images: ['docker.io/bitnami/redis:7.4.1-debian-12-r0'],
          revision: '20.1.0',
        }),
      ]);

      expect(result.applicationInfos.redis).toMatchObject({
        chart: 'redis',
        chartVersion: '20.1.0',
        appVersion: '7.4.1-debian-12-r0',
        appVersionSource: 'image-tag',
        syncStatus: 'Synced',
        healthStatus: 'Healthy',
      });
      expect(result.charts).toEqual(['redis']);
      expect(result.chartVersions).toEqual(['20.1.0']);
    });

    it('finds the chart in a multi-source Application', async () => {
      const result = await listOne(appSetItem(), [
        makeApp({
          name: 'redis',
          sources: [
            { repoURL: 'https://github.com/org/values.git', targetRevision: 'HEAD' },
            {
              repoURL: 'https://charts.bitnami.com/bitnami',
              chart: 'redis',
              targetRevision: '20.1.0',
            },
          ],
        }),
      ]);

      expect(result.applicationInfos.redis.chart).toBe('redis');
      expect(result.applicationInfos.redis.chartVersion).toBe('20.1.0');
    });

    it('leaves chart null for a plain manifest source', async () => {
      const result = await listOne(appSetItem(), [
        makeApp({
          name: 'redis',
          source: { repoURL: 'https://github.com/org/repo.git', targetRevision: 'HEAD' },
        }),
      ]);

      expect(result.applicationInfos.redis.chart).toBeNull();
      expect(result.charts).toEqual([]);
    });

    /*
     * A wrapper chart in a git path: `chart` is absent and `targetRevision` is
     * the git revision, so the chart name comes from the path and the version
     * is unavailable. The chart's own version lives in the wrapper Chart.yaml,
     * which ArgoCD never copies into the Application.
     */
    describe('wrapper chart in a git path', () => {
      const wrapperApp = () =>
        makeApp({
          name: 'shared-alloy-operator',
          source: {
            repoURL: 'https://gitlab.example.com/devops/k8s.git',
            path: 'shared/chart-repo/alloy-operator',
            targetRevision: 'HEAD',
            helm: { releaseName: 'alloy-operator', valueFiles: ['values.yaml'] },
          },
          images: [
            'harbor.example.com/docker.io-proxy/grafana/alloy:v1.18.1',
            'harbor.example.com/ghcr.io-proxy/grafana/alloy-operator:1.11.1',
            'harbor.example.com/quay.io-proxy/prometheus-operator/prometheus-config-reloader:v0.81.0',
          ],
          revision: '446e2842',
        });

      it('names the chart from the source path', async () => {
        const result = await listOne(appSetItem(), [wrapperApp()]);

        expect(result.applicationInfos['shared-alloy-operator'].chart).toBe('alloy-operator');
        expect(result.charts).toEqual(['alloy-operator']);
      });

      // HEAD is a git revision, not a chart version.
      it('reports no chart version', async () => {
        const result = await listOne(appSetItem(), [wrapperApp()]);

        expect(result.applicationInfos['shared-alloy-operator'].chartVersion).toBeNull();
        expect(result.chartVersions).toEqual([]);
      });

      // The Application name carries an environment prefix, so it never
      // matches an image basename. The path and release name do.
      it('derives the app version from the image matching the chart name', async () => {
        const result = await listOne(appSetItem(), [wrapperApp()]);

        expect(result.applicationInfos['shared-alloy-operator'].appVersion).toBe('1.11.1');
      });

      describe('with Chart.yaml available', () => {
        const CHART_YAML = `name: alloy-operator
version: 0.2.0
appVersion: "1.11.1"
dependencies:
- name: alloy-operator
  version: 0.6.3
  repository: https://grafana.github.io/helm-charts
`;

        const metadata = {
          raw: CHART_YAML,
          name: 'alloy-operator',
          version: '0.2.0',
          appVersion: '1.11.1',
          dependencies: [
            {
              name: 'alloy-operator',
              version: '0.6.3',
              repository: 'https://grafana.github.io/helm-charts',
            },
          ],
          upstreamVersion: '0.6.3',
        };

        // The pinned dependency, not the wrapper's own version, is the version
        // of the chart actually being deployed.
        it('fills the chart version from the pinned dependency', async () => {
          const result = await listOne(
            appSetItem(),
            [wrapperApp()],
            stubChartMetadata(metadata),
          );
          const info = result.applicationInfos['shared-alloy-operator'];

          expect(info.chartVersion).toBe('0.6.3');
          expect(info.upstreamChart).toBe('alloy-operator');
          expect(result.chartVersions).toEqual(['0.6.3']);
        });

        it('records the file and the line the version came from', async () => {
          const result = await listOne(
            appSetItem(),
            [wrapperApp()],
            stubChartMetadata(metadata),
          );
          const origin = result.applicationInfos['shared-alloy-operator'].chartVersionOrigin;

          expect(origin).toMatchObject({
            kind: 'chart-yaml',
            location: 'shared/chart-repo/alloy-operator/Chart.yaml @ HEAD',
            content: CHART_YAML,
          });
          // `  version: 0.6.3` is line 6, not the chart's own on line 2.
          expect(origin!.highlightLines).toEqual([6]);
        });

        it('reads Chart.yaml at the targetRevision, not the synced commit', async () => {
          const store = stubChartMetadata(metadata);
          await listOne(appSetItem(), [wrapperApp()], store);

          expect(store.get).toHaveBeenCalledWith(
            'https://gitlab.example.com/devops/k8s.git',
            'shared/chart-repo/alloy-operator',
            'HEAD',
          );
        });

        // A wrapper is often named differently from what it wraps, so the
        // dependency name is a hint no field on the Application provides.
        it('matches an image using the dependency name', async () => {
          const result = await listOne(
            appSetItem(),
            [
              makeApp({
                name: 'prd-pay-jenkins',
                source: {
                  repoURL: 'https://gitlab.example.com/devops/k8s.git',
                  path: 'prd/chart-repo/pay-jenkins',
                  targetRevision: 'HEAD',
                  helm: { releaseName: 'pay-jenkins' },
                },
                images: [
                  'harbor.example.com/docker.io-proxy/jenkins/jenkins:2.516.3-lts',
                  'harbor.example.com/docker.io-proxy/kiwigrid/k8s-sidecar:1.30.10',
                ],
              }),
            ],
            stubChartMetadata({
              raw: 'name: pay-jenkins\nversion: 0.1.0\ndependencies:\n- name: jenkins\n  version: 5.8.16\n',
              name: 'pay-jenkins',
              version: '0.1.0',
              appVersion: null,
              dependencies: [{ name: 'jenkins', version: '5.8.16', repository: null }],
              upstreamVersion: '5.8.16',
            }),
          );

          expect(result.applicationInfos['prd-pay-jenkins']).toMatchObject({
            appVersion: '2.516.3-lts',
            appVersionSource: 'image-tag',
          });
        });

        it('falls back to the Chart.yaml appVersion when no image matches', async () => {
          const result = await listOne(
            appSetItem(),
            [
              makeApp({
                name: 'shared-kagent',
                source: {
                  repoURL: 'https://gitlab.example.com/devops/k8s.git',
                  path: 'shared/chart-repo/kagent',
                  targetRevision: 'HEAD',
                  helm: { releaseName: 'kagent' },
                },
                images: ['registry/app:1.0', 'registry/controller:2.0'],
              }),
            ],
            stubChartMetadata({
              raw: 'name: kagent\nversion: 0.1.0\nappVersion: 0.9.12\n',
              name: 'kagent',
              version: '0.1.0',
              appVersion: '0.9.12',
              dependencies: [],
              upstreamVersion: '0.1.0',
            }),
          );

          // A declared version, not an observed one, so the source says so.
          expect(result.applicationInfos['shared-kagent']).toMatchObject({
            appVersion: '0.9.12',
            appVersionSource: 'chart-yaml',
          });
        });

        it('keeps the image tag when one already matched', async () => {
          const result = await listOne(
            appSetItem(),
            [wrapperApp()],
            stubChartMetadata({ ...metadata, appVersion: '9.9.9-stale' }),
          );

          expect(result.applicationInfos['shared-alloy-operator'].appVersion).toBe('1.11.1');
        });
      });
    });

    it('falls back to the release name when the path is the repository root', async () => {
      const result = await listOne(appSetItem(), [
        makeApp({
          name: 'redis-prd',
          source: {
            repoURL: 'https://gitlab.example.com/devops/k8s.git',
            path: '.',
            targetRevision: 'HEAD',
            helm: { releaseName: 'redis' },
          },
          images: ['docker.io/bitnami/redis:7.4.1', 'docker.io/bitnami/redis-exporter:1.60.0'],
        }),
      ]);

      expect(result.applicationInfos['redis-prd'].chart).toBe('redis');
      expect(result.applicationInfos['redis-prd'].appVersion).toBe('7.4.1');
    });

    it('skips Applications owned by another ApplicationSet', async () => {
      const result = await listOne(appSetItem(), [
        makeApp({ name: 'other', owner: 'different-appset' }),
      ]);

      expect(result.applicationInfos).toEqual({});
    });

    it('skips Applications with no ApplicationSet owner', async () => {
      const result = await listOne(appSetItem(), [
        makeApp({ name: 'standalone', owner: null }),
      ]);

      expect(result.applicationInfos).toEqual({});
    });

    it('deduplicates charts across Applications', async () => {
      const result = await listOne(appSetItem(), [
        makeApp({
          name: 'redis-a',
          source: { chart: 'redis', targetRevision: '20.1.0' },
        }),
        makeApp({
          name: 'redis-b',
          source: { chart: 'redis', targetRevision: '20.1.0' },
        }),
      ]);

      expect(result.charts).toEqual(['redis']);
      expect(result.chartVersions).toEqual(['20.1.0']);
      expect(Object.keys(result.applicationInfos).sort()).toEqual(['redis-a', 'redis-b']);
    });

    // Losing version detail must not hide the ApplicationSets themselves.
    it('returns empty detail when listing Applications fails', async () => {
      mockListNamespacedCustomObject
        .mockResolvedValueOnce({ items: [appSetItem()] })
        .mockRejectedValueOnce(new Error('forbidden'));

      const results = await createService().listApplicationSets();

      expect(results).toHaveLength(1);
      expect(results[0].applicationInfos).toEqual({});
      expect(results[0].charts).toEqual([]);
    });

    /*
     * A missing permission empties every version field, which is indistinguishable
     * from charts that carry no version unless the cause is reported.
     */
    describe('applicationsReadable', () => {
      it('is null before any fetch', () => {
        expect(createService().isApplicationsReadable()).toBeNull();
      });

      it('is false after listing Applications is refused', async () => {
        mockListNamespacedCustomObject
          .mockResolvedValueOnce({ items: [appSetItem()] })
          .mockRejectedValueOnce(new Error('applications.argoproj.io is forbidden'));
        const service = createService();

        await service.listApplicationSets();

        expect(service.isApplicationsReadable()).toBe(false);
      });

      it('is true once Applications can be listed', async () => {
        mockListNamespacedCustomObject
          .mockResolvedValueOnce({ items: [appSetItem()] })
          .mockResolvedValueOnce({ items: [] });
        const service = createService();

        await service.listApplicationSets();

        expect(service.isApplicationsReadable()).toBe(true);
      });

      // A permission granted while running must clear the warning.
      it('recovers when a later fetch succeeds', async () => {
        mockListNamespacedCustomObject
          .mockResolvedValueOnce({ items: [appSetItem()] })
          .mockRejectedValueOnce(new Error('forbidden'))
          .mockResolvedValueOnce({ items: [appSetItem()] })
          .mockResolvedValueOnce({ items: [] });
        const service = createService();

        await service.listApplicationSets();
        await service.listApplicationSets();

        expect(service.isApplicationsReadable()).toBe(true);
      });
    });
  });

});
