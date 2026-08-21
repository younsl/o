import { Knex } from 'knex';
import { ForkliftSettings } from './types';

const TABLE_NAME = 'forklift_coverage_settings';

/** The table holds one row. Settings are instance wide, not per user. */
const SINGLETON_ID = 'singleton';

export interface SettingsStoreOptions {
  database: Knex;
}

export class SettingsStore {
  private readonly db: Knex;

  static async create(options: SettingsStoreOptions): Promise<SettingsStore> {
    const store = new SettingsStore(options.database);
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
        table.string('forklift_host').nullable();
        table.text('webhook_url').nullable();
        table.boolean('webhook_enabled').notNullable().defaultTo(false);
        table.boolean('webhook_skip_full_coverage').nullable();
        table.string('scan_cron').nullable();
        table.string('timezone').nullable();
        table.boolean('auto_scan_enabled').nullable();
        table.string('updated_by').nullable();
        table.timestamp('updated_at').nullable();
      });
      return;
    }

    // The schedule and skip columns landed after the first release, so an
    // existing deployment gets them added rather than recreated.
    const added: Array<[string, (t: any) => void]> = [
      ['scan_cron', t => t.string('scan_cron').nullable()],
      ['timezone', t => t.string('timezone').nullable()],
      ['auto_scan_enabled', t => t.boolean('auto_scan_enabled').nullable()],
      [
        'webhook_skip_full_coverage',
        t => t.boolean('webhook_skip_full_coverage').nullable(),
      ],
    ];
    for (const [column, build] of added) {
      if (!(await this.db.schema.hasColumn(TABLE_NAME, column))) {
        await this.db.schema.alterTable(TABLE_NAME, build);
      }
    }
  }

  async read(): Promise<ForkliftSettings | null> {
    const row = await this.db(TABLE_NAME).where('id', SINGLETON_ID).first();
    if (!row) return null;
    return {
      forkliftHost: (row.forklift_host as string | null) || null,
      webhookUrl: (row.webhook_url as string | null) || null,
      webhookEnabled: !!row.webhook_enabled,
      webhookSkipWhenFullCoverage:
        row.webhook_skip_full_coverage === null ||
        row.webhook_skip_full_coverage === undefined
          ? null
          : !!row.webhook_skip_full_coverage,
      scanCron: (row.scan_cron as string | null) || null,
      timezone: (row.timezone as string | null) || null,
      autoScanEnabled:
        row.auto_scan_enabled === null || row.auto_scan_enabled === undefined
          ? null
          : !!row.auto_scan_enabled,
      updatedBy: (row.updated_by as string | null) || null,
      updatedAt: (row.updated_at as string | null) || null,
    };
  }

  async write(
    settings: Omit<ForkliftSettings, 'updatedAt'>,
  ): Promise<ForkliftSettings> {
    const updatedAt = new Date().toISOString();
    const row = {
      id: SINGLETON_ID,
      forklift_host: settings.forkliftHost,
      webhook_url: settings.webhookUrl,
      webhook_enabled: settings.webhookEnabled,
      webhook_skip_full_coverage: settings.webhookSkipWhenFullCoverage,
      scan_cron: settings.scanCron,
      timezone: settings.timezone,
      auto_scan_enabled: settings.autoScanEnabled,
      updated_by: settings.updatedBy,
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

    return { ...settings, updatedAt };
  }
}
