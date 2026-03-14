import { Knex } from 'knex';

const META_TABLE = 'opencost_meta';
const CLUSTERS_TABLE = 'opencost_clusters';
const PODS_TABLE = 'opencost_pods';
const DAILY_TABLE = 'opencost_daily_costs';
const MONTHLY_TABLE = 'opencost_monthly_summaries';
const RUNS_TABLE = 'opencost_collection_runs';

const SCHEMA_VERSION = 2;

export interface DailyCostItem {
  namespace: string;
  controllerKind: string | null;
  controller: string | null;
  pod: string;
  cpuCost: number;
  ramCost: number;
  gpuCost: number;
  pvCost: number;
  networkCost: number;
  totalCost: number;
  carbonCost: number;
}

export interface DailyCostRow extends DailyCostItem {
  date: string;
}

export interface MonthlySummaryRow {
  namespace: string;
  controllerKind: string | null;
  controller: string | null;
  pod: string;
  cpuCost: number;
  ramCost: number;
  gpuCost: number;
  pvCost: number;
  networkCost: number;
  totalCost: number;
  carbonCost: number;
  daysCovered: number;
}

export interface DailySummaryRow {
  date: string;
  podCount: number;
  cpuCost: number;
  ramCost: number;
  gpuCost: number;
  pvCost: number;
  networkCost: number;
  totalCost: number;
  carbonCost: number;
}

export type CollectionTaskType = 'daily' | 'gap-fill' | 'monthly-agg';
export type CollectionStatus = 'success' | 'failure' | 'partial';

export interface CollectionRunInput {
  clusterId: number;
  taskType: CollectionTaskType;
  targetDate?: string;
  targetYear?: number;
  targetMonth?: number;
  startedAt: string;
}

export interface CollectionRunUpdate {
  status: CollectionStatus;
  podsCollected?: number;
  errorMessage?: string;
  finishedAt: string;
}

export interface OpenCostCostStoreOptions {
  database: Knex;
}

export class OpenCostCostStore {
  private readonly db: Knex;

  static async create(options: OpenCostCostStoreOptions): Promise<OpenCostCostStore> {
    const store = new OpenCostCostStore(options.database);
    await store.ensureSchema();
    return store;
  }

  private constructor(database: Knex) {
    this.db = database;
  }

  /* ═══════════════════════════════════════════
   *  Schema management
   * ═══════════════════════════════════════════ */

  private async ensureSchema(): Promise<void> {
    const hasMeta = await this.db.schema.hasTable(META_TABLE);
    if (hasMeta) {
      const version = await this.getSchemaVersion();
      if (version >= SCHEMA_VERSION) return;
    }

    const hasDaily = await this.db.schema.hasTable(DAILY_TABLE);
    if (hasDaily) {
      // V1 data exists (or partial migration) → migrate
      await this.migrateV1toV2();
    } else {
      // Fresh install
      await this.createSchemaV2();
    }
  }

  private async getSchemaVersion(): Promise<number> {
    const row = await this.db(META_TABLE).where({ key: 'schema_version' }).first();
    return row ? parseInt(row.value, 10) : 0;
  }

