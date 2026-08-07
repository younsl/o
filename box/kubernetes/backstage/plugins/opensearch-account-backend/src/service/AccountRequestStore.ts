import { Knex } from 'knex';
import { randomUUID } from 'crypto';

// Normalized schema (lives in this plugin's dedicated database):
//   osa_requests 1──* osa_request_roles      (role_kind: backend|security)
//   osa_requests 1──* osa_request_attributes (key/value)
//   osa_requests 1──* osa_audit_events       (submit/approve/reject/execute trail)
const T_REQ = 'osa_requests';
const T_ROLES = 'osa_request_roles';
const T_ATTRS = 'osa_request_attributes';
const T_AUDIT = 'osa_audit_events';

export type AccountAction = 'create' | 'delete' | 'modify';
export type RequestStatus = 'pending' | 'executed' | 'rejected' | 'failed';
export type AuditEventType =
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'failed';

export interface AuditEvent {
  id: string;
  eventType: AuditEventType;
  actor: string;
  note: string | null;
  createdAt: string;
}

export interface AccountRequest {
  id: string;
  action: AccountAction;
  username: string;
  backendRoles: string[];
  securityRoles: string[];
  attributes: Record<string, string>;
  requester: string;
  /** Requester's justification, required for create. */
  reason: string | null;
  reviewer: string | null;
  reviewerNote: string | null;
  status: RequestStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  auditEvents: AuditEvent[];
}

export interface CreateAccountRequestInput {
  action: AccountAction;
  username: string;
  backendRoles: string[];
  securityRoles: string[];
  attributes: Record<string, string>;
  requester: string;
  reason: string | null;
  status: RequestStatus;
  /** bcrypt hash of the requester-supplied password (create only). Never plaintext. */
  passwordHash: string | null;
}

export class AccountRequestStore {
  private constructor(private readonly db: Knex) {}

  static async create(options: { database: Knex }): Promise<AccountRequestStore> {
    const store = new AccountRequestStore(options.database);
    await store.ensureSchema();
    return store;
  }

