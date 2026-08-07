import fs from 'fs';
import { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import {
  LogExtractRequest,
  RequestStatus,
  CreateLogExtractInput,
} from './types';

const TABLE_NAME = 'log_extract_requests';
export const APPROVAL_TIMEOUT_HOURS = 24;
const APPROVAL_TIMEOUT_MS = APPROVAL_TIMEOUT_HOURS * 60 * 60 * 1000;

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
        table.string('log_type');
        table.string('env').notNullable();
        table.string('date').notNullable();
        table.text('apps').notNullable();
        table.string('start_time').notNullable();
        table.string('end_time').notNullable();
        table.string('requester_ref').notNullable();
        table.text('reason').notNullable();
        table.string('encryption').notNullable().defaultTo('aes256');
        table.string('status').notNullable().defaultTo('pending');
        table.string('reviewer_ref');
        table.text('review_comment');
        table.integer('file_count');
        table.integer('archive_size');
        table.string('archive_path');
        table.string('first_timestamp');
        table.string('last_timestamp');
        table.text('error_message');
        table.text('archive_password');
        table.string('password_revealed_to');
        table.timestamp('password_revealed_at');
        table.timestamp('extraction_started_at');
        table.timestamp('extraction_finished_at');
        table.integer('progress_current');
        table.integer('progress_total');
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

      const hasExtractionStarted = await this.db.schema.hasColumn(
        TABLE_NAME,
        'extraction_started_at',
      );
      if (!hasExtractionStarted) {
        await this.db.schema.alterTable(TABLE_NAME, table => {
          table.timestamp('extraction_started_at');
          table.timestamp('extraction_finished_at');
          table.integer('progress_current');
          table.integer('progress_total');
        });
      }

      const hasArchivePassword = await this.db.schema.hasColumn(
        TABLE_NAME,
        'archive_password',
      );
      if (!hasArchivePassword) {
        await this.db.schema.alterTable(TABLE_NAME, table => {
          table.text('archive_password');
          table.string('password_revealed_to');
          table.timestamp('password_revealed_at');
        });
      }

      const hasEncryption = await this.db.schema.hasColumn(
        TABLE_NAME,
        'encryption',
      );
      if (!hasEncryption) {
        await this.db.schema.alterTable(TABLE_NAME, table => {
          table.string('encryption').notNullable().defaultTo('aes256');
        });
      }

      const hasLogType = await this.db.schema.hasColumn(
        TABLE_NAME,
        'log_type',
      );
      if (!hasLogType) {
        await this.db.schema.alterTable(TABLE_NAME, table => {
          table.string('log_type');
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
      // ec2 app entries normally carry their category (`app/nginx`); an
      // explicit logType is only set by legacy callers using bare app names.
      logType: input.source === 'ec2' ? (input.logType ?? null) : null,
      env: input.env,
      date: input.date,
      apps: input.apps,
      startTime: input.startTime,
      endTime: input.endTime,
      requesterRef,
      reason: input.reason,
      encryption: input.encryption,
      status: 'pending',
      reviewerRef: null,
      reviewComment: null,
      fileCount: null,
      archiveSize: null,
      archivePath: null,
      firstTimestamp: null,
      lastTimestamp: null,
      errorMessage: null,
      downloadable: false,
      passwordAvailable: false,
      passwordRevealedTo: null,
      passwordRevealedAt: null,
      approvalDeadline: new Date(
        new Date(now).getTime() + APPROVAL_TIMEOUT_MS,
      ).toISOString(),
      extractionDurationMs: null,
      progressCurrent: null,
      progressTotal: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db(TABLE_NAME).insert({
      id: request.id,
      source: request.source,
      log_type: request.logType,
      env: request.env,
      date: request.date,
      apps: JSON.stringify(request.apps),
      start_time: request.startTime,
      end_time: request.endTime,
      requester_ref: request.requesterRef,
      reason: request.reason,
      encryption: request.encryption,
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

  /**
   * Oldest approved request, i.e. the head of the extraction queue.
   * 'approved' means approved but not yet extracting; FIFO by approval time
   * (updated_at is stamped when the status changes to 'approved').
   */
  async getOldestApproved(): Promise<LogExtractRequest | undefined> {
    const row = await this.db(TABLE_NAME)
      .where({ status: 'approved' })
      .orderBy('updated_at', 'asc')
      .first();
    return row ? this.rowToRequest(row) : undefined;
  }

  async listPendingExpired(now: Date = new Date()): Promise<LogExtractRequest[]> {
    const cutoff = new Date(now.getTime() - APPROVAL_TIMEOUT_MS).toISOString();
    const rows = await this.db(TABLE_NAME)
      .where({ status: 'pending' })
      .andWhere('created_at', '<', cutoff);
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
      archivePassword?: string;
      progressCurrent?: number;
      progressTotal?: number;
    },
  ): Promise<LogExtractRequest | undefined> {
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = {
      status,
      updated_at: now,
    };

    // Stamp extraction lifecycle timestamps so elapsed time can be derived.
    if (status === 'extracting') {
      updateData.extraction_started_at = now;
      updateData.extraction_finished_at = null;
    }
    if (status === 'completed' || status === 'failed') {
      updateData.extraction_finished_at = now;
    }

    if (updates?.reviewerRef !== undefined) updateData.reviewer_ref = updates.reviewerRef;
    if (updates?.reviewComment !== undefined) updateData.review_comment = updates.reviewComment;
    if (updates?.fileCount !== undefined) updateData.file_count = updates.fileCount;
    if (updates?.archiveSize !== undefined) updateData.archive_size = updates.archiveSize;
    if (updates?.archivePath !== undefined) updateData.archive_path = updates.archivePath;
    if (updates?.firstTimestamp !== undefined) updateData.first_timestamp = updates.firstTimestamp;
    if (updates?.lastTimestamp !== undefined) updateData.last_timestamp = updates.lastTimestamp;
    if (updates?.errorMessage !== undefined) updateData.error_message = updates.errorMessage;
    if (updates?.archivePassword !== undefined) updateData.archive_password = updates.archivePassword;
    if (updates?.progressCurrent !== undefined) updateData.progress_current = updates.progressCurrent;
    if (updates?.progressTotal !== undefined) updateData.progress_total = updates.progressTotal;

    await this.db(TABLE_NAME).where({ id }).update(updateData);

    return this.getRequest(id);
  }

  /**
   * Mark requests stuck in 'extracting' as failed. Extractions run in-memory
   * (fire-and-forget), so they cannot survive a process restart: any row still
   * 'extracting' at startup is an orphan from a crash (e.g. an OOM kill) and
   * would otherwise show as running forever. Returns the number of rows fixed.
   */
  async failInterruptedExtractions(): Promise<number> {
    const now = new Date().toISOString();
    return this.db(TABLE_NAME).where({ status: 'extracting' }).update({
      status: 'failed',
      error_message: 'Extraction interrupted by service restart',
      extraction_finished_at: now,
      updated_at: now,
    });
  }

  /** Update extraction progress counters without touching status/updated_at. */
  async updateProgress(
    id: string,
    current: number,
    total?: number,
  ): Promise<void> {
    const updateData: Record<string, unknown> = { progress_current: current };
    if (total !== undefined) updateData.progress_total = total;
    await this.db(TABLE_NAME).where({ id }).update(updateData);
  }

  /**
   * One-time password reveal (IAM secret key style). Atomically clears the
   * plaintext password while recording who revealed it, so concurrent clicks
   * can never both receive it. Returns null if already revealed (or the
   * request has no password), after which no one (admin included) can
   * recover it.
   */
  async revealPassword(id: string, userRef: string): Promise<string | null> {
    const row = await this.db(TABLE_NAME).where({ id }).first();
    const password = (row?.archive_password as string) ?? null;
    if (!password) return null;

    const affected = await this.db(TABLE_NAME)
      .where({ id })
      .whereNotNull('archive_password')
      .update({
        archive_password: null,
        password_revealed_to: userRef,
        password_revealed_at: new Date().toISOString(),
      });

    // Lost the race against another reveal — do not disclose the password.
    if (affected === 0) return null;

    return password;
  }

  private isDownloadable(row: Record<string, unknown>): boolean {
    if (row.status !== 'completed') return false;
    const archivePath = row.archive_path as string | null;
    if (!archivePath) return false;
    try {
      return fs.existsSync(archivePath);
    } catch {
      return false;
    }
  }

  private rowToRequest(row: Record<string, unknown>): LogExtractRequest {
    let apps: string[];
    try {
      apps = JSON.parse(row.apps as string);
    } catch {
      apps = [];
    }

    const status = row.status as RequestStatus;
    const createdAt = row.created_at as string;
    const approvalDeadline =
      status === 'pending'
        ? new Date(new Date(createdAt).getTime() + APPROVAL_TIMEOUT_MS).toISOString()
        : null;

    const extractionStartedAt = (row.extraction_started_at as string) ?? null;
    const extractionFinishedAt = (row.extraction_finished_at as string) ?? null;
    const extractionDurationMs =
      extractionStartedAt && extractionFinishedAt
        ? new Date(extractionFinishedAt).getTime() -
          new Date(extractionStartedAt).getTime()
        : null;

    return {
      id: row.id as string,
      source: (row.source as LogExtractRequest['source']) ?? 'k8s',
      // Legacy ec2 rows (bare app names, no stored log_type) always
      // extracted the java stream; combo rows carry the category in apps.
      logType:
        (row.log_type as LogExtractRequest['logType']) ??
        (row.source === 'ec2' && apps.every(a => !a.includes('/'))
          ? 'java'
          : null),
      env: row.env as LogExtractRequest['env'],
      date: row.date as string,
      apps,
      startTime: row.start_time as string,
      endTime: row.end_time as string,
      requesterRef: row.requester_ref as string,
      reason: row.reason as string,
      encryption:
        (row.encryption as LogExtractRequest['encryption']) ?? 'aes256',
      status,
      reviewerRef: (row.reviewer_ref as string) ?? null,
      reviewComment: (row.review_comment as string) ?? null,
      fileCount: (row.file_count as number) ?? null,
      archiveSize: (row.archive_size as number) ?? null,
      archivePath: (row.archive_path as string) ?? null,
      firstTimestamp: (row.first_timestamp as string) ?? null,
      lastTimestamp: (row.last_timestamp as string) ?? null,
      errorMessage: (row.error_message as string) ?? null,
      downloadable: this.isDownloadable(row),
      // Plaintext password is intentionally never mapped onto the request
      // object; it is only handed out once via revealPassword().
      passwordAvailable: !!row.archive_password,
      passwordRevealedTo: (row.password_revealed_to as string) ?? null,
      passwordRevealedAt: (row.password_revealed_at as string) ?? null,
      approvalDeadline,
      extractionDurationMs,
      progressCurrent: (row.progress_current as number) ?? null,
      progressTotal: (row.progress_total as number) ?? null,
      createdAt,
      updatedAt: row.updated_at as string,
    };
  }
}
