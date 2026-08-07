import { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import { CoverageSnapshot } from './types';

const TABLE_NAME = 'forklift_coverage_history';
const RETENTION_DAYS = 365;

export interface CoverageHistoryStoreOptions {
  database: Knex;
}

export class CoverageHistoryStore {
  private readonly db: Knex;

  static async create(
    options: CoverageHistoryStoreOptions,
  ): Promise<CoverageHistoryStore> {
    const store = new CoverageHistoryStore(options.database);
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
      table.integer('target').notNullable();
      table.integer('applied').notNullable();
      table.integer('partial').notNullable();
      table.integer('not_applied').notNullable();
      table.integer('skipped').notNullable();
      table.integer('percent').notNullable();
      table.timestamp('scanned_at').notNullable();
      table.index(['scanned_at'], 'forklift_coverage_history_scanned_at_idx');
    });
  }

  async addSnapshot(
    snapshot: Omit<CoverageSnapshot, 'id' | 'scannedAt'>,
  ): Promise<void> {
    await this.db(TABLE_NAME).insert({
      id: uuid(),
      target: snapshot.target,
      applied: snapshot.applied,
      partial: snapshot.partial,
      not_applied: snapshot.notApplied,
      skipped: snapshot.skipped,
      percent: snapshot.percent,
      scanned_at: new Date().toISOString(),
    });

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    await this.db(TABLE_NAME)
      .where('scanned_at', '<', cutoff.toISOString())
      .delete();
  }

  async getHistory(days: number = 90): Promise<CoverageSnapshot[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const rows = await this.db(TABLE_NAME)
      .where('scanned_at', '>=', cutoff.toISOString())
      .orderBy('scanned_at', 'asc');

    return rows.map(row => ({
      id: row.id as string,
      target: row.target as number,
      applied: row.applied as number,
      partial: row.partial as number,
      notApplied: row.not_applied as number,
      skipped: row.skipped as number,
      percent: row.percent as number,
      scannedAt: row.scanned_at as string,
    }));
  }
}
