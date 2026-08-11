import { knownUpstreamPairs } from './router';
import { ApplicationSetResponse } from './types';

function appSet(
  name: string,
  infos: { name: string; upstreamRepository?: string; upstreamChart?: string }[],
): ApplicationSetResponse {
  return {
    name,
    namespace: 'argocd',
    generators: [],
    applicationCount: infos.length,
    syncedCount: infos.length,
    applications: infos.map(info => info.name),
    syncedApplications: [],
    applicationStatuses: {},
    applicationInfos: Object.fromEntries(
      infos.map(info => [
        info.name,
        {
          name: info.name,
          chart: null,
          chartVersion: null,
          chartVersionOrigin: null,
          upstreamChart: info.upstreamChart ?? null,
          upstreamRepository: info.upstreamRepository ?? null,
          appVersion: null,
          images: [],
          syncStatus: 'Synced',
          healthStatus: 'Healthy',
          revision: null,
        },
      ]),
    ),
    charts: [],
    chartVersions: [],
    repoUrl: '',
    repoName: '',
    targetRevisions: ['HEAD'],
    isHeadRevision: true,
    muted: false,
    createdAt: '',
  };
}

const cacheOf = (appSets: ApplicationSetResponse[]) =>
  ({ getAppSets: () => appSets }) as any;

/*
 * The upstream lookup makes the backend fetch a URL on a caller's behalf, so
 * only pairs the cluster itself produced may be reached.
 */
describe('knownUpstreamPairs', () => {
  const REPO = 'https://grafana.github.io/helm-charts';

  it('collects each repository and chart pair', () => {
    const pairs = knownUpstreamPairs(
      cacheOf([
        appSet('alloy-operator', [
          { name: 'dev-alloy', upstreamRepository: REPO, upstreamChart: 'alloy-operator' },
        ]),
      ]),
    );

    expect([...pairs.values()]).toEqual([
      { repository: REPO, chart: 'alloy-operator' },
    ]);
  });

  // The same chart in five clusters is one repository read, not five.
  it('deduplicates a chart deployed to several clusters', () => {
    const pairs = knownUpstreamPairs(
      cacheOf([
        appSet('alloy-operator', [
          { name: 'dev-alloy', upstreamRepository: REPO, upstreamChart: 'alloy-operator' },
          { name: 'prd-alloy', upstreamRepository: REPO, upstreamChart: 'alloy-operator' },
          { name: 'stg-alloy', upstreamRepository: REPO, upstreamChart: 'alloy-operator' },
        ]),
      ]),
    );

    expect(pairs.size).toBe(1);
  });

  it('keys by repository and chart so the same name in two repositories is kept', () => {
    const pairs = knownUpstreamPairs(
      cacheOf([
        appSet('a', [
          { name: 'a1', upstreamRepository: REPO, upstreamChart: 'grafana' },
          {
            name: 'a2',
            upstreamRepository: 'oci://ghcr.io/org/charts',
            upstreamChart: 'grafana',
          },
        ]),
      ]),
    );

    expect(pairs.size).toBe(2);
    expect(pairs.has(`${REPO}|grafana`)).toBe(true);
    expect(pairs.has('oci://ghcr.io/org/charts|grafana')).toBe(true);
  });

  it('skips Applications with no upstream dependency', () => {
    const pairs = knownUpstreamPairs(
      cacheOf([
        appSet('a', [
          { name: 'no-repository', upstreamChart: 'thing' },
          { name: 'no-chart', upstreamRepository: REPO },
          { name: 'neither' },
        ]),
      ]),
    );

    expect(pairs.size).toBe(0);
  });

  it('returns nothing for an empty cache', () => {
    expect(knownUpstreamPairs(cacheOf([])).size).toBe(0);
  });
});
