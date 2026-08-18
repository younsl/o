import { Knex } from 'knex';

const TABLE_NAME = 'stale_branches_notified';

/**
 * Remembers which branches have already been reported.
 *
 * The shell job this replaces posted every stale branch on every run, so a
 * branch nobody touched produced the same Slack message daily until it was
 * deleted. The key carries the tip commit timestamp, so a branch that gets a
 * new commit and later goes stale again is reported once more, and one that
 * sits untouched is reported once.
 */
export class NotifiedStore {
  private readonly db: Knex;

  static async create(options: { database: Knex }): Promise<NotifiedStore> {
    const store = new NotifiedStore(options.database);
    await store.ensureTableExists();
    return store;
  }

  private constructor(database: Knex) {
    this.db = database;
  }

  private async ensureTableExists(): Promise<void> {
    const exists = await this.db.schema.hasTable(TABLE_NAME);
    if (exists) {
      // The schedule column landed after the table did. An existing row
      // predates schedules entirely, so it is dropped rather than guessed at:
      // the worst case is one branch reported a second time.
      if (!(await this.db.schema.hasColumn(TABLE_NAME, 'schedule_id'))) {
        await this.db(TABLE_NAME).delete();
        await this.db.schema.alterTable(TABLE_NAME, table => {
          table.string('schedule_id').notNullable().defaultTo('');
        });
      }
      return;
    }
    await this.db.schema.createTable(TABLE_NAME, table => {
      table.increments('id').primary();
      // Two schedules can watch the same project with different thresholds, so
      // a branch reported by one must not silence the other.
      table.string('schedule_id').notNullable();
      table.string('branch_key', 512).notNullable();
      table.string('last_commit_at').notNullable();
      table.timestamp('notified_at').notNullable();
      table.index(
        ['schedule_id', 'branch_key', 'last_commit_at'],
        'stale_branches_notified_key',
      );
    });
  }

  async hasNotified(
    scheduleId: string,
    branchKey: string,
    lastCommitAt: string,
  ): Promise<boolean> {
    const row = await this.db(TABLE_NAME)
      .where('schedule_id', scheduleId)
      .andWhere('branch_key', branchKey)
      .andWhere('last_commit_at', lastCommitAt)
      .first();
    return !!row;
  }

  async record(
    scheduleId: string,
    branchKey: string,
    lastCommitAt: string,
  ): Promise<void> {
    await this.db(TABLE_NAME).insert({
      schedule_id: scheduleId,
      branch_key: branchKey,
      last_commit_at: lastCommitAt,
      notified_at: new Date().toISOString(),
    });
  }

  /** Drops rows older than the cutoff so the table does not grow forever. */
  async prune(olderThanDays: number): Promise<number> {
    const cutoff = new Date(
      Date.now() - olderThanDays * 86_400_000,
    ).toISOString();
    return this.db(TABLE_NAME).where('notified_at', '<', cutoff).delete();
  }

  /**
   * Forgets one schedule's records, so its next send reports the full backlog.
   * Also the cleanup path when a schedule is deleted.
   */
  async clear(scheduleId: string): Promise<void> {
    await this.db(TABLE_NAME).where('schedule_id', scheduleId).delete();
  }
}
