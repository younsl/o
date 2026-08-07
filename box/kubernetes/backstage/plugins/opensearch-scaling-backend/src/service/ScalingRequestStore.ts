import { Knex } from 'knex';
import { randomUUID } from 'crypto';

// Normalized schema (lives in this plugin's dedicated database):
//   osc_requests 1──* osc_audit_events  (submit/execute/fail/cancel/complete trail)
const T_REQ = 'osc_requests';
const T_AUDIT = 'osc_audit_events';

export type RequestStatus =
  | 'scheduled'
  | 'validating'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AuditEventType =
  | 'submitted'
  | 'executed'
  | 'failed'
  | 'cancelled'
  | 'completed';

export interface AuditEvent {
  id: string;
  eventType: AuditEventType;
  actor: string;
  note: string | null;
  createdAt: string;
}

/** A snapshot of the domain's cluster config captured at request time. */
export interface DomainSnapshot {
  instanceType: string | null;
  instanceCount: number | null;
  volumeSizeGb: number | null;
}

export interface ScalingRequest {
  id: string;
  domain: string;
  /** Target data-node instance type. */
  instanceType: string;
  /** Target data-node count. */
  instanceCount: number;
  /** Target per-node EBS volume size (GB). */
  volumeSizeGb: number;
  /** Domain config captured when the request was submitted. */
  currentSnapshot: DomainSnapshot | null;
  /** Absolute reserved execution instant (UTC ISO 8601). */
  scheduledAt: string;
  /** IANA timezone the requester picked the time in (for display). */
  timezone: string;
  requester: string;
  reason: string | null;
  status: RequestStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  auditEvents: AuditEvent[];
}

export interface CreateScalingRequestInput {
  domain: string;
  instanceType: string;
  instanceCount: number;
  volumeSizeGb: number;
  currentSnapshot: DomainSnapshot | null;
  scheduledAt: string;
  timezone: string;
  requester: string;
  reason: string | null;
}

export class ScalingRequestStore {
  private constructor(private readonly db: Knex) {}

  static async create(options: {
    database: Knex;
  }): Promise<ScalingRequestStore> {
    const store = new ScalingRequestStore(options.database);
    await store.ensureSchema();
    return store;
  }

  private async ensureSchema(): Promise<void> {
    if (!(await this.db.schema.hasTable(T_REQ))) {
      await this.db.schema.createTable(T_REQ, t => {
        t.string('id').primary();
        t.string('domain').notNullable().index();
        t.string('instance_type').notNullable();
        t.integer('instance_count').notNullable();
        t.integer('volume_size_gb').notNullable();
        t.text('current_snapshot'); // JSON
        t.timestamp('scheduled_at').notNullable();
        t.string('timezone').notNullable();
        t.string('requester').notNullable();
        t.text('reason');
        t.string('status').notNullable().index();
        t.text('error_message');
        t.timestamp('created_at').notNullable();
        t.timestamp('updated_at').notNullable();
      });
    }
    if (!(await this.db.schema.hasTable(T_AUDIT))) {
      await this.db.schema.createTable(T_AUDIT, t => {
        t.string('id').primary();
        t.string('request_id').notNullable().index();
        t.string('event_type').notNullable();
        t.string('actor').notNullable();
        t.text('note');
        t.timestamp('created_at').notNullable();
      });
    }
  }

  async addRequest(input: CreateScalingRequestInput): Promise<ScalingRequest> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.db.transaction(async trx => {
      await trx(T_REQ).insert({
        id,
        domain: input.domain,
        instance_type: input.instanceType,
        instance_count: input.instanceCount,
        volume_size_gb: input.volumeSizeGb,
        current_snapshot: input.currentSnapshot
          ? JSON.stringify(input.currentSnapshot)
          : null,
        scheduled_at: input.scheduledAt,
        timezone: input.timezone,
        requester: input.requester,
        reason: input.reason,
        status: 'scheduled',
        error_message: null,
        created_at: now,
        updated_at: now,
      });
      await this.insertEvent(
        trx,
        id,
        'submitted',
        input.requester,
        input.reason,
      );
    });

