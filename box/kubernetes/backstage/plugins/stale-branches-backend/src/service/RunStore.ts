import { Knex } from 'knex';
import { randomUUID } from 'crypto';
import {
  RunDetail,
  RunState,
  RunSummary,
  ScannedProject,
  StaleBranch,
} from './types';

const TABLE_NAME = 'stale_branches_runs';

/**
 * Runs kept per schedule. The list page shows a strip of the newest few and the
 * detail page pages through the rest, so older runs are dropped rather than
 * growing the table without bound.
 */
const RUNS_KEPT_PER_SCHEDULE = 100;

interface RunPayload {
  branches: StaleBranch[];
  projects: ScannedProject[];
  unresolvedProjects: string[];
  thresholdDays: number;
}

function toSummary(row: any): RunSummary {
  return {
    id: row.id as string,
    scheduleId: row.schedule_id as string,
    state: row.state as RunState,
    triggeredBy: row.triggered_by as string,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) || null,
    durationMs:
      row.duration_ms === null || row.duration_ms === undefined
        ? null
        : Number(row.duration_ms),
    staleCount: Number(row.stale_count ?? 0),
    totalBranches: Number(row.total_branches ?? 0),
    projectCount: Number(row.project_count ?? 0),
    notifiedCount: Number(row.notified_count ?? 0),
    dryRun: !!row.dry_run,
    error: (row.error as string | null) || null,
  };
}

export class RunStore {
  private readonly db: Knex;

  static async create(options: { database: Knex }): Promise<RunStore> {
    const store = new RunStore(options.database);
    await store.ensureTableExists();
    return store;
  }

  private constructor(database: Knex) {
    this.db = database;
  }

  private async ensureTableExists(): Promise<void> {
    const exists = await this.db.schema.hasTable(TABLE_NAME);
    if (exists) {
      // Dry runs landed after the table did. Everything already recorded was
      // allowed to send, so the existing rows default to false.
      if (!(await this.db.schema.hasColumn(TABLE_NAME, 'dry_run'))) {
        await this.db.schema.alterTable(TABLE_NAME, table => {
          table.boolean('dry_run').notNullable().defaultTo(false);
        });
      }
      return;
    }
    await this.db.schema.createTable(TABLE_NAME, table => {
      table.string('id').primary();
      table.string('schedule_id').notNullable();
      table.string('state').notNullable();
      table.string('triggered_by').notNullable();
      table.timestamp('started_at').notNullable();
      table.timestamp('finished_at').nullable();
      table.integer('duration_ms').nullable();
      table.integer('stale_count').notNullable().defaultTo(0);
      table.integer('total_branches').notNullable().defaultTo(0);
      table.integer('project_count').notNullable().defaultTo(0);
      table.integer('notified_count').notNullable().defaultTo(0);
      table.boolean('dry_run').notNullable().defaultTo(false);
      table.text('error').nullable();
      // The branches a run found, so the detail page shows the result as it
      // was rather than as the newest scan would report it.
      table.text('payload').nullable();
      table.index(['schedule_id', 'started_at'], 'stale_branches_runs_schedule');
    });
  }

  async start(
    scheduleId: string,
    triggeredBy: string,
    dryRun = false,
  ): Promise<RunSummary> {
    const run: RunSummary = {
      id: randomUUID(),
      scheduleId,
      state: 'running',
      triggeredBy,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      staleCount: 0,
      totalBranches: 0,
      projectCount: 0,
      notifiedCount: 0,
      dryRun,
      error: null,
    };
    await this.db(TABLE_NAME).insert({
      id: run.id,
      schedule_id: run.scheduleId,
      state: run.state,
      triggered_by: run.triggeredBy,
      started_at: run.startedAt,
      dry_run: dryRun,
    });
    return run;
  }

