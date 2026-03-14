/**
 * Benchmark test for OpenCostCostStore batch operations.
 *
 * Measures query count and elapsed time for:
 *   - insertDailyCosts (batch pod upsert + batch daily cost insert)
 *   - aggregateMonth   (single INSERT INTO...SELECT)
 *
 * Run:
 *   npx jest --config jest.bench.config.js OpenCostCostStore.bench.test.ts
 */
import knex, { Knex } from 'knex';
import { OpenCostCostStore, DailyCostItem } from './OpenCostCostStore';

/* ────────────────────────────────
 *  Helpers
 * ──────────────────────────────── */

/** Wrap a Knex instance to count raw/builder queries. */
function withQueryCounter(db: Knex): { db: Knex; counter: { count: number } } {
  const counter = { count: 0 };
  db.on('query', () => {
    counter.count++;
  });
  return { db, counter };
}

/** Generate N fake DailyCostItem records with unique pods. */
function generateItems(n: number): DailyCostItem[] {
  const items: DailyCostItem[] = [];
  for (let i = 0; i < n; i++) {
    items.push({
      namespace: `ns-${i % 10}`,
      controllerKind: 'Deployment',
      controller: `deploy-${i % 50}`,
      pod: `pod-${i}`,
      cpuCost: Math.random() * 10,
      ramCost: Math.random() * 5,
      gpuCost: 0,
      pvCost: Math.random() * 2,
      networkCost: Math.random() * 1,
      totalCost: Math.random() * 20,
      carbonCost: Math.random() * 0.5,
    });
  }
  return items;
}

/* ────────────────────────────────
 *  Test suite
 * ──────────────────────────────── */

describe('OpenCostCostStore batch performance', () => {
  let db: Knex;
  let counter: { count: number };
  let store: OpenCostCostStore;

  beforeAll(async () => {
    const rawDb = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    ({ db, counter } = withQueryCounter(rawDb));

    store = await OpenCostCostStore.create({ database: db });

    // Seed a cluster
    await store.ensureCluster('bench-cluster', 'Bench Cluster');
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(() => {
    counter.count = 0;
  });

  /* ─── insertDailyCosts ─── */

  test.each([100, 500, 1000])(
    'insertDailyCosts — %i pods',
    async (podCount) => {
      const clusterId = (await store.getClusterId('bench-cluster'))!;
      const items = generateItems(podCount);
      const date = '2025-01-15';

      // Clean previous run data
      await db('opencost_daily_costs').where({ cluster_id: clusterId, date }).del();

      counter.count = 0;
      const start = performance.now();

      await store.insertDailyCosts(clusterId, date, items);

      const elapsed = performance.now() - start;
      const queries = counter.count;

      // Batch approach: ceil(pods/100) pod upserts + 1 fetch + ceil(items/50) cost upserts
      const expectedMax = Math.ceil(podCount / 100) + 1 + Math.ceil(podCount / 50);

      console.log(
        `  insertDailyCosts(${podCount} pods): ${queries} queries, ${elapsed.toFixed(1)}ms` +
        ` (batch upper bound: ${expectedMax})`,
      );

      // Assert query count is within batch bounds (not N+M individual queries)
      expect(queries).toBeLessThanOrEqual(expectedMax);
      // Sanity: old approach would be > podCount queries
      expect(queries).toBeLessThan(podCount);
    },
    30_000,
  );

  /* ─── aggregateMonth ─── */

  test.each([100, 500, 1000])(
    'aggregateMonth — %i pods across 28 days',
    async (podCount) => {
      const clusterId = (await store.getClusterId('bench-cluster'))!;

      // Seed 28 days of daily data
      for (let day = 1; day <= 28; day++) {
        const date = `2025-02-${String(day).padStart(2, '0')}`;
        const items = generateItems(podCount);
        await store.insertDailyCosts(clusterId, date, items);
      }

      // Clear monthly table
      await db('opencost_monthly_summaries')
        .where({ cluster_id: clusterId, year: 2025, month: 2 })
        .del();

      counter.count = 0;
      const start = performance.now();

      const result = await store.aggregateMonth(clusterId, 2025, 2);

      const elapsed = performance.now() - start;
      const queries = counter.count;

      console.log(
        `  aggregateMonth(${podCount} pods × 28 days): ${queries} queries, ${elapsed.toFixed(1)}ms` +
        ` → ${result} pods aggregated`,
      );

      // Single INSERT...SELECT + 1 COUNT = 2 queries total
      expect(queries).toBe(2);
      expect(result).toBe(podCount);
    },
    120_000,
  );
});