    return (await this.getRequest(id))!;
  }

  private async insertEvent(
    trx: Knex,
    requestId: string,
    eventType: AuditEventType,
    actor: string,
    note: string | null,
  ): Promise<void> {
    await trx(T_AUDIT).insert({
      id: randomUUID(),
      request_id: requestId,
      event_type: eventType,
      actor,
      note: note ?? null,
      created_at: new Date().toISOString(),
    });
  }

  async getRequest(id: string): Promise<ScalingRequest | undefined> {
    const row = await this.db(T_REQ).where({ id }).first();
    if (!row) return undefined;
    const events = await this.db(T_AUDIT)
      .where({ request_id: id })
      .orderBy('created_at', 'asc');
    return this.assemble(row, events);
  }

  /** Lists requests, optionally restricted to a single requester (newest first). */
  async listRequests(requester?: string): Promise<ScalingRequest[]> {
    let query = this.db(T_REQ).orderBy('created_at', 'desc');
    if (requester) query = query.where({ requester });
    const rows = await query;
    if (rows.length === 0) return [];
    const ids = rows.map(r => r.id as string);
    const events = await this.db(T_AUDIT)
      .whereIn('request_id', ids)
      .orderBy('created_at', 'asc');
    const eventsMap = new Map<string, any[]>();
    for (const e of events) {
      const arr = eventsMap.get(e.request_id) ?? [];
      arr.push(e);
      eventsMap.set(e.request_id, arr);
    }
    return rows.map(r => this.assemble(r, eventsMap.get(r.id as string) ?? []));
  }

  /** Requests due for execution: scheduled and reserved time has passed. */
  async listDue(nowIso: string): Promise<ScalingRequest[]> {
    const rows = await this.db(T_REQ)
      .where({ status: 'scheduled' })
      .andWhere('scheduled_at', '<=', nowIso)
      .orderBy('scheduled_at', 'asc');
    if (rows.length === 0) return [];
    const ids = rows.map(r => r.id as string);
    const events = await this.db(T_AUDIT).whereIn('request_id', ids);
    const eventsMap = new Map<string, any[]>();
    for (const e of events) {
      const arr = eventsMap.get(e.request_id) ?? [];
      arr.push(e);
      eventsMap.set(e.request_id, arr);
    }
    return rows.map(r => this.assemble(r, eventsMap.get(r.id as string) ?? []));
  }

  /** Requests currently executing (used to poll change-progress to completion). */
  async listInProgress(): Promise<ScalingRequest[]> {
    const rows = await this.db(T_REQ).where({ status: 'in_progress' });
    return Promise.all(rows.map(r => this.getRequest(r.id as string))).then(
      reqs => reqs.filter((r): r is ScalingRequest => Boolean(r)),
    );
  }

  /** True if the domain has a scheduled or in-flight request (duplicate guard). */
  async hasActiveRequest(domain: string): Promise<boolean> {
    const row = await this.db(T_REQ)
      .where({ domain })
      .whereIn('status', ['scheduled', 'validating', 'in_progress'])
      .first();
    return Boolean(row);
  }

  async updateStatus(
    id: string,
    status: RequestStatus,
    opts: {
      errorMessage?: string | null;
      event?: { type: AuditEventType; actor: string; note?: string | null };
    } = {},
  ): Promise<ScalingRequest | undefined> {
    await this.db.transaction(async trx => {
      const update: Record<string, unknown> = {
        status,
        updated_at: new Date().toISOString(),
      };
      if (opts.errorMessage !== undefined) {
        update.error_message = opts.errorMessage;
      }
      await trx(T_REQ).where({ id }).update(update);
      if (opts.event) {
        await this.insertEvent(
          trx,
          id,
          opts.event.type,
          opts.event.actor,
          opts.event.note ?? null,
        );
      }
    });
    return this.getRequest(id);
  }

  private assemble(
    row: Record<string, any>,
    events: Array<Record<string, any>>,
  ): ScalingRequest {
    let snapshot: DomainSnapshot | null = null;
    if (row.current_snapshot) {
      try {
        snapshot = JSON.parse(row.current_snapshot);
      } catch {
        snapshot = null;
      }
    }
    return {
      id: row.id,
      domain: row.domain,
      instanceType: row.instance_type,
      instanceCount: Number(row.instance_count),
      volumeSizeGb: Number(row.volume_size_gb),
      currentSnapshot: snapshot,
      scheduledAt: this.toIso(row.scheduled_at),
      timezone: row.timezone,
      requester: row.requester,
      reason: row.reason ?? null,
      status: row.status,
      errorMessage: row.error_message ?? null,
      createdAt: this.toIso(row.created_at),
      updatedAt: this.toIso(row.updated_at),
      auditEvents: events.map(e => ({
        id: e.id,
        eventType: e.event_type,
        actor: e.actor,
        note: e.note ?? null,
        createdAt: this.toIso(e.created_at),
      })),
    };
  }

  /** SQLite returns timestamps as strings; Postgres returns Date objects. */
  private toIso(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
}
