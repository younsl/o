import { Knex } from 'knex';
import { GitlabConnection } from './types';

const TABLE_NAME = 'stale_branches_connection';

/** The table holds one row. The connection is instance wide, not per user. */
const SINGLETON_ID = 'singleton';

export class ConnectionStore {
  private readonly db: Knex;

  static async create(options: { database: Knex }): Promise<ConnectionStore> {
    const store = new ConnectionStore(options.database);
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
      table.text('api_base_url').nullable();
      // Stored as written. Backstage has no secret store a plugin can reach,
      // and the column is never read back out to the browser.
      table.text('gitlab_token').nullable();
      table.string('updated_by').nullable();
      table.timestamp('updated_at').nullable();
    });
  }

  async read(): Promise<GitlabConnection | null> {
    const row = await this.db(TABLE_NAME).where('id', SINGLETON_ID).first();
    if (!row) return null;
    return {
      apiBaseUrl: (row.api_base_url as string | null) || null,
      gitlabToken: (row.gitlab_token as string | null) || null,
      updatedBy: (row.updated_by as string | null) || null,
      updatedAt: (row.updated_at as string | null) || null,
    };
  }

  async write(
    connection: Omit<GitlabConnection, 'updatedAt'>,
  ): Promise<GitlabConnection> {
    const updatedAt = new Date().toISOString();
    const row = {
      id: SINGLETON_ID,
      api_base_url: connection.apiBaseUrl,
      gitlab_token: connection.gitlabToken,
      updated_by: connection.updatedBy,
      updated_at: updatedAt,
    };
    const existing = await this.db(TABLE_NAME)
      .where('id', SINGLETON_ID)
      .first();
    if (existing) {
      await this.db(TABLE_NAME).where('id', SINGLETON_ID).update(row);
    } else {
      await this.db(TABLE_NAME).insert(row);
    }
    return { ...connection, updatedAt };
  }
}
