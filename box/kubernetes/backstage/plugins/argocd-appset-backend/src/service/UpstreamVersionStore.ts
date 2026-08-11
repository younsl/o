import { Knex } from 'knex';
import { UpstreamChart } from './UpstreamChartStore';

const TABLE_NAME = 'appset_upstream_versions';

/** A repository URL plus a chart name, well short of any index limit. */
const KEY_LENGTH = 600;

export interface UpstreamVersionStoreOptions {
  database: Knex;
}

/**
 * Normalizes whatever the driver hands back for a timestamp column. Postgres
 * returns a Date, SQLite the string it was given, and either can return an
 * epoch in milliseconds depending on how the value was written. The UI turns
 * this into "checked 4 minutes ago", so it has to be an ISO stamp whichever
 * database is behind it.
 */
export function toIsoStamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();

  const text = String(value ?? '');
  if (/^\d+$/.test(text)) return new Date(Number(text)).toISOString();

  return text;
}

/**
 * Durable record of what each upstream repository last reported.
 *
 * The lookup itself is cached in memory, which is enough to avoid refetching but
 * not to survive a restart or to reach a second reader: one person pressing the
 * scan button filled only their own browser. Persisting the result means the
 * page shows what is upgradable to everyone on load, without anyone pressing
 * anything, and that a restarted backend still knows.
 */
export class UpstreamVersionStore {
  private readonly db: Knex;

  static async create(
    options: UpstreamVersionStoreOptions,
  ): Promise<UpstreamVersionStore> {
    const store = new UpstreamVersionStore(options.database);
    await store.ensureTableExists();
    return store;
  }

  private constructor(database: Knex) {
    this.db = database;
  }

  private async ensureTableExists(): Promise<void> {
    const exists = await this.db.schema.hasTable(TABLE_NAME);
    if (exists) return;

    await this.db.schema.createTable(TABLE_NAME, table => {
      // `repository|chart`, so a chart name in two repositories stays distinct.
      table.string('id', KEY_LENGTH).primary();
      table.text('repository').notNullable();
      table.string('chart').notNullable();
      table.string('latest_version');
      table.string('latest_app_version');
      table.integer('version_count').notNullable().defaultTo(0);
      table.string('source').notNullable();
      table.text('unavailable_reason');
      table.timestamp('checked_at').notNullable();
    });
  }

  static keyOf(repository: string, chart: string): string {
    return `${repository}|${chart}`;
  }

  /** Replaces the row for that chart, since only the newest read matters. */
  async save(chart: UpstreamChart): Promise<void> {
    const row = {
      id: UpstreamVersionStore.keyOf(chart.repository, chart.chart),
      repository: chart.repository,
      chart: chart.chart,
      latest_version: chart.latestVersion,
      latest_app_version: chart.latestAppVersion,
      version_count: chart.versionCount,
      source: chart.source,
      unavailable_reason: chart.unavailableReason,
      checked_at: chart.checkedAt,
    };

    await this.db(TABLE_NAME).insert(row).onConflict('id').merge();
  }

  /**
   * Newest `checkedAt` on record, which is when the last scan finished. Used to
   * hold the cooldown across a backend restart, when the in-memory scan state is
   * gone but the reason for the cooldown is not.
   */
  async lastCheckedAt(): Promise<string | null> {
    const row = await this.db(TABLE_NAME).max('checked_at as latest').first();
    return row?.latest ? toIsoStamp(row.latest) : null;
  }

  async listAll(): Promise<UpstreamChart[]> {
    const rows = await this.db(TABLE_NAME).select('*');
    return rows.map(row => this.rowToChart(row));
  }

  private rowToChart(row: Record<string, unknown>): UpstreamChart {
    return {
      repository: row.repository as string,
      chart: row.chart as string,
      latestVersion: (row.latest_version as string) ?? null,
      latestAppVersion: (row.latest_app_version as string) ?? null,
      versionCount: Number(row.version_count ?? 0),
      source: row.source as UpstreamChart['source'],
      unavailableReason: (row.unavailable_reason as string) ?? null,
      checkedAt: toIsoStamp(row.checked_at),
    };
  }
}
