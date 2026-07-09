import { Knex } from 'knex';
import {
  ConflictSummary,
  FieldConflict,
  OpenSearchConflictSnapshot,
  OpenSearchViewerTarget,
} from './types';

const TABLE_NAME = 'opensearch_viewer_snapshots';

const emptySummary: ConflictSummary = {
  totalFields: 0,
  conflictFields: 0,
  scannedIndices: 0,
  affectedIndices: 0,
  affectedDocuments: 0,
};

interface SnapshotRow {
  target_id: string;
  target_name: string;
  index_pattern: string;
  status: string;
  error_message: string | null;
  scanned_at: string | null;
  last_attempt_at: string | null;
  scan_duration_ms: number | null;
  summary_json: string;
  conflicts_json: string;
  created_at: string;
  updated_at: string;
}

export class OpenSearchConflictStore {
  private constructor(private readonly db: Knex) {}

  static async create(options: { database: Knex }): Promise<OpenSearchConflictStore> {
    const store = new OpenSearchConflictStore(options.database);
    await store.ensureTableExists();
    return store;
  }

  private async ensureTableExists(): Promise<void> {
    const exists = await this.db.schema.hasTable(TABLE_NAME);
    if (exists) {
      const hasScanDuration = await this.db.schema.hasColumn(
        TABLE_NAME,
        'scan_duration_ms',
      );
      if (!hasScanDuration) {
        await this.db.schema.table(TABLE_NAME, table => {
          table.integer('scan_duration_ms');
        });
      }
      return;
    }
    await this.db.schema.createTable(TABLE_NAME, table => {
      table.string('target_id').primary();
      table.string('target_name').notNullable();
      table.text('index_pattern').notNullable();
      table.string('status', 20).notNullable();
      table.text('error_message');
      table.timestamp('scanned_at');
      table.timestamp('last_attempt_at');
      table.integer('scan_duration_ms');
      table.text('summary_json').notNullable();
      table.text('conflicts_json').notNullable();
      table.timestamp('created_at').notNullable();
      table.timestamp('updated_at').notNullable();
    });
  }

  private rowToSnapshot(row: SnapshotRow): OpenSearchConflictSnapshot {
    return {
      target: {
        id: row.target_id,
        name: row.target_name,
        indexPattern: row.index_pattern,
      },
      status: row.status as any,
      errorMessage: row.error_message,
      scannedAt: row.scanned_at,
      lastAttemptAt: row.last_attempt_at,
      scanDurationMs: row.scan_duration_ms ?? null,
      summary: JSON.parse(row.summary_json) as ConflictSummary,
      conflicts: JSON.parse(row.conflicts_json) as FieldConflict[],
    };
  }

  async getSnapshot(targetId: string): Promise<OpenSearchConflictSnapshot | undefined> {
    const row = await this.db<SnapshotRow>(TABLE_NAME)
      .where({ target_id: targetId })
      .first();
    return row ? this.rowToSnapshot(row) : undefined;
  }

  async listSnapshots(): Promise<OpenSearchConflictSnapshot[]> {
    const rows = await this.db<SnapshotRow>(TABLE_NAME).orderBy('target_name', 'asc');
    return rows.map(row => this.rowToSnapshot(row));
  }

  async recordSuccess(snapshot: OpenSearchConflictSnapshot): Promise<void> {
    const now = snapshot.lastAttemptAt ?? new Date().toISOString();
    await this.db(TABLE_NAME)
      .insert({
        target_id: snapshot.target.id,
        target_name: snapshot.target.name,
        index_pattern: snapshot.target.indexPattern,
        status: snapshot.status,
        error_message: null,
        scanned_at: snapshot.scannedAt,
        last_attempt_at: now,
        scan_duration_ms: snapshot.scanDurationMs,
        summary_json: JSON.stringify(snapshot.summary),
        conflicts_json: JSON.stringify(snapshot.conflicts),
        created_at: now,
        updated_at: now,
      })
      .onConflict('target_id')
      .merge({
        target_name: snapshot.target.name,
        index_pattern: snapshot.target.indexPattern,
        status: snapshot.status,
        error_message: null,
        scanned_at: snapshot.scannedAt,
        last_attempt_at: now,
        scan_duration_ms: snapshot.scanDurationMs,
        summary_json: JSON.stringify(snapshot.summary),
        conflicts_json: JSON.stringify(snapshot.conflicts),
        updated_at: now,
      });
  }

  async recordFailure(
    target: OpenSearchViewerTarget,
    error: string,
    scanDurationMs: number,
  ): Promise<OpenSearchConflictSnapshot> {
    const previous = await this.getSnapshot(target.id);
    const now = new Date().toISOString();
    const snapshot: OpenSearchConflictSnapshot = {
      target,
      status: 'failed',
      errorMessage: error,
      scannedAt: previous?.scannedAt ?? null,
      lastAttemptAt: now,
      scanDurationMs,
      summary: previous?.summary ?? emptySummary,
      conflicts: previous?.conflicts ?? [],
    };

    await this.db(TABLE_NAME)
      .insert({
        target_id: target.id,
        target_name: target.name,
        index_pattern: target.indexPattern,
        status: 'failed',
        error_message: error,
        scanned_at: snapshot.scannedAt,
        last_attempt_at: now,
        scan_duration_ms: snapshot.scanDurationMs,
        summary_json: JSON.stringify(snapshot.summary),
        conflicts_json: JSON.stringify(snapshot.conflicts),
        created_at: now,
        updated_at: now,
      })
      .onConflict('target_id')
      .merge({
        target_name: target.name,
        index_pattern: target.indexPattern,
        status: 'failed',
        error_message: error,
        scanned_at: snapshot.scannedAt,
        last_attempt_at: now,
        scan_duration_ms: snapshot.scanDurationMs,
        summary_json: JSON.stringify(snapshot.summary),
        conflicts_json: JSON.stringify(snapshot.conflicts),
        updated_at: now,
      });

    return snapshot;
  }
}
