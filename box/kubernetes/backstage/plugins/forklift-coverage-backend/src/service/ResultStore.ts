import { Knex } from 'knex';
import { ExcludedProject, ForkliftProject } from './types';

const TABLE_NAME = 'forklift_coverage_results';

/** One row. The latest completed scan replaces the previous one. */
const SINGLETON_ID = 'latest';

export interface StoredResult {
  projects: ForkliftProject[];
  excludedProjects: ExcludedProject[];
  scannedAt: string;
  durationMs: number | null;
  forkliftHost: string | null;
}

export interface ResultStoreOptions {
  database: Knex;
}

/**
 * Persists the last completed scan so a backend restart does not empty the
 * page. Results only ever change on a scheduled run or a manual scan, so a
 * single JSON blob is enough and keeps the read path to one query.
 */
export class ResultStore {
  private readonly db: Knex;

  static async create(options: ResultStoreOptions): Promise<ResultStore> {
    const store = new ResultStore(options.database);
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
      table.string('id').primary();
      table.text('payload').notNullable();
      table.timestamp('scanned_at').notNullable();
      table.integer('duration_ms').nullable();
    });
  }

  async read(): Promise<StoredResult | null> {
    const row = await this.db(TABLE_NAME).where('id', SINGLETON_ID).first();
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload as string) as StoredResult;
      return {
        projects: payload.projects ?? [],
        excludedProjects: payload.excludedProjects ?? [],
        scannedAt: (row.scanned_at as string) ?? payload.scannedAt,
        durationMs: (row.duration_ms as number | null) ?? null,
        forkliftHost: payload.forkliftHost ?? null,
      };
    } catch {
      // A corrupt row must not stop the plugin from booting; the next scan
      // overwrites it anyway.
      return null;
    }
  }

  async write(result: StoredResult): Promise<void> {
    const row = {
      id: SINGLETON_ID,
      payload: JSON.stringify(result),
      scanned_at: result.scannedAt,
      duration_ms: result.durationMs,
    };
    const existing = await this.db(TABLE_NAME)
      .where('id', SINGLETON_ID)
      .first();
    if (existing) {
      await this.db(TABLE_NAME).where('id', SINGLETON_ID).update(row);
    } else {
      await this.db(TABLE_NAME).insert(row);
    }
  }
}
