import { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import {
  PasswordResetRequest,
  PasswordResetStatus,
  CreatePasswordResetInput,
} from './types';

const TABLE_NAME = 'password_reset_requests';

export interface PasswordResetStoreOptions {
  database: Knex;
}

export class PasswordResetStore {
  private readonly db: Knex;

  static async create(
    options: PasswordResetStoreOptions,
  ): Promise<PasswordResetStore> {
    const store = new PasswordResetStore(options.database);
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
        table.string('iam_user_arn').notNullable();
        table.string('requester_ref').notNullable();
        table.string('requester_email');
        table.text('reason').notNullable();
        table.string('status').notNullable().defaultTo('pending');
        table.string('reviewer_ref');
        table.text('review_comment');
        table.timestamp('created_at').notNullable();
        table.timestamp('updated_at').notNullable();
      });
    } else {
      const hasEmail = await this.db.schema.hasColumn(TABLE_NAME, 'requester_email');
      if (!hasEmail) {
        await this.db.schema.alterTable(TABLE_NAME, table => {
          table.string('requester_email');
        });
      }
    }
  }

  async createRequest(
    input: CreatePasswordResetInput,
    requesterRef: string,
  ): Promise<PasswordResetRequest> {
    const now = new Date().toISOString();
    const request: PasswordResetRequest = {
      id: uuid(),
      iamUserName: input.iamUserName,
      iamUserArn: input.iamUserArn,
      requesterRef,
      requesterEmail: input.requesterEmail ?? null,
      reason: input.reason,
      status: 'pending',
      reviewerRef: null,
      reviewComment: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db(TABLE_NAME).insert({
      id: request.id,
      iam_user_name: request.iamUserName,
      iam_user_arn: request.iamUserArn,
      requester_ref: request.requesterRef,
      requester_email: request.requesterEmail,
      reason: request.reason,
      status: request.status,
      reviewer_ref: request.reviewerRef,
      review_comment: request.reviewComment,
      created_at: request.createdAt,
      updated_at: request.updatedAt,
    });

    return request;
  }

  async getRequest(id: string): Promise<PasswordResetRequest | undefined> {
    const row = await this.db(TABLE_NAME).where({ id }).first();
    return row ? this.rowToRequest(row) : undefined;
  }

  async listRequests(): Promise<PasswordResetRequest[]> {
    const rows = await this.db(TABLE_NAME).orderBy('created_at', 'desc');
    return rows.map(row => this.rowToRequest(row));
  }

  async updateStatus(
    id: string,
    status: PasswordResetStatus,
    reviewerRef: string,
    reviewComment?: string,
  ): Promise<PasswordResetRequest | undefined> {
    const now = new Date().toISOString();
    await this.db(TABLE_NAME).where({ id }).update({
      status,
      reviewer_ref: reviewerRef,
      review_comment: reviewComment ?? null,
      updated_at: now,
    });

    return this.getRequest(id);
  }

  private rowToRequest(row: Record<string, unknown>): PasswordResetRequest {
    return {
      id: row.id as string,
      iamUserName: row.iam_user_name as string,
      iamUserArn: row.iam_user_arn as string,
      requesterRef: row.requester_ref as string,
      requesterEmail: (row.requester_email as string) ?? null,
      reason: row.reason as string,
      status: row.status as PasswordResetStatus,
      reviewerRef: (row.reviewer_ref as string) ?? null,
      reviewComment: (row.review_comment as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
