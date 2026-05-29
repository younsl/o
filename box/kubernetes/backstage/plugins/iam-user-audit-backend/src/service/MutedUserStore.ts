import { Knex } from 'knex';
import { MutedUser } from './types';

const TABLE_NAME = 'muted_iam_users';

export interface MutedUserStoreOptions {
  database: Knex;
}

export interface AddMuteInput {
  iamUserName: string;
  mutedBy: string;
  reason?: string;
}

export class MutedUserStore {
  private readonly db: Knex;

  static async create(options: MutedUserStoreOptions): Promise<MutedUserStore> {
    const store = new MutedUserStore(options.database);
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
        table.string('iam_user_name').primary();
        table.string('muted_by').notNullable();
        table.text('reason');
        table.timestamp('created_at').notNullable();
      });
    }
  }

  async add(input: AddMuteInput): Promise<MutedUser> {
    const now = new Date().toISOString();
    const reason = input.reason?.trim() || null;

    const existing = await this.db(TABLE_NAME)
      .where({ iam_user_name: input.iamUserName })
      .first();

    if (existing) {
      await this.db(TABLE_NAME)
        .where({ iam_user_name: input.iamUserName })
        .update({
          muted_by: input.mutedBy,
          reason,
        });
    } else {
      await this.db(TABLE_NAME).insert({
        iam_user_name: input.iamUserName,
        muted_by: input.mutedBy,
        reason,
        created_at: now,
      });
    }

    return {
      iamUserName: input.iamUserName,
      mutedBy: input.mutedBy,
      reason,
      createdAt: existing ? (existing.created_at as string) : now,
    };
  }

  async remove(userName: string): Promise<boolean> {
    const deleted = await this.db(TABLE_NAME)
      .where({ iam_user_name: userName })
      .del();
    return deleted > 0;
  }

  async list(): Promise<MutedUser[]> {
    const rows = await this.db(TABLE_NAME).orderBy('created_at', 'desc');
    return rows.map(row => this.rowToMutedUser(row));
  }

  async listUserNames(): Promise<Set<string>> {
    const rows = await this.db(TABLE_NAME).select('iam_user_name');
    return new Set(rows.map(r => r.iam_user_name as string));
  }

  async isMuted(userName: string): Promise<boolean> {
    const row = await this.db(TABLE_NAME)
      .where({ iam_user_name: userName })
      .first();
    return !!row;
  }

  private rowToMutedUser(row: Record<string, unknown>): MutedUser {
    return {
      iamUserName: row.iam_user_name as string,
      mutedBy: row.muted_by as string,
      reason: (row.reason as string) ?? null,
      createdAt: row.created_at as string,
    };
  }
}
