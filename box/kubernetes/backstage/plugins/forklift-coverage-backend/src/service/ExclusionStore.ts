import { Knex } from 'knex';

const TABLE_NAME = 'forklift_coverage_exclusions';

export interface ManualExclusion {
  projectPath: string;
  excludedBy: string | null;
  excludedAt: string;
}

export interface ExclusionStoreOptions {
  database: Knex;
}

/**
 * Per project opt-outs toggled in the UI.
 *
 * Kept separate from the app-config exclude list and the GitLab topic so the
 * three sources stay independent: config is owned by the deployment, the topic
 * by the repository, and this table by whoever runs the page.
 */
export class ExclusionStore {
  private readonly db: Knex;

  static async create(options: ExclusionStoreOptions): Promise<ExclusionStore> {
    const store = new ExclusionStore(options.database);
    await store.ensureTableExists();
    return store;
  }

  private constructor(database: Knex) {
    this.db = database;
  }

  private async ensureTableExists(): Promise<void> {
    const exists = await this.db.schema.hasTable(TABLE_NAME);
    if (exists) return;
    await this.db.schema.createTable(TABLE_NAME, table => {
      table.string('project_path').primary();
      table.string('excluded_by').nullable();
      table.timestamp('excluded_at').notNullable();
    });
  }

  async list(): Promise<ManualExclusion[]> {
    const rows = await this.db(TABLE_NAME).orderBy('project_path', 'asc');
    return rows.map(row => ({
      projectPath: row.project_path as string,
      excludedBy: (row.excluded_by as string | null) || null,
      excludedAt: row.excluded_at as string,
    }));
  }

  async add(projectPath: string, excludedBy: string | null): Promise<void> {
    const existing = await this.db(TABLE_NAME)
      .where('project_path', projectPath)
      .first();
    if (existing) return;
    await this.db(TABLE_NAME).insert({
      project_path: projectPath,
      excluded_by: excludedBy,
      excluded_at: new Date().toISOString(),
    });
  }

  async remove(projectPath: string): Promise<void> {
    await this.db(TABLE_NAME).where('project_path', projectPath).delete();
  }
}
