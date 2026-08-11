import knex, { Knex } from 'knex';
import { UpstreamChart } from './UpstreamChartStore';
import { toIsoStamp, UpstreamVersionStore } from './UpstreamVersionStore';

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

/*
 * Production runs Postgres, where `timestamp` is `timestamptz` and reads back as
 * a Date, while SQLite returns what it was given. Either can also yield an epoch
 * in milliseconds, so the mapping must not depend on which database is behind it.
 */
describe('toIsoStamp', () => {
  const stamp = '2026-08-12T01:02:03.000Z';

  it.each([
    ['a Date, as Postgres returns', new Date(stamp)],
    ['an ISO string, as SQLite returns', stamp],
    ['an epoch in milliseconds', Date.parse(stamp)],
    ['an epoch as a string', String(Date.parse(stamp))],
  ])('reads %s', (_label, value) => {
    expect(toIsoStamp(value)).toBe(stamp);
  });

  it.each([null, undefined, ''])('returns empty for %s', value => {
    expect(toIsoStamp(value)).toBe('');
  });
});

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

  /*
   * Production runs Postgres, where `timestamp` is `timestamptz` and comes back
   * as a Date rather than the string SQLite returns. Both have to read out as
   * the same ISO stamp, since the UI turns it into "checked 4 minutes ago".
   */
  describe('timestamp handling', () => {
    const stamp = '2026-08-12T01:02:03.000Z';

    it('reads a stored string back as an ISO stamp', async () => {
      await store.save(chartOf({ checkedAt: stamp }));

      const [stored] = await store.listAll();
      expect(stored.checkedAt).toBe(stamp);
      expect(await store.lastCheckedAt()).toBe(stamp);
    });

    it('reads a Date column back as an ISO stamp', async () => {
      await db('appset_upstream_versions').insert({
        id: `${REPO}|from-date`,
        repository: REPO,
        chart: 'from-date',
        latest_version: '1.0.0',
        version_count: 1,
        source: 'helm-index',
        checked_at: new Date(stamp),
      });

      const [stored] = await store.listAll();
      expect(stored.checkedAt).toBe(stamp);
    });
  });
});
