import { Knex } from 'knex';
import { randomUUID } from 'crypto';

const TABLE_NAME = 'kafka_topic_requests';

export interface TopicRequest {
  id: string;
  cluster: string;
  topicName: string;
  numPartitions: number;
  replicationFactor: number;
  cleanupPolicy: string;
  trafficLevel: string;
  configEntries: Record<string, string>;
  requester: string;
  reviewer: string | null;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'created';
  batchId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreateTopicRequestInput = Omit<TopicRequest, 'id' | 'createdAt' | 'updatedAt'>;

export interface StoreOptions {
  database: Knex;
}

export class TopicRequestStore {
  private readonly db: Knex;

  static async create(options: StoreOptions): Promise<TopicRequestStore> {
    const store = new TopicRequestStore(options.database);
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
        table.string('cluster').notNullable();
        table.string('topic_name').notNullable();
        table.integer('num_partitions').notNullable();
        table.integer('replication_factor').notNullable();
        table.string('cleanup_policy').notNullable();
        table.string('traffic_level').notNullable();
        table.text('config_entries').notNullable(); // JSON string
        table.string('requester').notNullable();
        table.string('reviewer');
        table.text('reason');
        table.string('status').notNullable();
        table.string('batch_id').nullable();
        table.timestamp('created_at').notNullable();
        table.timestamp('updated_at').notNullable();
      });
    } else {
      const hasBatchId = await this.db.schema.hasColumn(TABLE_NAME, 'batch_id');
      if (!hasBatchId) {
        await this.db.schema.alterTable(TABLE_NAME, table => {
          table.string('batch_id').nullable();
        });
      }
    }
  }

  async addRequest(input: CreateTopicRequestInput): Promise<TopicRequest> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.db(TABLE_NAME).insert({
      id,
      cluster: input.cluster,
      topic_name: input.topicName,
      num_partitions: input.numPartitions,
      replication_factor: input.replicationFactor,
      cleanup_policy: input.cleanupPolicy,
      traffic_level: input.trafficLevel,
      config_entries: JSON.stringify(input.configEntries),
      requester: input.requester,
      reviewer: input.reviewer,
      reason: input.reason,
      status: input.status,
      batch_id: input.batchId ?? null,
      created_at: now,
      updated_at: now,
    });

    return {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getRequest(id: string): Promise<TopicRequest | undefined> {
    const row = await this.db(TABLE_NAME).where({ id }).first();
    return row ? this.rowToRequest(row) : undefined;
  }

  async listRequests(): Promise<TopicRequest[]> {
    const rows = await this.db(TABLE_NAME).orderBy('created_at', 'desc');
    return rows.map(row => this.rowToRequest(row));
  }

  async listByBatchId(batchId: string): Promise<TopicRequest[]> {
    const rows = await this.db(TABLE_NAME)
      .where({ batch_id: batchId })
      .orderBy('created_at', 'asc');
    return rows.map(row => this.rowToRequest(row));
  }

  async updateStatus(
    id: string,
    status: TopicRequest['status'],
    updates: { reviewer?: string; reason?: string },
  ): Promise<TopicRequest | undefined> {
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = {
      status,
      updated_at: now,
    };
    if (updates.reviewer !== undefined) updateData.reviewer = updates.reviewer;
    if (updates.reason !== undefined) updateData.reason = updates.reason;

    await this.db(TABLE_NAME).where({ id }).update(updateData);
    return this.getRequest(id);
  }

  private rowToRequest(row: Record<string, unknown>): TopicRequest {
    let configEntries: Record<string, string>;
    try {
      configEntries = JSON.parse(row.config_entries as string);
    } catch {
      configEntries = {};
    }

    return {
      id: row.id as string,
      cluster: row.cluster as string,
      topicName: row.topic_name as string,
      numPartitions: row.num_partitions as number,
      replicationFactor: row.replication_factor as number,
      cleanupPolicy: row.cleanup_policy as string,
      trafficLevel: row.traffic_level as string,
      configEntries,
      requester: row.requester as string,
      reviewer: (row.reviewer as string) ?? null,
      reason: (row.reason as string) ?? null,
      status: row.status as TopicRequest['status'],
      batchId: (row.batch_id as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
