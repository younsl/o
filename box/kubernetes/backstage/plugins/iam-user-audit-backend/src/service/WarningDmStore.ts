import { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import { WarningDmLog } from './types';

const TABLE_NAME = 'warning_dm_logs';

export interface WarningDmStoreOptions {
  database: Knex;
}

export interface RecordDmInput {
  iamUserName: string;
  senderRef: string;
  platform: string;
  status: 'success' | 'failed';
  errorMessage?: string;
}

export class WarningDmStore {
  private readonly db: Knex;

  static async create(
    options: WarningDmStoreOptions,
  ): Promise<WarningDmStore> {
    const store = new WarningDmStore(options.database);
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
        table.string('iam_user_name').notNullable();
        table.string('sender_ref').notNullable();
        table.string('platform').notNullable();
        table.string('status').notNullable();
        table.text('error_message');
        table.timestamp('created_at').notNullable();
      });
    }
  }

  async recordDm(input: RecordDmInput): Promise<WarningDmLog> {
    const now = new Date().toISOString();
    const log: WarningDmLog = {
      id: uuid(),
      iamUserName: input.iamUserName,
      senderRef: input.senderRef,
      platform: input.platform,
      status: input.status,
      errorMessage: input.errorMessage ?? null,
      createdAt: now,
    };

    await this.db(TABLE_NAME).insert({
      id: log.id,
      iam_user_name: log.iamUserName,
      sender_ref: log.senderRef,
      platform: log.platform,
      status: log.status,
      error_message: log.errorMessage,
      created_at: log.createdAt,
    });

    return log;
  }

  async getLastDmByUser(
    userName: string,
  ): Promise<WarningDmLog | undefined> {
    const row = await this.db(TABLE_NAME)
      .where({ iam_user_name: userName })
      .orderBy('created_at', 'desc')
      .first();
    return row ? this.rowToLog(row) : undefined;
  }

  async getLastDmMap(
    userNames: string[],
  ): Promise<Record<string, WarningDmLog | null>> {
    const result: Record<string, WarningDmLog | null> = {};
    for (const name of userNames) {
      result[name] = null;
    }

    if (userNames.length === 0) return result;

    // Subquery: max created_at per user
    const rows = await this.db(TABLE_NAME)
      .whereIn('iam_user_name', userNames)
      .andWhere('created_at', '>=', this.db.raw(
        `(SELECT MAX(created_at) FROM ${TABLE_NAME} AS t2 WHERE t2.iam_user_name = ${TABLE_NAME}.iam_user_name)`,
      ))
      .orderBy('created_at', 'desc');

    // Deduplicate: keep only the first (most recent) per user
    const seen = new Set<string>();
    for (const row of rows) {
      const log = this.rowToLog(row);
      if (!seen.has(log.iamUserName)) {
        result[log.iamUserName] = log;
        seen.add(log.iamUserName);
      }
    }

    return result;
  }

  async hasSuccessToday(userName: string): Promise<boolean> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const row = await this.db(TABLE_NAME)
      .where({ iam_user_name: userName, status: 'success' })
      .andWhere('created_at', '>=', todayStart.toISOString())
      .first();

    return !!row;
  }

  private rowToLog(row: Record<string, unknown>): WarningDmLog {
    return {
      id: row.id as string,
      iamUserName: row.iam_user_name as string,
      senderRef: row.sender_ref as string,
      platform: row.platform as string,
      status: row.status as 'success' | 'failed',
      errorMessage: (row.error_message as string) ?? null,
      createdAt: row.created_at as string,
    };
  }
}