  private async ensureSchema(): Promise<void> {
    if (!(await this.db.schema.hasTable(T_REQ))) {
      await this.db.schema.createTable(T_REQ, t => {
        t.string('id').primary();
        t.string('action').notNullable();
        t.string('username').notNullable();
        t.string('requester').notNullable();
        t.text('reason');
        t.text('password_hash');
        t.string('reviewer');
        t.text('reviewer_note');
        t.string('status').notNullable();
        t.text('error_message');
        t.timestamp('created_at').notNullable();
        t.timestamp('updated_at').notNullable();
      });
    }
    if (!(await this.db.schema.hasTable(T_ROLES))) {
      await this.db.schema.createTable(T_ROLES, t => {
        t.increments('id').primary();
        t.string('request_id').notNullable().index();
        t.string('role_kind').notNullable(); // 'backend' | 'security'
        t.string('role_name').notNullable();
      });
    }
    if (!(await this.db.schema.hasTable(T_ATTRS))) {
      await this.db.schema.createTable(T_ATTRS, t => {
        t.increments('id').primary();
        t.string('request_id').notNullable().index();
        t.string('attr_key').notNullable();
        t.text('attr_value').notNullable();
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

  async addRequest(input: CreateAccountRequestInput): Promise<AccountRequest> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.db.transaction(async trx => {
      await trx(T_REQ).insert({
        id,
        action: input.action,
        username: input.username,
        requester: input.requester,
        reason: input.reason,
        password_hash: input.passwordHash,
        reviewer: null,
        reviewer_note: null,
        status: input.status,
        error_message: null,
        created_at: now,
        updated_at: now,
      });
      await this.insertRoles(trx, id, 'backend', input.backendRoles);
      await this.insertRoles(trx, id, 'security', input.securityRoles);
      await this.insertAttributes(trx, id, input.attributes);
      await this.insertEvent(trx, id, 'submitted', input.requester, input.reason);
    });

    return (await this.getRequest(id))!;
  }

  private async insertRoles(
    trx: Knex,
    requestId: string,
    kind: 'backend' | 'security',
    names: string[],
  ): Promise<void> {
    const rows = names
      .filter(Boolean)
      .map(name => ({ request_id: requestId, role_kind: kind, role_name: name }));
    if (rows.length) await trx(T_ROLES).insert(rows);
  }

  private async insertAttributes(
    trx: Knex,
    requestId: string,
    attributes: Record<string, string>,
  ): Promise<void> {
    const rows = Object.entries(attributes ?? {})
      .filter(([k]) => k.trim() !== '')
      .map(([attr_key, attr_value]) => ({
        request_id: requestId,
        attr_key,
        attr_value: String(attr_value),
      }));
    if (rows.length) await trx(T_ATTRS).insert(rows);
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

  /** Append an audit event (e.g. an admin's approval decision) without status change. */
  async addEvent(
    requestId: string,
    type: AuditEventType,
    actor: string,
    note: string | null = null,
  ): Promise<void> {
    await this.insertEvent(this.db, requestId, type, actor, note);
  }

  async getPasswordHash(id: string): Promise<string | null> {
    const row = await this.db(T_REQ).where({ id }).first();
    return (row?.password_hash as string) ?? null;
  }

  async getRequest(id: string): Promise<AccountRequest | undefined> {
    const row = await this.db(T_REQ).where({ id }).first();
    if (!row) return undefined;
    const [roles, attrs, events] = await Promise.all([
      this.db(T_ROLES).where({ request_id: id }),
      this.db(T_ATTRS).where({ request_id: id }),
      this.db(T_AUDIT).where({ request_id: id }).orderBy('created_at', 'asc'),
    ]);
    return this.assemble(row, roles, attrs, events);
  }

  /** Lists requests, optionally restricted to a single requester. */
  async listRequests(requester?: string): Promise<AccountRequest[]> {
    let query = this.db(T_REQ).orderBy('created_at', 'desc');
    if (requester) query = query.where({ requester });
    const rows = await query;
    if (rows.length === 0) return [];
    const ids = rows.map(r => r.id as string);
    const [roles, attrs, events] = await Promise.all([
      this.db(T_ROLES).whereIn('request_id', ids),
      this.db(T_ATTRS).whereIn('request_id', ids),
      this.db(T_AUDIT).whereIn('request_id', ids).orderBy('created_at', 'asc'),
    ]);
    const byReq = <T extends { request_id: string }>(arr: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of arr) {
        (m.get(x.request_id) ?? m.set(x.request_id, []).get(x.request_id)!).push(x);
      }
      return m;
    };
    const rolesMap = byReq(roles as any[]);
    const attrsMap = byReq(attrs as any[]);
    const eventsMap = byReq(events as any[]);
    return rows.map(r =>
      this.assemble(
        r,
        rolesMap.get(r.id as string) ?? [],
        attrsMap.get(r.id as string) ?? [],
        eventsMap.get(r.id as string) ?? [],
      ),
    );
  }

  async updateStatus(
    id: string,
    status: RequestStatus,
    opts: {
      reviewer?: string;
      reviewerNote?: string;
      errorMessage?: string | null;
      event?: { type: AuditEventType; actor: string; note?: string | null };
    },
  ): Promise<AccountRequest | undefined> {
    await this.db.transaction(async trx => {
      const update: Record<string, unknown> = {
        status,
        updated_at: new Date().toISOString(),
      };
      if (opts.reviewer !== undefined) update.reviewer = opts.reviewer;
      if (opts.reviewerNote !== undefined) update.reviewer_note = opts.reviewerNote;
      if (opts.errorMessage !== undefined) update.error_message = opts.errorMessage;
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
    roles: Array<Record<string, any>>,
    attrs: Array<Record<string, any>>,
    events: Array<Record<string, any>>,
  ): AccountRequest {
    const attributes: Record<string, string> = {};
    for (const a of attrs) attributes[a.attr_key] = a.attr_value;
    return {
      id: row.id,
      action: row.action,
      username: row.username,
      backendRoles: roles.filter(r => r.role_kind === 'backend').map(r => r.role_name),
      securityRoles: roles.filter(r => r.role_kind === 'security').map(r => r.role_name),
      attributes,
      requester: row.requester,
      reason: row.reason ?? null,
      reviewer: row.reviewer ?? null,
      reviewerNote: row.reviewer_note ?? null,
      status: row.status,
      errorMessage: row.error_message ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      auditEvents: events.map(e => ({
        id: e.id,
        eventType: e.event_type,
        actor: e.actor,
        note: e.note ?? null,
        createdAt: e.created_at,
      })),
    };
  }
}
