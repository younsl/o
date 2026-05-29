import { Knex } from 'knex';
import { NotifiedRecord } from './types';

const TABLE_NAME = 'gitlab_token_notified';

export class NotifiedStore {
  private readonly db: Knex;

  static async create(options: { database: Knex }): Promise<NotifiedStore> {
    const store = new NotifiedStore(options.database);
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
        table.string('token_key').notNullable();
        table.integer('threshold').notNullable();
        table.string('expires_at').notNullable();
        table.timestamp('notified_at').notNullable();
        table.string('status').notNullable();
        table.text('error_message');
        table.primary(['token_key', 'threshold', 'expires_at']);
      });
    }
  }

  async hasNotified(
    tokenKey: string,
    threshold: number,
    expiresAt: string,
  ): Promise<boolean> {
    const row = await this.db(TABLE_NAME)
      .where({ token_key: tokenKey, threshold, expires_at: expiresAt, status: 'success' })
      .first();
    return !!row;
  }

  async record(input: {
    tokenKey: string;
    threshold: number;
    expiresAt: string;
    status: 'success' | 'failed';
    errorMessage?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db(TABLE_NAME)
      .insert({
        token_key: input.tokenKey,
        threshold: input.threshold,
        expires_at: input.expiresAt,
        notified_at: now,
        status: input.status,
        error_message: input.errorMessage ?? null,
      })
      .onConflict(['token_key', 'threshold', 'expires_at'])
      .merge({
        notified_at: now,
        status: input.status,
        error_message: input.errorMessage ?? null,
      });
  }

  async listRecent(limit = 100): Promise<NotifiedRecord[]> {
    const rows = await this.db(TABLE_NAME)
      .orderBy('notified_at', 'desc')
      .limit(limit);
    return rows.map(row => ({
      tokenKey: row.token_key as string,
      threshold: row.threshold as number,
      expiresAt: row.expires_at as string,
      notifiedAt: row.notified_at as string,
      status: row.status as 'success' | 'failed',
      errorMessage: (row.error_message as string) ?? null,
    }));
  }
}