  private async setSchemaVersion(version: number): Promise<void> {
    await this.db.raw(
      `INSERT INTO ${META_TABLE} (key, value) VALUES ('schema_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(version)],
    );
  }

  private async createSchemaV2(): Promise<void> {
    await this.db.schema.createTable(META_TABLE, table => {
      table.string('key', 100).primary();
      table.text('value');
    });

    await this.db.schema.createTable(CLUSTERS_TABLE, table => {
      table.increments('id').primary();
      table.string('name', 100).notNullable().unique();
      table.string('title', 100).notNullable();
      table.timestamp('created_at').defaultTo(this.db.fn.now());
      table.timestamp('updated_at').defaultTo(this.db.fn.now());
    });

    await this.db.schema.createTable(PODS_TABLE, table => {
      table.increments('id').primary();
      table.integer('cluster_id').notNullable().references('id').inTable(CLUSTERS_TABLE);
      table.string('namespace', 253).notNullable();
      table.string('controller_kind', 50);
      table.string('controller', 253);
      table.string('pod', 253).notNullable();
      table.timestamp('created_at').defaultTo(this.db.fn.now());
      table.timestamp('updated_at').defaultTo(this.db.fn.now());
      table.unique(['cluster_id', 'namespace', 'pod']);
      table.index(['cluster_id']);
    });

    await this.db.schema.createTable(DAILY_TABLE, table => {
      table.increments('id').primary();
      table.integer('cluster_id').notNullable().references('id').inTable(CLUSTERS_TABLE);
      table.date('date').notNullable();
      table.integer('pod_id').notNullable().references('id').inTable(PODS_TABLE);
      table.decimal('cpu_cost', 12, 4).defaultTo(0);
      table.decimal('ram_cost', 12, 4).defaultTo(0);
      table.decimal('gpu_cost', 12, 4).defaultTo(0);
      table.decimal('pv_cost', 12, 4).defaultTo(0);
      table.decimal('network_cost', 12, 4).defaultTo(0);
      table.decimal('total_cost', 12, 4).defaultTo(0);
      table.decimal('carbon_cost', 12, 4).defaultTo(0);
      table.timestamp('created_at').defaultTo(this.db.fn.now());
      table.timestamp('updated_at').defaultTo(this.db.fn.now());
      table.unique(['cluster_id', 'date', 'pod_id']);
      table.index(['cluster_id', 'date']);
    });

    await this.db.schema.createTable(MONTHLY_TABLE, table => {
      table.increments('id').primary();
      table.integer('cluster_id').notNullable().references('id').inTable(CLUSTERS_TABLE);
      table.smallint('year').notNullable();
      table.smallint('month').notNullable();
      table.integer('pod_id').notNullable().references('id').inTable(PODS_TABLE);
      table.decimal('cpu_cost', 12, 4).defaultTo(0);
      table.decimal('ram_cost', 12, 4).defaultTo(0);
      table.decimal('gpu_cost', 12, 4).defaultTo(0);
      table.decimal('pv_cost', 12, 4).defaultTo(0);
      table.decimal('network_cost', 12, 4).defaultTo(0);
      table.decimal('total_cost', 12, 4).defaultTo(0);
      table.decimal('carbon_cost', 12, 4).defaultTo(0);
      table.smallint('days_covered').notNullable();
      table.timestamp('created_at').defaultTo(this.db.fn.now());
      table.timestamp('updated_at').defaultTo(this.db.fn.now());
      table.unique(['cluster_id', 'year', 'month', 'pod_id']);
      table.index(['cluster_id', 'year', 'month']);
    });

    await this.db.schema.createTable(RUNS_TABLE, table => {
      table.increments('id').primary();
      table.integer('cluster_id').notNullable().references('id').inTable(CLUSTERS_TABLE);
      table.string('task_type', 20).notNullable();
      table.date('target_date');
      table.smallint('target_year');
      table.smallint('target_month');
      table.string('status', 20).notNullable();
      table.integer('pods_collected').defaultTo(0);
      table.text('error_message');
      table.timestamp('started_at').notNullable();
      table.timestamp('finished_at');
      table.index(['cluster_id']);
      table.index(['task_type', 'status']);
    });

    await this.setSchemaVersion(SCHEMA_VERSION);
  }

  /**
   * Idempotent migration from V1 (flat metadata columns) to V2 (normalised opencost_pods).
   * Each step checks whether it has already been applied so the migration can resume
   * after a partial failure.
   */
  private async migrateV1toV2(): Promise<void> {
    // 1. Meta table
    if (!(await this.db.schema.hasTable(META_TABLE))) {
      await this.db.schema.createTable(META_TABLE, table => {
        table.string('key', 100).primary();
        table.text('value');
      });
    }

    // 2. Timestamps on clusters
    const clusterCols = await this.db(CLUSTERS_TABLE).columnInfo();
    if (!('created_at' in clusterCols)) {
      await this.db.schema.alterTable(CLUSTERS_TABLE, table => {
        table.timestamp('created_at').defaultTo(this.db.fn.now());
        table.timestamp('updated_at').defaultTo(this.db.fn.now());
      });
    }

    // 3. Pods dimension table + populate
    if (!(await this.db.schema.hasTable(PODS_TABLE))) {
      await this.db.schema.createTable(PODS_TABLE, table => {
        table.increments('id').primary();
        table.integer('cluster_id').notNullable().references('id').inTable(CLUSTERS_TABLE);
        table.string('namespace', 253).notNullable();
        table.string('controller_kind', 50);
        table.string('controller', 253);
        table.string('pod', 253).notNullable();
        table.timestamp('created_at').defaultTo(this.db.fn.now());
        table.timestamp('updated_at').defaultTo(this.db.fn.now());
        table.unique(['cluster_id', 'namespace', 'pod']);
        table.index(['cluster_id']);
      });

      // Populate from daily_costs (latest controller info per pod)
      await this.db.raw(`
        INSERT INTO ${PODS_TABLE} (cluster_id, namespace, controller_kind, controller, pod)
        SELECT sub.cluster_id, sub.namespace, sub.controller_kind, sub.controller, sub.pod
        FROM (
          SELECT cluster_id, namespace, controller_kind, controller, pod,
                 ROW_NUMBER() OVER (
                   PARTITION BY cluster_id, namespace, pod
                   ORDER BY date DESC, id DESC
                 ) AS rn
          FROM ${DAILY_TABLE}
        ) sub
        WHERE sub.rn = 1
      `);

      // Populate any additional pods only in monthly_summaries
      await this.db.raw(`
        INSERT INTO ${PODS_TABLE} (cluster_id, namespace, controller_kind, controller, pod)
        SELECT sub.cluster_id, sub.namespace, sub.controller_kind, sub.controller, sub.pod
        FROM (
          SELECT cluster_id, namespace, controller_kind, controller, pod,
                 ROW_NUMBER() OVER (
                   PARTITION BY cluster_id, namespace, pod
                   ORDER BY year DESC, month DESC, id DESC
                 ) AS rn
          FROM ${MONTHLY_TABLE}
        ) sub
        WHERE sub.rn = 1
        AND NOT EXISTS (
          SELECT 1 FROM ${PODS_TABLE} p
          WHERE p.cluster_id = sub.cluster_id
            AND p.namespace = sub.namespace
            AND p.pod = sub.pod
        )
      `);
    }

    // 4. Recreate daily_costs with pod_id (detect old schema by presence of namespace column)
    const dailyCols = await this.db(DAILY_TABLE).columnInfo();
    if ('namespace' in dailyCols) {
      const tmp = `${DAILY_TABLE}_v2`;
      await this.db.schema.dropTableIfExists(tmp);

      await this.db.schema.createTable(tmp, table => {
        table.increments('id').primary();
        table.integer('cluster_id').notNullable().references('id').inTable(CLUSTERS_TABLE);
        table.date('date').notNullable();
        table.integer('pod_id').notNullable().references('id').inTable(PODS_TABLE);
        table.decimal('cpu_cost', 12, 4).defaultTo(0);
        table.decimal('ram_cost', 12, 4).defaultTo(0);
        table.decimal('gpu_cost', 12, 4).defaultTo(0);
        table.decimal('pv_cost', 12, 4).defaultTo(0);
        table.decimal('network_cost', 12, 4).defaultTo(0);
        table.decimal('total_cost', 12, 4).defaultTo(0);
        table.decimal('carbon_cost', 12, 4).defaultTo(0);
        table.timestamp('created_at').defaultTo(this.db.fn.now());
        table.timestamp('updated_at').defaultTo(this.db.fn.now());
        table.unique(['cluster_id', 'date', 'pod_id']);
        table.index(['cluster_id', 'date']);
      });

      await this.db.raw(`
        INSERT INTO ${tmp}
          (cluster_id, date, pod_id,
           cpu_cost, ram_cost, gpu_cost, pv_cost, network_cost, total_cost, carbon_cost,
           created_at, updated_at)
        SELECT
          d.cluster_id, d.date, p.id,
          d.cpu_cost, d.ram_cost, d.gpu_cost, d.pv_cost, d.network_cost, d.total_cost, d.carbon_cost,
          d.collected_at, d.collected_at
        FROM ${DAILY_TABLE} d
        JOIN ${PODS_TABLE} p
          ON p.cluster_id = d.cluster_id
         AND p.namespace  = d.namespace
         AND p.pod        = d.pod
      `);

      await this.db.schema.dropTable(DAILY_TABLE);
      await this.db.schema.renameTable(tmp, DAILY_TABLE);
    }

    // 5. Recreate monthly_summaries with pod_id
    const monthlyCols = await this.db(MONTHLY_TABLE).columnInfo();
    if ('namespace' in monthlyCols) {
      const tmp = `${MONTHLY_TABLE}_v2`;
      await this.db.schema.dropTableIfExists(tmp);

      await this.db.schema.createTable(tmp, table => {
        table.increments('id').primary();
        table.integer('cluster_id').notNullable().references('id').inTable(CLUSTERS_TABLE);
        table.smallint('year').notNullable();
        table.smallint('month').notNullable();
        table.integer('pod_id').notNullable().references('id').inTable(PODS_TABLE);
        table.decimal('cpu_cost', 12, 4).defaultTo(0);
        table.decimal('ram_cost', 12, 4).defaultTo(0);
        table.decimal('gpu_cost', 12, 4).defaultTo(0);
        table.decimal('pv_cost', 12, 4).defaultTo(0);
        table.decimal('network_cost', 12, 4).defaultTo(0);
        table.decimal('total_cost', 12, 4).defaultTo(0);
        table.decimal('carbon_cost', 12, 4).defaultTo(0);
        table.smallint('days_covered').notNullable();
        table.timestamp('created_at').defaultTo(this.db.fn.now());
        table.timestamp('updated_at').defaultTo(this.db.fn.now());
        table.unique(['cluster_id', 'year', 'month', 'pod_id']);
        table.index(['cluster_id', 'year', 'month']);
      });

      await this.db.raw(`
        INSERT INTO ${tmp}
          (cluster_id, year, month, pod_id,
           cpu_cost, ram_cost, gpu_cost, pv_cost, network_cost, total_cost, carbon_cost,
           days_covered, created_at, updated_at)
        SELECT
          m.cluster_id, m.year, m.month, p.id,
          m.cpu_cost, m.ram_cost, m.gpu_cost, m.pv_cost, m.network_cost, m.total_cost, m.carbon_cost,
          m.days_covered, m.created_at, m.created_at
        FROM ${MONTHLY_TABLE} m
        JOIN ${PODS_TABLE} p
          ON p.cluster_id = m.cluster_id
         AND p.namespace  = m.namespace
         AND p.pod        = m.pod
      `);

      await this.db.schema.dropTable(MONTHLY_TABLE);
      await this.db.schema.renameTable(tmp, MONTHLY_TABLE);
    }

    // 6. Collection runs table
    if (!(await this.db.schema.hasTable(RUNS_TABLE))) {
      await this.db.schema.createTable(RUNS_TABLE, table => {
        table.increments('id').primary();
        table.integer('cluster_id').notNullable().references('id').inTable(CLUSTERS_TABLE);
        table.string('task_type', 20).notNullable();
        table.date('target_date');
        table.smallint('target_year');
        table.smallint('target_month');
        table.string('status', 20).notNullable();
        table.integer('pods_collected').defaultTo(0);
        table.text('error_message');
        table.timestamp('started_at').notNullable();
        table.timestamp('finished_at');
        table.index(['cluster_id']);
        table.index(['task_type', 'status']);
      });
    }

    await this.setSchemaVersion(SCHEMA_VERSION);
  }

  /* ═══════════════════════════════════════════
   *  Pod dimension
   * ═══════════════════════════════════════════ */

  async ensurePod(
    clusterId: number,
    namespace: string,
    controllerKind: string | null,
    controller: string | null,
    pod: string,
  ): Promise<number> {
    await this.db.raw(
      `INSERT INTO ${PODS_TABLE} (cluster_id, namespace, controller_kind, controller, pod)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (cluster_id, namespace, pod)
       DO UPDATE SET
         controller_kind = EXCLUDED.controller_kind,
         controller = EXCLUDED.controller,
         updated_at = CURRENT_TIMESTAMP`,
      [clusterId, namespace, controllerKind, controller, pod],
    );

    const row = await this.db(PODS_TABLE)
      .where({ cluster_id: clusterId, namespace, pod })
      .first();
    return row!.id as number;
  }

  /* ═══════════════════════════════════════════
   *  Cluster management
   * ═══════════════════════════════════════════ */

  async ensureCluster(name: string, title: string): Promise<number> {
    const existing = await this.db(CLUSTERS_TABLE).where({ name }).first();
    if (existing) {
      if (existing.title !== title) {
        await this.db(CLUSTERS_TABLE)
          .where({ name })
          .update({ title, updated_at: new Date().toISOString() });
      }
      return existing.id as number;
    }
    const now = new Date().toISOString();
    const [row] = await this.db(CLUSTERS_TABLE)
      .insert({ name, title, created_at: now, updated_at: now })
      .returning('id');
    // SQLite doesn't support returning, so fall back
    if (typeof row === 'number') return row;
    if (typeof row === 'object' && row.id) return row.id as number;
    const inserted = await this.db(CLUSTERS_TABLE).where({ name }).first();
    return inserted!.id as number;
  }

  async getClusterId(name: string): Promise<number | undefined> {
    const row = await this.db(CLUSTERS_TABLE).where({ name }).first();
    return row ? (row.id as number) : undefined;
  }

  /* ═══════════════════════════════════════════
   *  Daily cost operations
   * ═══════════════════════════════════════════ */

  async insertDailyCosts(clusterId: number, date: string, items: DailyCostItem[]): Promise<void> {
    if (items.length === 0) return;

    // Step 1: Batch upsert all unique pods (deduplicate by namespace::pod)
    const uniquePods = new Map<string, DailyCostItem>();
    for (const item of items) {
      uniquePods.set(`${item.namespace}::${item.pod}`, item);
    }

    const newPods = Array.from(uniquePods.values());
    const podBatchSize = 100;
    for (let i = 0; i < newPods.length; i += podBatchSize) {
      const batch = newPods.slice(i, i + podBatchSize);
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const params = batch.flatMap(p => [
        clusterId, p.namespace, p.controllerKind, p.controller, p.pod,
      ]);

      await this.db.raw(
        `INSERT INTO ${PODS_TABLE} (cluster_id, namespace, controller_kind, controller, pod)
         VALUES ${placeholders}
         ON CONFLICT (cluster_id, namespace, pod)
         DO UPDATE SET
           controller_kind = EXCLUDED.controller_kind,
           controller = EXCLUDED.controller,
           updated_at = CURRENT_TIMESTAMP`,
        params,
      );
    }

    // Step 2: Fetch all pod IDs for this cluster (includes newly inserted)
    const allPods = await this.db(PODS_TABLE).where({ cluster_id: clusterId });
    const podCache = new Map<string, number>();
    for (const p of allPods) {
      podCache.set(`${p.namespace}::${p.pod}`, p.id as number);
    }

    // Step 3: Batch insert daily costs
    const now = new Date().toISOString();
    const costBatchSize = 50;
    for (let i = 0; i < items.length; i += costBatchSize) {
      const batch = items.slice(i, i + costBatchSize);
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params = batch.flatMap(item => {
        const podId = podCache.get(`${item.namespace}::${item.pod}`)!;
        return [
          clusterId, date, podId,
          item.cpuCost, item.ramCost, item.gpuCost, item.pvCost, item.networkCost,
          item.totalCost, item.carbonCost, now, now,
        ];
      });

      await this.db.raw(
        `INSERT INTO ${DAILY_TABLE}
          (cluster_id, date, pod_id,
           cpu_cost, ram_cost, gpu_cost, pv_cost, network_cost, total_cost, carbon_cost,
           created_at, updated_at)
         VALUES ${placeholders}
         ON CONFLICT (cluster_id, date, pod_id)
         DO UPDATE SET
           cpu_cost = EXCLUDED.cpu_cost,
           ram_cost = EXCLUDED.ram_cost,
           gpu_cost = EXCLUDED.gpu_cost,
           pv_cost = EXCLUDED.pv_cost,
           network_cost = EXCLUDED.network_cost,
           total_cost = EXCLUDED.total_cost,
           carbon_cost = EXCLUDED.carbon_cost,
           updated_at = EXCLUDED.updated_at`,
        params,
      );
    }
  }

  async getMissingDates(clusterId: number, startDate: string, endDate: string): Promise<string[]> {
    const rows = await this.db(DAILY_TABLE)
      .where({ cluster_id: clusterId })
      .whereBetween('date', [startDate, endDate])
      .distinct('date')
      .orderBy('date');

    const existingDates = new Set(rows.map(r => String(r.date).substring(0, 10)));

    const missing: string[] = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
      const dateStr = current.toISOString().substring(0, 10);
      if (!existingDates.has(dateStr)) {
        missing.push(dateStr);
      }
      current.setDate(current.getDate() + 1);
    }
    return missing;
  }

  /**
   * Get per-day aggregated cost summary for a month.
   * Returns one row per day with totals and pod count.
   */
  async getDailySummary(clusterId: number, year: number, month: number): Promise<DailySummaryRow[]> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const rows = await this.db(DAILY_TABLE)
      .where({ cluster_id: clusterId })
      .where('date', '>=', startDate)
      .where('date', '<', endDate)
      .select('date')
      .count('* as pod_count')
      .sum('cpu_cost as cpu_cost')
      .sum('ram_cost as ram_cost')
      .sum('gpu_cost as gpu_cost')
      .sum('pv_cost as pv_cost')
      .sum('network_cost as network_cost')
      .sum('total_cost as total_cost')
      .sum('carbon_cost as carbon_cost')
      .groupBy('date')
      .orderBy('date', 'asc');

    return rows.map(r => ({
      date: String(r.date).substring(0, 10),
      podCount: Number(r.pod_count),
      cpuCost: Number(r.cpu_cost),
      ramCost: Number(r.ram_cost),
      gpuCost: Number(r.gpu_cost),
      pvCost: Number(r.pv_cost),
      networkCost: Number(r.network_cost),
      totalCost: Number(r.total_cost),
      carbonCost: Number(r.carbon_cost),
    }));
  }

  /**
   * Get all pod costs for a specific date.
   */
  async getPodsForDate(clusterId: number, date: string): Promise<DailyCostItem[]> {
    const rows = await this.db(DAILY_TABLE)
      .join(PODS_TABLE, `${DAILY_TABLE}.pod_id`, '=', `${PODS_TABLE}.id`)
      .where({ [`${DAILY_TABLE}.cluster_id`]: clusterId, [`${DAILY_TABLE}.date`]: date })
      .select(
        `${PODS_TABLE}.namespace`,
        `${PODS_TABLE}.controller_kind`,
        `${PODS_TABLE}.controller`,
        `${PODS_TABLE}.pod`,
        `${DAILY_TABLE}.cpu_cost`,
        `${DAILY_TABLE}.ram_cost`,
        `${DAILY_TABLE}.gpu_cost`,
        `${DAILY_TABLE}.pv_cost`,
        `${DAILY_TABLE}.network_cost`,
        `${DAILY_TABLE}.total_cost`,
        `${DAILY_TABLE}.carbon_cost`,
      )
      .orderBy(`${DAILY_TABLE}.total_cost`, 'desc');

    return rows.map(r => ({
      namespace: r.namespace as string,
      controllerKind: r.controller_kind as string | null,
      controller: r.controller as string | null,
      pod: r.pod as string,
      cpuCost: Number(r.cpu_cost),
      ramCost: Number(r.ram_cost),
      gpuCost: Number(r.gpu_cost),
      pvCost: Number(r.pv_cost),
      networkCost: Number(r.network_cost),
      totalCost: Number(r.total_cost),
      carbonCost: Number(r.carbon_cost),
    }));
  }

  async getDailyCostsForPod(
    clusterId: number,
    pod: string,
    startDate: string,
    endDate: string,
  ): Promise<DailyCostRow[]> {
    const rows = await this.db(DAILY_TABLE)
      .join(PODS_TABLE, `${DAILY_TABLE}.pod_id`, '=', `${PODS_TABLE}.id`)
      .where({ [`${DAILY_TABLE}.cluster_id`]: clusterId, [`${PODS_TABLE}.pod`]: pod })
      .whereBetween(`${DAILY_TABLE}.date`, [startDate, endDate])
      .select(
        `${DAILY_TABLE}.date`,
        `${PODS_TABLE}.namespace`,
        `${PODS_TABLE}.controller_kind`,
        `${PODS_TABLE}.controller`,
        `${PODS_TABLE}.pod`,
        `${DAILY_TABLE}.cpu_cost`,
        `${DAILY_TABLE}.ram_cost`,
        `${DAILY_TABLE}.gpu_cost`,
        `${DAILY_TABLE}.pv_cost`,
        `${DAILY_TABLE}.network_cost`,
        `${DAILY_TABLE}.total_cost`,
        `${DAILY_TABLE}.carbon_cost`,
      )
      .orderBy(`${DAILY_TABLE}.date`, 'asc');

    return rows.map(r => ({
      date: String(r.date).substring(0, 10),
      namespace: r.namespace as string,
      controllerKind: r.controller_kind as string | null,
      controller: r.controller as string | null,
      pod: r.pod as string,
      cpuCost: Number(r.cpu_cost),
      ramCost: Number(r.ram_cost),
      gpuCost: Number(r.gpu_cost),
      pvCost: Number(r.pv_cost),
      networkCost: Number(r.network_cost),
      totalCost: Number(r.total_cost),
      carbonCost: Number(r.carbon_cost),
    }));
  }

  async getDailyCoverage(clusterId: number, year: number, month: number): Promise<number> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const result = await this.db(DAILY_TABLE)
      .where({ cluster_id: clusterId })
      .where('date', '>=', startDate)
      .where('date', '<', endDate)
      .countDistinct('date as count');

    return Number(result[0]?.count ?? 0);
  }

  /* ═══════════════════════════════════════════
   *  Monthly operations
   * ═══════════════════════════════════════════ */

  async getMonthlySummary(clusterId: number, year: number, month: number): Promise<MonthlySummaryRow[]> {
    const rows = await this.db(MONTHLY_TABLE)
      .join(PODS_TABLE, `${MONTHLY_TABLE}.pod_id`, '=', `${PODS_TABLE}.id`)
      .where({ [`${MONTHLY_TABLE}.cluster_id`]: clusterId, year, month })
      .select(
        `${PODS_TABLE}.namespace`,
        `${PODS_TABLE}.controller_kind`,
        `${PODS_TABLE}.controller`,
        `${PODS_TABLE}.pod`,
        `${MONTHLY_TABLE}.cpu_cost`,
        `${MONTHLY_TABLE}.ram_cost`,
        `${MONTHLY_TABLE}.gpu_cost`,
        `${MONTHLY_TABLE}.pv_cost`,
        `${MONTHLY_TABLE}.network_cost`,
        `${MONTHLY_TABLE}.total_cost`,
        `${MONTHLY_TABLE}.carbon_cost`,
        `${MONTHLY_TABLE}.days_covered`,
      )
      .orderBy(`${MONTHLY_TABLE}.total_cost`, 'desc');

    return rows.map(r => ({
      namespace: r.namespace as string,
      controllerKind: r.controller_kind as string | null,
      controller: r.controller as string | null,
      pod: r.pod as string,
      cpuCost: Number(r.cpu_cost),
      ramCost: Number(r.ram_cost),
      gpuCost: Number(r.gpu_cost),
      pvCost: Number(r.pv_cost),
      networkCost: Number(r.network_cost),
      totalCost: Number(r.total_cost),
      carbonCost: Number(r.carbon_cost),
      daysCovered: Number(r.days_covered),
    }));
  }

  async aggregateMonth(clusterId: number, year: number, month: number): Promise<number> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const now = new Date().toISOString();

    // Single INSERT...SELECT replaces N+2 queries (SELECT + countDistinct + N inserts)
    await this.db.raw(
      `INSERT INTO ${MONTHLY_TABLE}
        (cluster_id, year, month, pod_id,
         cpu_cost, ram_cost, gpu_cost, pv_cost, network_cost, total_cost, carbon_cost,
         days_covered, created_at, updated_at)
       SELECT
         ?, ?, ?, pod_id,
         SUM(cpu_cost), SUM(ram_cost), SUM(gpu_cost), SUM(pv_cost),
         SUM(network_cost), SUM(total_cost), SUM(carbon_cost),
         (SELECT COUNT(DISTINCT date) FROM ${DAILY_TABLE}
          WHERE cluster_id = ? AND date >= ? AND date < ?),
         ?, ?
       FROM ${DAILY_TABLE}
       WHERE cluster_id = ? AND date >= ? AND date < ?
       GROUP BY pod_id
       ON CONFLICT (cluster_id, year, month, pod_id)
       DO UPDATE SET
         cpu_cost = EXCLUDED.cpu_cost,
         ram_cost = EXCLUDED.ram_cost,
         gpu_cost = EXCLUDED.gpu_cost,
         pv_cost = EXCLUDED.pv_cost,
         network_cost = EXCLUDED.network_cost,
         total_cost = EXCLUDED.total_cost,
         carbon_cost = EXCLUDED.carbon_cost,
         days_covered = EXCLUDED.days_covered,
         updated_at = EXCLUDED.updated_at`,
      [
        clusterId, year, month,
        clusterId, startDate, endDate,
        now, now,
        clusterId, startDate, endDate,
      ],
    );

    // Return the count of pods aggregated
    const countResult = await this.db(DAILY_TABLE)
      .where({ cluster_id: clusterId })
      .where('date', '>=', startDate)
      .where('date', '<', endDate)
      .countDistinct('pod_id as count');
    return Number(countResult[0]?.count ?? 0);
  }

  /**
   * Aggregate daily costs for a month on-the-fly (without persisting to monthly table).
   * Used when monthly_summaries doesn't have data yet.
   */
  async aggregateMonthOnTheFly(
    clusterId: number,
    year: number,
    month: number,
  ): Promise<{ rows: MonthlySummaryRow[]; daysCovered: number }> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const rows = await this.db(DAILY_TABLE)
      .join(PODS_TABLE, `${DAILY_TABLE}.pod_id`, '=', `${PODS_TABLE}.id`)
      .where({ [`${DAILY_TABLE}.cluster_id`]: clusterId })
      .where(`${DAILY_TABLE}.date`, '>=', startDate)
      .where(`${DAILY_TABLE}.date`, '<', endDate)
      .select(
        `${PODS_TABLE}.namespace`,
        `${PODS_TABLE}.controller_kind`,
        `${PODS_TABLE}.controller`,
        `${PODS_TABLE}.pod`,
      )
      .sum(`${DAILY_TABLE}.cpu_cost as cpu_cost`)
      .sum(`${DAILY_TABLE}.ram_cost as ram_cost`)
      .sum(`${DAILY_TABLE}.gpu_cost as gpu_cost`)
      .sum(`${DAILY_TABLE}.pv_cost as pv_cost`)
      .sum(`${DAILY_TABLE}.network_cost as network_cost`)
      .sum(`${DAILY_TABLE}.total_cost as total_cost`)
      .sum(`${DAILY_TABLE}.carbon_cost as carbon_cost`)
      .groupBy(
        `${DAILY_TABLE}.pod_id`,
        `${PODS_TABLE}.namespace`,
        `${PODS_TABLE}.controller_kind`,
        `${PODS_TABLE}.controller`,
        `${PODS_TABLE}.pod`,
      )
      .orderBy('total_cost', 'desc');

    const daysCoveredResult = await this.db(DAILY_TABLE)
      .where({ cluster_id: clusterId })
      .where('date', '>=', startDate)
      .where('date', '<', endDate)
      .countDistinct('date as count');
    const daysCovered = Number(daysCoveredResult[0]?.count ?? 0);

    return {
      rows: rows.map(r => ({
        namespace: r.namespace as string,
        controllerKind: r.controller_kind as string | null,
        controller: r.controller as string | null,
        pod: r.pod as string,
        cpuCost: Number(r.cpu_cost),
        ramCost: Number(r.ram_cost),
        gpuCost: Number(r.gpu_cost),
        pvCost: Number(r.pv_cost),
        networkCost: Number(r.network_cost),
        totalCost: Number(r.total_cost),
        carbonCost: Number(r.carbon_cost),
        daysCovered,
      })),
      daysCovered,
    };
  }

  /**
   * Get distinct years that have daily cost data for a cluster.
   * Uses min/max date for a portable, efficient query across SQLite and PostgreSQL.
   */
  async getAvailableYears(clusterId: number): Promise<number[]> {
    const result = await this.db(DAILY_TABLE)
      .where({ cluster_id: clusterId })
      .min('date as min_date')
      .max('date as max_date')
      .first();

    if (!result || !result.min_date) return [];

    const minYear = new Date(String(result.min_date)).getFullYear();
    const maxYear = new Date(String(result.max_date)).getFullYear();

    const years: number[] = [];
    for (let y = maxYear; y >= minYear; y--) {
      years.push(y);
    }
    return years;
  }

  /* ═══════════════════════════════════════════
   *  Collection runs
   * ═══════════════════════════════════════════ */

  async insertCollectionRun(run: CollectionRunInput): Promise<number> {
    const data = {
      cluster_id: run.clusterId,
      task_type: run.taskType,
      target_date: run.targetDate ?? null,
      target_year: run.targetYear ?? null,
      target_month: run.targetMonth ?? null,
      status: 'partial' as const,
      pods_collected: 0,
      started_at: run.startedAt,
    };

    const result = await this.db(RUNS_TABLE).insert(data).returning('id');
    if (result.length > 0) {
      const row = result[0];
      if (typeof row === 'number') return row;
      if (typeof row === 'object' && row !== null && 'id' in row) return (row as any).id as number;
    }
    // SQLite fallback
    const [lastRow] = await this.db(RUNS_TABLE).orderBy('id', 'desc').limit(1);
    return lastRow.id as number;
  }

  async updateCollectionRun(id: number, update: CollectionRunUpdate): Promise<void> {
    await this.db(RUNS_TABLE)
      .where({ id })
      .update({
        status: update.status,
        pods_collected: update.podsCollected ?? 0,
        error_message: update.errorMessage ?? null,
        finished_at: update.finishedAt,
      });
  }

  /**
   * Get the latest successful collection run per target_date for a cluster within a date range.
   */
  async getCollectionRuns(
    clusterId: number,
    startDate: string,
    endDate: string,
  ): Promise<Array<{
    targetDate: string;
    taskType: string;
    status: string;
    podsCollected: number;
    startedAt: string;
    finishedAt: string | null;
  }>> {
    const rows = await this.db(RUNS_TABLE)
      .where({ cluster_id: clusterId })
      .whereIn('task_type', ['daily', 'gap-fill'])
      .where('target_date', '>=', startDate)
      .where('target_date', '<', endDate)
      .orderBy('target_date', 'asc')
      .orderBy('id', 'desc');

    // Keep only the latest run per target_date
    const seen = new Set<string>();
    const result: Array<{
      targetDate: string;
      taskType: string;
      status: string;
      podsCollected: number;
      startedAt: string;
      finishedAt: string | null;
    }> = [];

    for (const r of rows) {
      const date = String(r.target_date).substring(0, 10);
      if (seen.has(date)) continue;
      seen.add(date);
      result.push({
        targetDate: date,
        taskType: r.task_type as string,
        status: r.status as string,
        podsCollected: Number(r.pods_collected),
        startedAt: r.started_at as string,
        finishedAt: (r.finished_at as string) ?? null,
      });
    }

    return result;
  }
}
