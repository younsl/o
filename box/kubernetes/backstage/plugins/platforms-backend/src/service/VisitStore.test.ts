import knex, { Knex } from 'knex';
import { VisitStore } from './VisitStore';

describe('VisitStore', () => {
  let db: Knex;
  let store: VisitStore;

  beforeEach(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    store = await VisitStore.create({ database: db, timezone: 'Asia/Seoul' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function platformsInTable(): Promise<string[]> {
    const rows = await db('platform_visits').distinct('platform').orderBy('platform');
    return rows.map(row => row.platform as string);
  }

  it('records a visit under today key in the configured timezone', async () => {
    await store.recordVisit('Grafana', 'user:default/a');

    const rows = await store.getRecentVisits();
    expect(rows).toEqual([
      { platform: 'Grafana', userRef: 'user:default/a', dayKey: store.todayKey() },
    ]);
  });

  it('drops visits for platforms no longer in the catalog', async () => {
    await store.recordVisit('Grafana', 'user:default/a');
    await store.recordVisit('RetiredTool', 'user:default/a');
    await store.recordVisit('RetiredTool', 'user:default/b');

    const deleted = await store.purgeUnknownPlatforms(['Grafana', 'ArgoCD']);

    expect(deleted).toBe(2);
    expect(await platformsInTable()).toEqual(['Grafana']);
  });

  it('refuses to purge on an empty catalog rather than wiping the table', async () => {
    await store.recordVisit('Grafana', 'user:default/a');

    const deleted = await store.purgeUnknownPlatforms([]);

    expect(deleted).toBe(0);
    expect(await platformsInTable()).toEqual(['Grafana']);
  });

  it('purges rows older than the retention window', async () => {
    await store.recordVisit('Grafana', 'user:default/a');
    await db('platform_visits').insert({
      platform: 'Grafana',
      user_ref: 'user:default/old',
      day_key: '2020-01-01',
      visited_at: '2020-01-01T00:00:00.000Z',
    });

    const deleted = await store.purgeExpired();

    expect(deleted).toBe(1);
    expect(await store.getRecentVisits()).toHaveLength(1);
  });

  it('excludes rows outside the stats window from getRecentVisits', async () => {
    await db('platform_visits').insert({
      platform: 'Grafana',
      user_ref: 'user:default/a',
      day_key: '2020-01-01',
      visited_at: '2020-01-01T00:00:00.000Z',
    });

    expect(await store.getRecentVisits()).toEqual([]);
  });
});
