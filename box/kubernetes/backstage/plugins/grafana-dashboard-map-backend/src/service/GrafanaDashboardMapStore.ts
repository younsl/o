import { Knex } from 'knex';
import {
  Architecture,
  ArchitectureEdge,
  ArchitectureNode,
  DashboardAssignment,
  DashboardTier,
  Diagram,
  NodeType,
} from './types';

const DIAGRAMS = 'grafana_dashboard_map_diagrams';
const ASSIGNMENTS = 'grafana_dashboard_map_assignments';
const NODES = 'grafana_dashboard_map_nodes';
const EDGES = 'grafana_dashboard_map_edges';
const CLICKS = 'grafana_dashboard_map_clicks';

const DEFAULT_DIAGRAM_ID = 'default';
const DEFAULT_DIAGRAM_NAME = 'Default';

export interface GrafanaDashboardMapStoreOptions {
  database: Knex;
}

export class GrafanaDashboardMapStore {
  private readonly db: Knex;

  static async create(
    options: GrafanaDashboardMapStoreOptions,
  ): Promise<GrafanaDashboardMapStore> {
    const store = new GrafanaDashboardMapStore(options.database);
    await store.ensureSchema();
    return store;
  }

  private constructor(database: Knex) {
    this.db = database;
  }

  private async ensureSchema(): Promise<void> {
    const now = new Date().toISOString();

    // diagrams table — created first because nodes/edges reference it.
    const hasDiagrams = await this.db.schema.hasTable(DIAGRAMS);
    if (!hasDiagrams) {
      await this.db.schema.createTable(DIAGRAMS, t => {
        t.string('id').primary();
        t.string('name').notNullable();
        t.text('description');
        t.integer('position').notNullable().defaultTo(0);
        t.string('created_by');
        t.timestamp('created_at').notNullable();
        t.string('updated_by');
        t.timestamp('updated_at').notNullable();
      });
    }

    // assignments table — recreated below if its primary key still uses
    // the legacy single-column form (dashboard_uid only).
    const hasAssignments = await this.db.schema.hasTable(ASSIGNMENTS);
    if (!hasAssignments) {
      await this.db.schema.createTable(ASSIGNMENTS, t => {
        t.string('dashboard_uid').notNullable();
        t.string('node_id').notNullable();
        t.integer('position').notNullable().defaultTo(0);
        t.string('tier');
        t.string('updated_by');
        t.timestamp('updated_at').notNullable();
        t.primary(['dashboard_uid', 'node_id']);
        t.index(['node_id']);
      });
    } else {
      const hasTier = await this.db.schema.hasColumn(ASSIGNMENTS, 'tier');
      if (!hasTier) {
        await this.db.schema.alterTable(ASSIGNMENTS, t => t.string('tier'));
      }
      // Migrate legacy column name component_id -> node_id.
      const hasComponentId = await this.db.schema.hasColumn(
        ASSIGNMENTS,
        'component_id',
      );
      const hasNodeId = await this.db.schema.hasColumn(ASSIGNMENTS, 'node_id');
      if (hasComponentId && !hasNodeId) {
        await this.db.schema.alterTable(ASSIGNMENTS, t =>
          t.renameColumn('component_id', 'node_id'),
        );
      } else if (hasComponentId && hasNodeId) {
        await this.db(ASSIGNMENTS)
          .whereNull('node_id')
          .whereNotNull('component_id')
          .update({ node_id: this.db.ref('component_id') });
        await this.db.schema.alterTable(ASSIGNMENTS, t =>
          t.dropColumn('component_id'),
        );
      }
    }

    // nodes table
    const hasNodes = await this.db.schema.hasTable(NODES);
    if (!hasNodes) {
      await this.db.schema.createTable(NODES, t => {
        t.string('id').primary();
        t.string('diagram_id').notNullable();
        t.string('type').notNullable();
        t.string('label').notNullable();
        t.text('description');
        t.float('x').notNullable();
        t.float('y').notNullable();
        t.float('width').notNullable();
        t.float('height').notNullable();
        t.string('parent_id');
        t.integer('z_order').notNullable().defaultTo(0);
        t.string('updated_by');
        t.timestamp('updated_at').notNullable();
        t.index(['diagram_id']);
      });
    } else {
      const hasDescription = await this.db.schema.hasColumn(NODES, 'description');
      if (!hasDescription) {
        await this.db.schema.alterTable(NODES, t => t.text('description'));
      }
      const hasDiagramId = await this.db.schema.hasColumn(NODES, 'diagram_id');
      if (!hasDiagramId) {
        await this.db.schema.alterTable(NODES, t =>
          t.string('diagram_id').notNullable().defaultTo(DEFAULT_DIAGRAM_ID),
        );
      }
      // The old "group" node was a visual container; renamed to "area".
      // The new "group" semantic is a leaf, so it never has children.
      const parentIds = await this.db(NODES)
        .whereNotNull('parent_id')
        .distinct('parent_id')
        .pluck('parent_id');
      if (parentIds.length > 0) {
        await this.db(NODES)
          .where('type', 'group')
          .whereIn('id', parentIds as any)
          .update({ type: 'area' });
      }
    }

    // clicks table — global, not per diagram.
    const hasClicks = await this.db.schema.hasTable(CLICKS);
    if (!hasClicks) {
      await this.db.schema.createTable(CLICKS, t => {
        t.string('dashboard_uid').primary();
        t.integer('count').notNullable().defaultTo(0);
        t.timestamp('last_clicked_at');
      });
    }

    // edges table
    const hasEdges = await this.db.schema.hasTable(EDGES);
    if (!hasEdges) {
      await this.db.schema.createTable(EDGES, t => {
        t.string('id').primary();
        t.string('diagram_id').notNullable();
        t.string('source_id').notNullable();
        t.string('target_id').notNullable();
        t.string('source_handle');
        t.string('target_handle');
        t.string('label');
        t.string('updated_by');
        t.timestamp('updated_at').notNullable();
        t.index(['diagram_id']);
      });
    } else {
      const hasSh = await this.db.schema.hasColumn(EDGES, 'source_handle');
      if (!hasSh) {
        await this.db.schema.alterTable(EDGES, t => t.string('source_handle'));
      }
      const hasTh = await this.db.schema.hasColumn(EDGES, 'target_handle');
      if (!hasTh) {
        await this.db.schema.alterTable(EDGES, t => t.string('target_handle'));
      }
      const hasDiagramId = await this.db.schema.hasColumn(EDGES, 'diagram_id');
      if (!hasDiagramId) {
        await this.db.schema.alterTable(EDGES, t =>
          t.string('diagram_id').notNullable().defaultTo(DEFAULT_DIAGRAM_ID),
        );
      }
    }

    // Seed the default diagram if no diagram exists yet. Existing nodes/edges
    // (if any) inherit DEFAULT_DIAGRAM_ID via the column default applied above.
    const diagramCount = await this.db(DIAGRAMS).count<{ c: number }>(
      { c: '*' },
    );
    const count = Number((diagramCount as any)[0]?.c ?? 0);
    if (count === 0) {
      await this.db(DIAGRAMS).insert({
        id: DEFAULT_DIAGRAM_ID,
        name: DEFAULT_DIAGRAM_NAME,
        description: null,
        position: 0,
        created_by: null,
        created_at: now,
        updated_by: null,
        updated_at: now,
      });
    }

    // Migrate legacy assignments primary key (dashboard_uid only) →
    // composite (dashboard_uid, node_id) so the same dashboard can be
    // mapped in multiple diagrams. We detect the legacy form by trying to
    // insert two rows with the same dashboard_uid; if the new PK is
    // active, both rows coexist. We use a safer method: introspect via a
    // marker column, but the simplest portable check is a try/catch.
    if (hasAssignments) {
      await this.migrateAssignmentsPrimaryKey();
    }
  }

