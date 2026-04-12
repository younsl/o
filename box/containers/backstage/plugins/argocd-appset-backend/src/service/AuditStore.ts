import { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import { AuditLogEntry } from './types';

const TABLE_NAME = 'appset_audit_logs';

export interface AuditStoreOptions {
  database: Knex;
}

export class AuditStore {
  private readonly db: Knex;

  static async create(options: AuditStoreOptions): Promise<AuditStore> {
    const store = new AuditStore(options.database);
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
        table.integer('seq').unsigned().notNullable();
        table.string('action').notNullable();
        table.string('appset_namespace').notNullable();
        table.string('appset_name').notNullable();
        table.string('user_ref').notNullable();
        table.string('old_value');
        table.string('new_value');
        table.timestamp('created_at').notNullable();
      });
    }
  }

  async addEntry(
    entry: Omit<AuditLogEntry, 'id' | 'seq' | 'createdAt'>,
  ): Promise<void> {
    const result = await this.db(TABLE_NAME).max('seq as maxSeq').first();
    const nextSeq = ((result?.maxSeq as number) ?? 0) + 1;

    await this.db(TABLE_NAME).insert({
      id: uuid(),
      seq: nextSeq,
      action: entry.action,
      appset_namespace: entry.appsetNamespace,
      appset_name: entry.appsetName,
      user_ref: entry.userRef,
      old_value: entry.oldValue,
      new_value: entry.newValue,
      created_at: new Date().toISOString(),
    });
  }

  async listEntries(options?: {
    namespace?: string;
    name?: string;
    limit?: number;
  }): Promise<AuditLogEntry[]> {
    let query = this.db(TABLE_NAME).orderBy('created_at', 'desc');

    if (options?.namespace) {
      query = query.where('appset_namespace', options.namespace);
    }
    if (options?.name) {
      query = query.where('appset_name', options.name);
    }
    query = query.limit(options?.limit ?? 50);

    const rows = await query;
    return rows.map(row => this.rowToEntry(row));
  }

  private rowToEntry(row: Record<string, unknown>): AuditLogEntry {
    return {
      id: row.id as string,
      seq: row.seq as number,
      action: row.action as AuditLogEntry['action'],
      appsetNamespace: row.appset_namespace as string,
      appsetName: row.appset_name as string,
      userRef: row.user_ref as string,
      oldValue: (row.old_value as string) ?? null,
      newValue: (row.new_value as string) ?? null,
      createdAt: row.created_at as string,
    };
  }
}
