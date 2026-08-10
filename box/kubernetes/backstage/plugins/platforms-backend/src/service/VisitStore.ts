import { Knex } from 'knex';
import { VisitRow } from './aggregate';
import { toDayKey } from './dayKey';

const TABLE_NAME = 'platform_visits';
const RETENTION_DAYS = 90;
/** Stats only ever look back two weeks, so reading more would be wasted rows. */
const STATS_WINDOW_DAYS = 14;

export interface VisitStoreOptions {
  database: Knex;
  timezone: string;
}

export class VisitStore {
  private readonly db: Knex;
  private readonly timezone: string;

  static async create(options: VisitStoreOptions): Promise<VisitStore> {
    const store = new VisitStore(options.database, options.timezone);
    await store.ensureTableExists();
    return store;
  }

  private constructor(database: Knex, timezone: string) {
    this.db = database;
    this.timezone = timezone;
  }

  private async ensureTableExists(): Promise<void> {
    const exists = await this.db.schema.hasTable(TABLE_NAME);
    if (!exists) {
      await this.db.schema.createTable(TABLE_NAME, table => {
        table.increments('id').primary();
        table.string('platform').notNullable();
        table.string('user_ref').notNullable();
        table.string('day_key', 10).notNullable();
        table.timestamp('visited_at').notNullable();
        table.index(['day_key', 'platform'], 'platform_visits_day_platform_idx');
      });
    }
  }

  async recordVisit(platform: string, userRef: string): Promise<void> {
    const now = new Date();
    await this.db(TABLE_NAME).insert({
      platform,
      user_ref: userRef,
      day_key: toDayKey(now, this.timezone),
      visited_at: now.toISOString(),
    });
  }

  /** Rows covering the window the stats aggregation needs, oldest first. */
  async getRecentVisits(): Promise<VisitRow[]> {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - STATS_WINDOW_DAYS);
    const cutoffKey = toDayKey(cutoff, this.timezone);

    const rows = await this.db(TABLE_NAME)
      .select('platform', 'user_ref', 'day_key')
      .where('day_key', '>=', cutoffKey);

    return rows.map(row => ({
      platform: row.platform as string,
      userRef: row.user_ref as string,
      dayKey: row.day_key as string,
    }));
  }

  /** Drops rows past the retention window. Runs on a schedule, not per request. */
  async purgeExpired(): Promise<number> {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
    return this.db(TABLE_NAME)
      .where('day_key', '<', toDayKey(cutoff, this.timezone))
      .delete();
  }

  /**
   * Drops visits for platforms no longer in the catalog. Without this, removing
   * a platform from app-config leaves its rows behind, and re-adding the same
   * name inside the retention window would resurrect stale counts.
   *
   * An empty list is refused rather than treated as "nothing is known", so a
   * config that failed to load cannot wipe the table.
   */
  async purgeUnknownPlatforms(knownPlatforms: string[]): Promise<number> {
    if (knownPlatforms.length === 0) {
      return 0;
    }
    return this.db(TABLE_NAME).whereNotIn('platform', knownPlatforms).delete();
  }

  todayKey(): string {
    return toDayKey(new Date(), this.timezone);
  }
}
