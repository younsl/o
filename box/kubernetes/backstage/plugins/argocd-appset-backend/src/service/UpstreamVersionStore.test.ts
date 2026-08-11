import knex, { Knex } from 'knex';
import { UpstreamChart } from './UpstreamChartStore';
import { UpstreamVersionStore } from './UpstreamVersionStore';

const REPO = 'https://grafana.github.io/helm-charts';

function chartOf(overrides: Partial<UpstreamChart> = {}): UpstreamChart {
  return {
    chart: 'alloy-operator',
    repository: REPO,
    latestVersion: '0.7.0',
    latestAppVersion: '1.12.0',
    versionCount: 3,
    source: 'helm-index',
    unavailableReason: null,
    checkedAt: '2026-08-12T01:02:03.000Z',
    ...overrides,
  };
}

describe('UpstreamVersionStore', () => {
  let db: Knex;
  let store: UpstreamVersionStore;

  beforeEach(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    store = await UpstreamVersionStore.create({ database: db });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('stores and reads a chart back unchanged', async () => {
    const chart = chartOf();
    await store.save(chart);

    expect(await store.listAll()).toEqual([chart]);
  });

  it('keeps a failed lookup with its reason', async () => {
    await store.save(
      chartOf({
        latestVersion: null,
        latestAppVersion: null,
        versionCount: 0,
        unavailableReason: 'the repository could not be read',
      }),
    );

    const [stored] = await store.listAll();
    expect(stored).toMatchObject({
      latestVersion: null,
      latestAppVersion: null,
      versionCount: 0,
      unavailableReason: 'the repository could not be read',
    });
  });

  // Only the newest read matters, so a second save replaces the first.
  it('replaces the row for a chart already stored', async () => {
    await store.save(chartOf({ latestVersion: '0.7.0' }));
    await store.save(chartOf({ latestVersion: '0.8.0', checkedAt: '2026-08-12T02:00:00.000Z' }));

    const stored = await store.listAll();
    expect(stored).toHaveLength(1);
    expect(stored[0].latestVersion).toBe('0.8.0');
    expect(stored[0].checkedAt).toBe('2026-08-12T02:00:00.000Z');
  });

  // The same chart name in two repositories is two different charts.
  it('keys by repository and chart together', async () => {
    await store.save(chartOf({ chart: 'grafana' }));
    await store.save(
      chartOf({ chart: 'grafana', repository: 'oci://ghcr.io/org/charts' }),
    );

    expect(await store.listAll()).toHaveLength(2);
  });

  it('holds several charts from one repository', async () => {
    await store.save(chartOf({ chart: 'alloy-operator' }));
    await store.save(chartOf({ chart: 'grafana' }));
    await store.save(chartOf({ chart: 'tempo-distributed' }));

    const charts = (await store.listAll()).map(stored => stored.chart).sort();
    expect(charts).toEqual(['alloy-operator', 'grafana', 'tempo-distributed']);
  });

  it('returns nothing before anything is stored', async () => {
    expect(await store.listAll()).toEqual([]);
  });

  // create() is called on every backend start.
  it('can be created twice over the same database', async () => {
    await store.save(chartOf());
    const second = await UpstreamVersionStore.create({ database: db });

    expect(await second.listAll()).toHaveLength(1);
  });

  it('builds the key from the repository and chart', () => {
    expect(UpstreamVersionStore.keyOf(REPO, 'grafana')).toBe(`${REPO}|grafana`);
  });
});
