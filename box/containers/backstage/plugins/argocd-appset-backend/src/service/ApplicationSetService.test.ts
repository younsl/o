import { ConfigReader } from '@backstage/config';
import { ApplicationSetService } from './ApplicationSetService';
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

function createService(configData: Record<string, any> = {}) {
  return new ApplicationSetService({
    config: new ConfigReader(configData),
    logger: mockLogger,
  });
}

function makeItem(options: {
  name?: string;
  namespace?: string;
  annotations?: Record<string, string>;
  generators?: Record<string, any>[];
  source?: Record<string, any>;
  sources?: Record<string, any>[];
  gitGeneratorRevision?: string;
  resources?: { name: string }[];
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

async function listOne(item: any) {
  mockListNamespacedCustomObject.mockResolvedValueOnce({ items: [item] });
  const service = createService();
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
  });
});