  private async migrateAssignmentsPrimaryKey(): Promise<void> {
    // Probe: insert two test rows with the same dashboard_uid but different
    // node_ids. If the legacy PK is in place this fails on the second insert.
    const probeUid = `__pk_probe_${Date.now()}__`;
    let needsMigration = false;
    try {
      await this.db.transaction(async trx => {
        await trx(ASSIGNMENTS).insert({
          dashboard_uid: probeUid,
          node_id: '__probe_a__',
          position: 0,
          tier: null,
          updated_by: null,
          updated_at: new Date().toISOString(),
        });
        await trx(ASSIGNMENTS).insert({
          dashboard_uid: probeUid,
          node_id: '__probe_b__',
          position: 0,
          tier: null,
          updated_by: null,
          updated_at: new Date().toISOString(),
        });
        // If we got here, the composite PK is already in place. Roll back
        // the probe rows.
        throw new Error('__rollback_probe__');
      });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg !== '__rollback_probe__') {
        // Insert failed because the legacy single-column PK is still active.
        needsMigration = true;
      }
    }

    if (!needsMigration) return;

    const existing = await this.db(ASSIGNMENTS).select('*');
    await this.db.schema.dropTable(ASSIGNMENTS);
    await this.db.schema.createTable(ASSIGNMENTS, t => {
      t.string('dashboard_uid').notNullable();
      t.string('node_id').notNullable();
      t.integer('position').notNullable().defaultTo(0);
      t.string('tier');
      t.string('updated_by');
      t.timestamp('updated_at').notNullable();
      t.primary(['dashboard_uid', 'node_id']);
      t.index(['node_id']);
    });
    if (existing.length > 0) {
      await this.db(ASSIGNMENTS).insert(existing);
    }
  }

  // ---------- diagrams ----------

  async listDiagrams(): Promise<Diagram[]> {
    const rows = await this.db(DIAGRAMS)
      .select('*')
      .orderBy([
        { column: 'position', order: 'asc' },
        { column: 'created_at', order: 'asc' },
      ]);
    return rows.map(rowToDiagram);
  }

  async getDiagram(id: string): Promise<Diagram | null> {
    const row = await this.db(DIAGRAMS).where('id', id).first();
    return row ? rowToDiagram(row) : null;
  }

  async createDiagram(
    input: { id: string; name: string; description?: string },
    createdBy: string,
  ): Promise<Diagram> {
    const now = new Date().toISOString();
    const maxPos = await this.db(DIAGRAMS).max<{ m: number | null }>(
      { m: 'position' },
    );
    const next = Number((maxPos as any)[0]?.m ?? -1) + 1;
    await this.db(DIAGRAMS).insert({
      id: input.id,
      name: input.name,
      description: input.description ?? null,
      position: next,
      created_by: createdBy,
      created_at: now,
      updated_by: createdBy,
      updated_at: now,
    });
    const created = await this.getDiagram(input.id);
    return created!;
  }

  async updateDiagram(
    id: string,
    patch: { name?: string; description?: string | null; position?: number },
    updatedBy: string,
  ): Promise<Diagram | null> {
    const existing = await this.getDiagram(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      updated_by: updatedBy,
      updated_at: now,
    };
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.description !== undefined) update.description = patch.description;
    if (patch.position !== undefined) update.position = patch.position;
    await this.db(DIAGRAMS).where('id', id).update(update);
    return this.getDiagram(id);
  }

  async deleteDiagram(id: string): Promise<boolean> {
    return this.db.transaction(async trx => {
      const existing = await trx(DIAGRAMS).where('id', id).first();
      if (!existing) return false;
      // Cascade: drop assignments whose node belongs to this diagram, then
      // edges, then nodes, then the diagram row itself.
      const nodeIds = await trx(NODES)
        .where('diagram_id', id)
        .pluck('id');
      if (nodeIds.length > 0) {
        await trx(ASSIGNMENTS).whereIn('node_id', nodeIds).delete();
      }
      await trx(EDGES).where('diagram_id', id).delete();
      await trx(NODES).where('diagram_id', id).delete();
      await trx(DIAGRAMS).where('id', id).delete();
      return true;
    });
  }

  // ---------- assignments ----------

  async listAssignments(diagramId: string): Promise<DashboardAssignment[]> {
    const rows = await this.db(ASSIGNMENTS)
      .join(NODES, `${ASSIGNMENTS}.node_id`, `${NODES}.id`)
      .where(`${NODES}.diagram_id`, diagramId)
      .select(
        `${ASSIGNMENTS}.dashboard_uid as dashboard_uid`,
        `${ASSIGNMENTS}.node_id as node_id`,
        `${ASSIGNMENTS}.position as position`,
        `${ASSIGNMENTS}.tier as tier`,
      );
    return rows.map(row => ({
      dashboardUid: row.dashboard_uid as string,
      nodeId: row.node_id as string,
      position: Number(row.position) || 0,
      tier: (row.tier as DashboardTier | null) ?? null,
    }));
  }

  async listClicks(): Promise<Map<string, { count: number; lastClickedAt?: string }>> {
    const rows = await this.db(CLICKS).select(
      'dashboard_uid',
      'count',
      'last_clicked_at',
    );
    const map = new Map<string, { count: number; lastClickedAt?: string }>();
    for (const row of rows) {
      map.set(row.dashboard_uid as string, {
        count: Number(row.count) || 0,
        lastClickedAt: (row.last_clicked_at as string | null) ?? undefined,
      });
    }
    return map;
  }

  async incrementClick(uid: string): Promise<{ count: number; lastClickedAt: string }> {
    const now = new Date().toISOString();
    return this.db.transaction(async trx => {
      const existing = await trx(CLICKS).where('dashboard_uid', uid).first();
      if (existing) {
        const next = (Number(existing.count) || 0) + 1;
        await trx(CLICKS)
          .where('dashboard_uid', uid)
          .update({ count: next, last_clicked_at: now });
        return { count: next, lastClickedAt: now };
      }
      await trx(CLICKS).insert({
        dashboard_uid: uid,
        count: 1,
        last_clicked_at: now,
      });
      return { count: 1, lastClickedAt: now };
    });
  }

  async replaceAssignments(
    diagramId: string,
    assignments: DashboardAssignment[],
    updatedBy: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction(async trx => {
      const nodeIds = await trx(NODES)
        .where('diagram_id', diagramId)
        .pluck('id');
      if (nodeIds.length > 0) {
        await trx(ASSIGNMENTS).whereIn('node_id', nodeIds).delete();
      }
      if (assignments.length > 0) {
        await trx(ASSIGNMENTS).insert(
          assignments.map(a => ({
            dashboard_uid: a.dashboardUid,
            node_id: a.nodeId,
            position: a.position,
            tier: a.tier,
            updated_by: updatedBy,
            updated_at: now,
          })),
        );
      }
    });
  }

  // ---------- architecture ----------

  async getArchitecture(diagramId: string): Promise<Architecture> {
    const [nodeRows, edgeRows, latestNode, latestEdge, latestAssign] =
      await Promise.all([
        this.db(NODES).where('diagram_id', diagramId).select('*'),
        this.db(EDGES).where('diagram_id', diagramId).select('*'),
        this.db(NODES)
          .where('diagram_id', diagramId)
          .select('updated_at', 'updated_by')
          .orderBy('updated_at', 'desc')
          .first(),
        this.db(EDGES)
          .where('diagram_id', diagramId)
          .select('updated_at', 'updated_by')
          .orderBy('updated_at', 'desc')
          .first(),
        this.db(ASSIGNMENTS)
          .join(NODES, `${ASSIGNMENTS}.node_id`, `${NODES}.id`)
          .where(`${NODES}.diagram_id`, diagramId)
          .select(
            `${ASSIGNMENTS}.updated_at as updated_at`,
            `${ASSIGNMENTS}.updated_by as updated_by`,
          )
          .orderBy(`${ASSIGNMENTS}.updated_at`, 'desc')
          .first(),
      ]);
    const candidates = [latestNode, latestEdge, latestAssign].filter(
      (r): r is { updated_at: string; updated_by: string | null } =>
        !!r && typeof r.updated_at === 'string' && r.updated_at.length > 0,
    );
    candidates.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const latest = candidates[0];
    const lastSavedAt = latest?.updated_at;
    const lastSavedBy = latest?.updated_by ?? undefined;
    const nodes: ArchitectureNode[] = nodeRows.map(r => ({
      id: r.id as string,
      type: r.type as NodeType,
      label: r.label as string,
      description: (r.description as string | null) ?? undefined,
      x: Number(r.x),
      y: Number(r.y),
      width: Number(r.width),
      height: Number(r.height),
      parentId: (r.parent_id as string | null) ?? null,
      zOrder: Number(r.z_order) || 0,
    }));
    const edges: ArchitectureEdge[] = edgeRows.map(r => ({
      id: r.id as string,
      sourceId: r.source_id as string,
      targetId: r.target_id as string,
      sourceHandle: (r.source_handle as string | null) ?? undefined,
      targetHandle: (r.target_handle as string | null) ?? undefined,
      label: (r.label as string | null) ?? undefined,
    }));
    return { nodes, edges, lastSavedAt, lastSavedBy };
  }

  async replaceArchitecture(
    diagramId: string,
    arch: Architecture,
    updatedBy: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction(async trx => {
      const oldNodeIds = await trx(NODES)
        .where('diagram_id', diagramId)
        .pluck('id');
      await trx(EDGES).where('diagram_id', diagramId).delete();
      if (oldNodeIds.length > 0) {
        await trx(ASSIGNMENTS).whereIn('node_id', oldNodeIds).delete();
      }
      await trx(NODES).where('diagram_id', diagramId).delete();
      if (arch.nodes.length > 0) {
        await trx(NODES).insert(
          arch.nodes.map(n => ({
            id: n.id,
            diagram_id: diagramId,
            type: n.type,
            label: n.label,
            description: n.description ?? null,
            x: n.x,
            y: n.y,
            width: n.width,
            height: n.height,
            parent_id: n.parentId,
            z_order: n.zOrder,
            updated_by: updatedBy,
            updated_at: now,
          })),
        );
      }
      if (arch.edges.length > 0) {
        await trx(EDGES).insert(
          arch.edges.map(e => ({
            id: e.id,
            diagram_id: diagramId,
            source_id: e.sourceId,
            target_id: e.targetId,
            source_handle: e.sourceHandle ?? null,
            target_handle: e.targetHandle ?? null,
            label: e.label ?? null,
            updated_by: updatedBy,
            updated_at: now,
          })),
        );
      }
    });
  }
}

function rowToDiagram(row: Record<string, unknown>): Diagram {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    position: Number(row.position) || 0,
    createdBy: (row.created_by as string | null) ?? undefined,
    createdAt: (row.created_at as string | null) ?? undefined,
    updatedBy: (row.updated_by as string | null) ?? undefined,
    updatedAt: (row.updated_at as string | null) ?? undefined,
  };
}
