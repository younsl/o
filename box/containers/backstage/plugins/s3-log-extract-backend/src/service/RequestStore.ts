import { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import {
  LogExtractRequest,
  RequestStatus,
  CreateLogExtractInput,
} from './types';

const TABLE_NAME = 'log_extract_requests';

export interface RequestStoreOptions {
  database: Knex;
}

export class RequestStore {
  private readonly db: Knex;

  static async create(options: RequestStoreOptions): Promise<RequestStore> {
    const store = new RequestStore(options.database);
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
        table.string('source').notNullable().defaultTo('k8s');
        table.string('env').notNullable();
        table.string('date').notNullable();
        table.text('apps').notNullable();
        table.string('start_time').notNullable();
        table.string('end_time').notNullable();
        table.string('requester_ref').notNullable();
        table.text('reason').notNullable();
        table.string('status').notNullable().defaultTo('pending');
        table.string('reviewer_ref');
        table.text('review_comment');
        table.integer('file_count');
        table.integer('archive_size');
        table.string('archive_path');
        table.string('first_timestamp');
        table.string('last_timestamp');
        table.text('error_message');
        table.timestamp('created_at').notNullable();
        table.timestamp('updated_at').notNullable();
      });
    } else {
      // Migrate: add columns for existing databases
      const hasFirstTs = await this.db.schema.hasColumn(TABLE_NAME, 'first_timestamp');
      if (!hasFirstTs) {
        await this.db.schema.alterTable(TABLE_NAME, table => {
          table.string('first_timestamp');
          table.string('last_timestamp');
        });
      }
    }
  }

  async createRequest(
    input: CreateLogExtractInput,
    requesterRef: string,
  ): Promise<LogExtractRequest> {
    const now = new Date().toISOString();
    const request: LogExtractRequest = {
      id: uuid(),
      source: input.source,
      env: input.env,
      date: input.date,
      apps: input.apps,
      startTime: input.startTime,
      endTime: input.endTime,
      requesterRef,
      reason: input.reason,
      status: 'pending',
      reviewerRef: null,
      reviewComment: null,
      fileCount: null,
      archiveSize: null,
      archivePath: null,
      firstTimestamp: null,
      lastTimestamp: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db(TABLE_NAME).insert({
      id: request.id,
      source: request.source,
      env: request.env,
      date: request.date,
      apps: JSON.stringify(request.apps),
      start_time: request.startTime,
      end_time: request.endTime,
      requester_ref: request.requesterRef,
      reason: request.reason,
      status: request.status,
      reviewer_ref: request.reviewerRef,
      review_comment: request.reviewComment,
      file_count: request.fileCount,
      archive_size: request.archiveSize,
      archive_path: request.archivePath,
      first_timestamp: request.firstTimestamp,
      last_timestamp: request.lastTimestamp,
      error_message: request.errorMessage,
      created_at: request.createdAt,
      updated_at: request.updatedAt,
    });

    return request;
  }

  async getRequest(id: string): Promise<LogExtractRequest | undefined> {
    const row = await this.db(TABLE_NAME).where({ id }).first();
    return row ? this.rowToRequest(row) : undefined;
  }

  async listRequests(): Promise<LogExtractRequest[]> {
    const rows = await this.db(TABLE_NAME).orderBy('created_at', 'desc');
    return rows.map(row => this.rowToRequest(row));
  }

  async updateStatus(
    id: string,
    status: RequestStatus,
    updates?: {
      reviewerRef?: string;
      reviewComment?: string;
      fileCount?: number;
      archiveSize?: number;
      archivePath?: string;
      firstTimestamp?: string;
      lastTimestamp?: string;
      errorMessage?: string;
    },
  ): Promise<LogExtractRequest | undefined> {
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = {
      status,
      updated_at: now,
    };

    if (updates?.reviewerRef !== undefined) updateData.reviewer_ref = updates.reviewerRef;
    if (updates?.reviewComment !== undefined) updateData.review_comment = updates.reviewComment;
    if (updates?.fileCount !== undefined) updateData.file_count = updates.fileCount;
    if (updates?.archiveSize !== undefined) updateData.archive_size = updates.archiveSize;
    if (updates?.archivePath !== undefined) updateData.archive_path = updates.archivePath;
    if (updates?.firstTimestamp !== undefined) updateData.first_timestamp = updates.firstTimestamp;
    if (updates?.lastTimestamp !== undefined) updateData.last_timestamp = updates.lastTimestamp;
    if (updates?.errorMessage !== undefined) updateData.error_message = updates.errorMessage;

    await this.db(TABLE_NAME).where({ id }).update(updateData);

    return this.getRequest(id);
  }

  private rowToRequest(row: Record<string, unknown>): LogExtractRequest {
    let apps: string[];
    try {
      apps = JSON.parse(row.apps as string);
    } catch {
      apps = [];
    }

    return {
      id: row.id as string,
      source: (row.source as LogExtractRequest['source']) ?? 'k8s',
      env: row.env as LogExtractRequest['env'],
      date: row.date as string,
      apps,
      startTime: row.start_time as string,
      endTime: row.end_time as string,
      requesterRef: row.requester_ref as string,
      reason: row.reason as string,
      status: row.status as RequestStatus,
      reviewerRef: (row.reviewer_ref as string) ?? null,
      reviewComment: (row.review_comment as string) ?? null,
      fileCount: (row.file_count as number) ?? null,
      archiveSize: (row.archive_size as number) ?? null,
      archivePath: (row.archive_path as string) ?? null,
      firstTimestamp: (row.first_timestamp as string) ?? null,
      lastTimestamp: (row.last_timestamp as string) ?? null,
      errorMessage: (row.error_message as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