  async finish(
    runId: string,
    result: {
      state: RunState;
      staleCount: number;
      totalBranches: number;
      projectCount: number;
      error: string | null;
      payload: RunPayload | null;
    },
  ): Promise<void> {
    const row = await this.db(TABLE_NAME).where('id', runId).first();
    if (!row) return;
    const finishedAt = new Date();
    await this.db(TABLE_NAME)
      .where('id', runId)
      .update({
        state: result.state,
        finished_at: finishedAt.toISOString(),
        duration_ms:
          finishedAt.getTime() - new Date(row.started_at as string).getTime(),
        stale_count: result.staleCount,
        total_branches: result.totalBranches,
        project_count: result.projectCount,
        error: result.error,
        payload: result.payload ? JSON.stringify(result.payload) : null,
      });
    await this.prune(row.schedule_id as string);
  }

  /**
   * Recorded separately, since a send happens after the scan has finished. On a
   * dry run this is the count that would have gone out.
   */
  async recordNotified(runId: string, notifiedCount: number): Promise<void> {
    await this.db(TABLE_NAME)
      .where('id', runId)
      .update({ notified_count: notifiedCount });
  }

  async recent(scheduleId: string, limit: number): Promise<RunSummary[]> {
    const rows = await this.db(TABLE_NAME)
      .where('schedule_id', scheduleId)
      .orderBy('started_at', 'desc')
      .limit(limit);
    return rows.map(toSummary);
  }

  /** Newest run per schedule in one query, for the list page. */
  async recentBySchedule(
    scheduleIds: string[],
    limit: number,
  ): Promise<Map<string, RunSummary[]>> {
    const byId = new Map<string, RunSummary[]>();
    if (scheduleIds.length === 0) return byId;
    for (const id of scheduleIds) {
      byId.set(id, await this.recent(id, limit));
    }
    return byId;
  }

  async get(runId: string): Promise<RunDetail | null> {
    const row = await this.db(TABLE_NAME).where('id', runId).first();
    if (!row) return null;
    let payload: RunPayload | null = null;
    try {
      payload = row.payload ? (JSON.parse(row.payload as string) as RunPayload) : null;
    } catch {
      // A payload written by an older shape is not worth failing the page over.
      payload = null;
    }
    return {
      ...toSummary(row),
      branches: payload?.branches ?? [],
      projects: payload?.projects ?? [],
      unresolvedProjects: payload?.unresolvedProjects ?? [],
      thresholdDays: payload?.thresholdDays ?? 0,
    };
  }

  /** The newest finished run, which is what a schedule's result page opens. */
  async latestFinished(scheduleId: string): Promise<RunDetail | null> {
    const row = await this.db(TABLE_NAME)
      .where('schedule_id', scheduleId)
      .whereNot('state', 'running')
      .orderBy('started_at', 'desc')
      .first();
    return row ? this.get(row.id as string) : null;
  }

  async deleteForSchedule(scheduleId: string): Promise<void> {
    await this.db(TABLE_NAME).where('schedule_id', scheduleId).delete();
  }

  /**
   * Marks runs left behind by a restart as failed.
   *
   * A run only ever leaves the `running` state from the process that started
   * it, so one still marked running at boot is a crash, not work in flight.
   */
  async failOrphans(): Promise<number> {
    return this.db(TABLE_NAME).where('state', 'running').update({
      state: 'failed',
      finished_at: new Date().toISOString(),
      error: 'Backend restarted while the run was in progress',
    });
  }

  private async prune(scheduleId: string): Promise<void> {
    const keep = await this.db(TABLE_NAME)
      .where('schedule_id', scheduleId)
      .orderBy('started_at', 'desc')
      .limit(RUNS_KEPT_PER_SCHEDULE)
      .pluck('id');
    if (keep.length < RUNS_KEPT_PER_SCHEDULE) return;
    await this.db(TABLE_NAME)
      .where('schedule_id', scheduleId)
      .whereNotIn('id', keep)
      .delete();
  }
}
