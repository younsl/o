import { Knex } from 'knex';
import { v4 as uuid } from 'uuid';

const TABLE_NAME = 'coverage_history';
const RETENTION_DAYS = 90;

export interface CoverageSnapshot {
  id: string;
  total: number;
  registered: number;
  ignored: number;
  percent: number;
  scannedAt: string;
}

export interface CoverageHistoryStoreOptions {
  database: Knex;
}

export class CoverageHistoryStore {
  private readonly db: Knex;

  static async create(options: CoverageHistoryStoreOptions): Promise<CoverageHistoryStore> {
    const store = new CoverageHistoryStore(options.database);
    await store.ensureTableExists();
    return store;
  }

  private constructor(database: Knex) {
    this.db = database;
  }

  private async ensureTableExists(): Promise<void> {
    const exists = await this.db.schema.hasTable(TABLE_NAME);
    if (!exists) {
      await this.db.schema.createTable(TABLE_NAME, table => {
        table.string('id').primary();
        table.integer('total').notNullable();
        table.integer('registered').notNullable();
        table.integer('ignored').notNullable();
        table.integer('percent').notNullable();
        table.timestamp('scanned_at').notNullable();
      });
    }
  }

  async addSnapshot(snapshot: Omit<CoverageSnapshot, 'id' | 'scannedAt'>): Promise<void> {
    await this.db(TABLE_NAME).insert({
      id: uuid(),
      total: snapshot.total,
      registered: snapshot.registered,
      ignored: snapshot.ignored,
      percent: snapshot.percent,
      scanned_at: new Date().toISOString(),
    });

    // Purge rows older than retention period
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    await this.db(TABLE_NAME).where('scanned_at', '<', cutoff.toISOString()).delete();
  }

  async getHistory(days: number = 90): Promise<CoverageSnapshot[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const rows = await this.db(TABLE_NAME)
      .where('scanned_at', '>=', cutoff.toISOString())
      .orderBy('scanned_at', 'asc');

    return rows.map(row => ({
      id: row.id as string,
      total: row.total as number,
      registered: row.registered as number,
      ignored: row.ignored as number,
      percent: row.percent as number,
      scannedAt: row.scanned_at as string,
    }));
  }
}
