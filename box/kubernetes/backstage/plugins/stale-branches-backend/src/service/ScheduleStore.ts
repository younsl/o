import { Knex } from 'knex';
import { randomUUID } from 'crypto';
import { BranchSchedule, ScheduleInput } from './types';

const TABLE_NAME = 'stale_branches_schedules';

/** Splits a stored comma separated list, dropping blanks. */
function parseList(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function toSchedule(row: any): BranchSchedule {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) || null,
    projectNames: parseList(row.project_names),
    thresholdDays: Number(row.threshold_days),
    ignoredBranches: parseList(row.ignored_branches),
    ignoreProtected: !!row.ignore_protected,
    webhookUrl: (row.webhook_url as string | null) || null,
    webhookDescription: (row.webhook_description as string | null) || null,
    webhookEnabled: !!row.webhook_enabled,
    cron: row.cron as string,
    timezone: row.timezone as string,
    enabled: !!row.enabled,
    createdBy: (row.created_by as string | null) || null,
    createdAt: row.created_at as string,
    updatedBy: (row.updated_by as string | null) || null,
    updatedAt: row.updated_at as string,
  };
}

export class ScheduleStore {
  private readonly db: Knex;

  static async create(options: { database: Knex }): Promise<ScheduleStore> {
    const store = new ScheduleStore(options.database);
    await store.ensureTableExists();
    return store;
  }

  private constructor(database: Knex) {
    this.db = database;
  }

  private async ensureTableExists(): Promise<void> {
    const exists = await this.db.schema.hasTable(TABLE_NAME);
    if (exists) {
      // The webhook label landed after the table did, so an existing
      // deployment gets the column added rather than the table recreated.
      if (!(await this.db.schema.hasColumn(TABLE_NAME, 'webhook_description'))) {
        await this.db.schema.alterTable(TABLE_NAME, table => {
          table.string('webhook_description').nullable();
        });
      }
      return;
    }
    await this.db.schema.createTable(TABLE_NAME, table => {
      table.string('id').primary();
      table.string('name').notNullable();
      table.text('description').nullable();
      table.text('project_names').nullable();
      table.integer('threshold_days').notNullable();
      table.text('ignored_branches').nullable();
      table.boolean('ignore_protected').notNullable().defaultTo(true);
      table.text('webhook_url').nullable();
      table.string('webhook_description').nullable();
      table.boolean('webhook_enabled').notNullable().defaultTo(false);
      table.string('cron').notNullable();
      table.string('timezone').notNullable();
      table.boolean('enabled').notNullable().defaultTo(true);
      table.string('created_by').nullable();
      table.timestamp('created_at').notNullable();
      table.string('updated_by').nullable();
      table.timestamp('updated_at').notNullable();
    });
  }

  async list(): Promise<BranchSchedule[]> {
    const rows = await this.db(TABLE_NAME).orderBy('created_at', 'asc');
    return rows.map(toSchedule);
  }

  async get(id: string): Promise<BranchSchedule | null> {
    const row = await this.db(TABLE_NAME).where('id', id).first();
    return row ? toSchedule(row) : null;
  }

  /** Names are what a run is recognised by in Slack, so they stay unique. */
  async findByName(name: string): Promise<BranchSchedule | null> {
    const row = await this.db(TABLE_NAME).where('name', name).first();
    return row ? toSchedule(row) : null;
  }

  async create(
    input: ScheduleInput,
    userRef: string | null,
  ): Promise<BranchSchedule> {
    const now = new Date().toISOString();
    const schedule: BranchSchedule = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? null,
      projectNames: input.projectNames,
      thresholdDays: input.thresholdDays,
      ignoredBranches: input.ignoredBranches,
      ignoreProtected: input.ignoreProtected,
      webhookUrl: input.webhookUrl?.trim() || null,
      webhookDescription: input.webhookDescription?.trim() || null,
      webhookEnabled: input.webhookEnabled,
      cron: input.cron,
      timezone: input.timezone,
      enabled: input.enabled,
      createdBy: userRef,
      createdAt: now,
      updatedBy: userRef,
      updatedAt: now,
    };
    await this.db(TABLE_NAME).insert({
      id: schedule.id,
      name: schedule.name,
      description: schedule.description,
      project_names: schedule.projectNames.join(','),
      threshold_days: schedule.thresholdDays,
      ignored_branches: schedule.ignoredBranches.join(','),
      ignore_protected: schedule.ignoreProtected,
      webhook_url: schedule.webhookUrl,
      webhook_description: schedule.webhookDescription,
      webhook_enabled: schedule.webhookEnabled,
      cron: schedule.cron,
      timezone: schedule.timezone,
      enabled: schedule.enabled,
      created_by: schedule.createdBy,
      created_at: schedule.createdAt,
      updated_by: schedule.updatedBy,
      updated_at: schedule.updatedAt,
    });
    return schedule;
  }

  async update(
    id: string,
    input: ScheduleInput,
    userRef: string | null,
  ): Promise<BranchSchedule | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updatedAt = new Date().toISOString();
    // An empty webhook field keeps the stored URL, so saving the rest of the
    // form does not wipe a secret the admin cannot see in full.
    const webhookUrl = input.webhookUrl?.trim() || existing.webhookUrl;
    await this.db(TABLE_NAME).where('id', id).update({
      name: input.name,
      description: input.description ?? null,
      project_names: input.projectNames.join(','),
      threshold_days: input.thresholdDays,
      ignored_branches: input.ignoredBranches.join(','),
      ignore_protected: input.ignoreProtected,
      webhook_url: webhookUrl,
      webhook_description: input.webhookDescription?.trim() || null,
      webhook_enabled: input.webhookEnabled,
      cron: input.cron,
      timezone: input.timezone,
      enabled: input.enabled,
      updated_by: userRef,
      updated_at: updatedAt,
    });
    return {
      ...existing,
      ...input,
      description: input.description ?? null,
      webhookDescription: input.webhookDescription?.trim() || null,
      webhookUrl,
      updatedBy: userRef,
      updatedAt,
    };
  }

  /** Pausing is its own call so the list toggle needs no full form payload. */
  async setEnabled(
    id: string,
    enabled: boolean,
    userRef: string | null,
  ): Promise<BranchSchedule | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updatedAt = new Date().toISOString();
    await this.db(TABLE_NAME)
      .where('id', id)
      .update({ enabled, updated_by: userRef, updated_at: updatedAt });
    return { ...existing, enabled, updatedBy: userRef, updatedAt };
  }

  async delete(id: string): Promise<boolean> {
    const removed = await this.db(TABLE_NAME).where('id', id).delete();
    return removed > 0;
  }
}
