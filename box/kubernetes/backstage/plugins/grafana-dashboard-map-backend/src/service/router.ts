import { Router } from 'express';
import express from 'express';
import {
  AuditorService,
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { GrafanaClient } from './GrafanaClient';
import { GrafanaDashboardMapStore } from './GrafanaDashboardMapStore';
import {
  Architecture,
  ArchitectureEdge,
  ArchitectureNode,
  DASHBOARD_TIERS,
  DashboardAssignment,
  DashboardItem,
  DashboardTier,
  DashboardsResponse,
  NodeType,
} from './types';

export interface RouterOptions {
  store: GrafanaDashboardMapStore;
  grafana: GrafanaClient;
  logger: LoggerService;
  config: Config;
  httpAuth: HttpAuthService;
  auditor: AuditorService;
}

const VALID_NODE_TYPES = new Set<NodeType>(['box', 'area', 'group']);
const DASHBOARD_HOST_TYPES = new Set<NodeType>(['box', 'group']);
const DIAGRAM_ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { store, grafana, logger, config, httpAuth, auditor } = options;

  const router = Router();
  router.use(express.json({ limit: '1mb' }));

  const admins = config.getOptionalStringArray('permission.admins') ?? [];
  const isDevMode =
    config.getOptionalBoolean('backend.auth.dangerouslyDisableDefaultAuthPolicy') ??
    false;
  const validTiers = new Set<DashboardTier>(DASHBOARD_TIERS);

  async function tryGetUserRef(req: express.Request): Promise<string | undefined> {
    try {
      const credentials = await httpAuth.credentials(req as any, {
        allow: ['user'],
      });
      return credentials.principal.userEntityRef;
    } catch {
      if (isDevMode) {
        return 'user:development/guest';
      }
      return undefined;
    }
  }

  function requireAdmin(
    userRef: string | undefined,
    res: express.Response,
  ): boolean {
    if (!userRef || !admins.includes(userRef)) {
      res.status(403).json({ error: 'Admin only' });
      return false;
    }
    return true;
  }

  async function ensureDiagram(
    diagramId: string,
    res: express.Response,
  ): Promise<boolean> {
    const diagram = await store.getDiagram(diagramId);
    if (!diagram) {
      res.status(404).json({ error: `Diagram not found: ${diagramId}` });
      return false;
    }
    return true;
  }

  function validateArchitecture(body: any): Architecture | string {
    if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
      return 'Body must have nodes[] and edges[]';
    }

    const nodes: ArchitectureNode[] = [];
    const ids = new Set<string>();
    for (const n of body.nodes) {
      if (
        typeof n.id !== 'string' ||
        typeof n.type !== 'string' ||
        typeof n.label !== 'string' ||
        typeof n.x !== 'number' ||
        typeof n.y !== 'number' ||
        typeof n.width !== 'number' ||
        typeof n.height !== 'number'
      ) {
        return 'Invalid node entry';
      }
      if (!VALID_NODE_TYPES.has(n.type as NodeType)) {
        return `Invalid node type: ${n.type}`;
      }
      if (ids.has(n.id)) return `Duplicate node id: ${n.id}`;
      ids.add(n.id);
      let description: string | undefined;
      if (n.description !== undefined && n.description !== null) {
        if (typeof n.description !== 'string') {
          return 'Invalid node description';
        }
        const trimmed = n.description.slice(0, 500);
        description = trimmed.length > 0 ? trimmed : undefined;
      }
      nodes.push({
        id: n.id,
        type: n.type as NodeType,
        label: n.label,
        description,
        x: n.x,
        y: n.y,
        width: Math.max(40, n.width),
        height: Math.max(40, n.height),
        parentId:
          typeof n.parentId === 'string' && n.parentId ? n.parentId : null,
        zOrder: Number.isFinite(n.zOrder) ? Number(n.zOrder) : 0,
      });
    }
    for (const n of nodes) {
      if (!n.parentId) continue;
      const parent = nodes.find(p => p.id === n.parentId);
      if (!parent) return `Parent not found: ${n.parentId}`;
      if (parent.type !== 'area') return `Parent must be an area: ${parent.id}`;
      let cur: ArchitectureNode | undefined = parent;
      const seen = new Set<string>([n.id]);
      while (cur) {
        if (seen.has(cur.id)) return `Cycle in parentId: ${n.id}`;
        seen.add(cur.id);
        cur = cur.parentId ? nodes.find(p => p.id === cur!.parentId) : undefined;
      }
    }

    const edges: ArchitectureEdge[] = [];
    const edgeIds = new Set<string>();
    for (const e of body.edges) {
      if (
        typeof e.id !== 'string' ||
        typeof e.sourceId !== 'string' ||
        typeof e.targetId !== 'string'
      ) {
        return 'Invalid edge entry';
      }
      if (edgeIds.has(e.id)) return `Duplicate edge id: ${e.id}`;
      edgeIds.add(e.id);
      if (!ids.has(e.sourceId)) return `Edge source not found: ${e.sourceId}`;
      if (!ids.has(e.targetId)) return `Edge target not found: ${e.targetId}`;
      if (e.sourceId === e.targetId) return `Edge cannot self-loop: ${e.id}`;
      edges.push({
        id: e.id,
        sourceId: e.sourceId,
        targetId: e.targetId,
        sourceHandle:
          typeof e.sourceHandle === 'string' && e.sourceHandle
            ? e.sourceHandle
            : undefined,
        targetHandle:
          typeof e.targetHandle === 'string' && e.targetHandle
            ? e.targetHandle
            : undefined,
        label: typeof e.label === 'string' && e.label ? e.label : undefined,
      });
    }

    return { nodes, edges };
  }

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/admin-status', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    res.json({ isAdmin: !!userRef && admins.includes(userRef) });
  });

  // ---------- diagrams ----------

  router.get('/diagrams', async (_req, res) => {
    try {
      const diagrams = await store.listDiagrams();
      res.json({ diagrams });
    } catch (error) {
      logger.error(`Failed to list diagrams: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to load',
      });
    }
  });

  router.post('/diagrams', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    if (!requireAdmin(userRef, res)) return;

    const { id, name, description } = req.body ?? {};
    if (typeof id !== 'string' || !DIAGRAM_ID_RE.test(id)) {
      res.status(400).json({
        error: 'id must be 1–64 chars: letters, digits, dash, underscore',
      });
      return;
    }
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
      res.status(400).json({ error: 'description must be a string' });
      return;
    }

    const existing = await store.getDiagram(id);
    if (existing) {
      res.status(409).json({ error: `Diagram already exists: ${id}` });
      return;
    }

    const auditorEvent = await auditor.createEvent({
      eventId: 'grafana-dashboard-map.diagram.create',
      request: req as any,
      severityLevel: 'medium',
      meta: { actionType: 'create', userRef, diagramId: id },
    });

    try {
      const diagram = await store.createDiagram(
        {
          id,
          name: name.trim().slice(0, 200),
          description:
            typeof description === 'string'
              ? description.slice(0, 500) || undefined
              : undefined,
        },
        userRef!,
      );
      await auditorEvent.success();
      res.status(201).json(diagram);
    } catch (error) {
      logger.error(`Failed to create diagram: ${error}`);
      await auditorEvent.fail({ error: error as Error });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create',
      });
    }
  });

  router.patch('/diagrams/:id', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    if (!requireAdmin(userRef, res)) return;

    const { id } = req.params;
    const { name, description, position } = req.body ?? {};

    const patch: { name?: string; description?: string | null; position?: number } = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name must be a non-empty string' });
        return;
      }
      patch.name = name.trim().slice(0, 200);
    }
    if (description !== undefined) {
      if (description !== null && typeof description !== 'string') {
        res.status(400).json({ error: 'description must be a string or null' });
        return;
      }
      patch.description =
        typeof description === 'string' ? description.slice(0, 500) || null : null;
    }
    if (position !== undefined) {
      if (typeof position !== 'number' || !Number.isFinite(position)) {
        res.status(400).json({ error: 'position must be a number' });
        return;
      }
      patch.position = Math.max(0, Math.floor(position));
    }

    const auditorEvent = await auditor.createEvent({
      eventId: 'grafana-dashboard-map.diagram.update',
      request: req as any,
      severityLevel: 'low',
      meta: { actionType: 'update', userRef, diagramId: id },
    });

    try {
      const updated = await store.updateDiagram(id, patch, userRef!);
      if (!updated) {
        await auditorEvent.fail({ error: new Error('not found') });
        res.status(404).json({ error: `Diagram not found: ${id}` });
        return;
      }
      await auditorEvent.success();
      res.json(updated);
    } catch (error) {
      logger.error(`Failed to update diagram: ${error}`);
      await auditorEvent.fail({ error: error as Error });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to update',
      });
    }
  });

  router.delete('/diagrams/:id', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    if (!requireAdmin(userRef, res)) return;

    const { id } = req.params;
    const remaining = await store.listDiagrams();
    if (remaining.length <= 1) {
      res.status(400).json({ error: 'Cannot delete the last diagram' });
      return;
    }

    const auditorEvent = await auditor.createEvent({
      eventId: 'grafana-dashboard-map.diagram.delete',
      request: req as any,
      severityLevel: 'high',
      meta: { actionType: 'delete', userRef, diagramId: id },
    });

    try {
      const ok = await store.deleteDiagram(id);
      if (!ok) {
        await auditorEvent.fail({ error: new Error('not found') });
        res.status(404).json({ error: `Diagram not found: ${id}` });
        return;
      }
      await auditorEvent.success();
      res.json({ status: 'ok' });
    } catch (error) {
      logger.error(`Failed to delete diagram: ${error}`);
      await auditorEvent.fail({ error: error as Error });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to delete',
      });
    }
  });

  // ---------- architecture (per diagram) ----------

  router.get('/diagrams/:id/architecture', async (req, res) => {
    const { id } = req.params;
    if (!(await ensureDiagram(id, res))) return;
    try {
      const arch = await store.getArchitecture(id);
      res.json(arch);
    } catch (error) {
      logger.error(`Failed to get architecture: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to load',
      });
    }
  });

  router.put('/diagrams/:id/architecture', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    if (!requireAdmin(userRef, res)) return;

    const { id } = req.params;
    if (!(await ensureDiagram(id, res))) return;

    const validated = validateArchitecture(req.body);
    if (typeof validated === 'string') {
      res.status(400).json({ error: validated });
      return;
    }

    const auditorEvent = await auditor.createEvent({
      eventId: 'grafana-dashboard-map.architecture.update',
      request: req as any,
      severityLevel: 'medium',
      meta: {
        actionType: 'update',
        userRef,
        diagramId: id,
        nodeCount: validated.nodes.length,
        edgeCount: validated.edges.length,
      },
    });

    try {
      await store.replaceArchitecture(id, validated, userRef!);
      await auditorEvent.success();
      res.json({
        status: 'ok',
        nodes: validated.nodes.length,
        edges: validated.edges.length,
      });
    } catch (error) {
      logger.error(`Failed to save architecture: ${error}`);
      await auditorEvent.fail({ error: error as Error });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to save',
      });
    }
  });

  // ---------- dashboards (per diagram) ----------

  router.get('/diagrams/:id/dashboards', async (req, res) => {
    const { id } = req.params;
    if (!(await ensureDiagram(id, res))) return;
    try {
      const [results, assignments, arch, clicks, alertRulesByDash] = await Promise.all([
        grafana.searchDashboards(),
        store.listAssignments(id),
        store.getArchitecture(id),
        store.listClicks(),
        grafana.fetchDashboardAlertRules(),
      ]);

      const nodeIds = new Set(arch.nodes.map(n => n.id));
      const assignmentMap = new Map(assignments.map(a => [a.dashboardUid, a]));

      const dashboards: DashboardItem[] = results.map(r => {
        const a = assignmentMap.get(r.uid);
        const nodeId = a && nodeIds.has(a.nodeId) ? a.nodeId : null;
        const tier = a && a.tier && validTiers.has(a.tier) ? a.tier : null;
        const click = clicks.get(r.uid);
        const alertRules = alertRulesByDash.get(r.uid) ?? [];
        const firingCount = alertRules.filter(rl => rl.firing).length;
        return {
          uid: r.uid,
          title: r.title,
          url: r.url,
          folder: r.folderTitle,
          tags: r.tags ?? [],
          nodeId,
          position: a?.position ?? 0,
          tier,
          clickCount: click?.count ?? 0,
          lastClickedAt: click?.lastClickedAt,
          alertState: firingCount > 0 ? 'firing' : 'ok',
          firingCount,
          alertCount: alertRules.length,
          alertRules,
        };
      });

      dashboards.sort((a, b) => {
        if (a.nodeId === b.nodeId) {
          if (a.position !== b.position) return a.position - b.position;
          return a.title.localeCompare(b.title);
        }
        if (a.nodeId === null) return 1;
        if (b.nodeId === null) return -1;
        return a.nodeId.localeCompare(b.nodeId);
      });

      const body: DashboardsResponse = { dashboards, tiers: DASHBOARD_TIERS };
      res.json(body);
    } catch (error) {
      logger.error(`Failed to list dashboards: ${error}`);
      res.status(502).json({
        error: error instanceof Error ? error.message : 'Failed to fetch dashboards',
      });
    }
  });

  router.put('/diagrams/:id/assignments', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    if (!requireAdmin(userRef, res)) return;

    const { id } = req.params;
    if (!(await ensureDiagram(id, res))) return;

    const body = req.body;
    if (!Array.isArray(body)) {
      res.status(400).json({ error: 'Body must be an array of assignments' });
      return;
    }

    const [knownUids, arch] = await Promise.all([
      grafana.searchDashboards().then(r => new Set(r.map(d => d.uid))),
      store.getArchitecture(id),
    ]);
    const nodeTypeById = new Map(arch.nodes.map(n => [n.id, n.type]));

    const sanitized: DashboardAssignment[] = [];
    for (const item of body as Array<Partial<DashboardAssignment>>) {
      if (
        typeof item.dashboardUid !== 'string' ||
        typeof item.nodeId !== 'string' ||
        typeof item.position !== 'number'
      ) {
        res.status(400).json({ error: 'Invalid assignment entry' });
        return;
      }
      if (!knownUids.has(item.dashboardUid)) {
        res.status(400).json({ error: `Unknown dashboardUid: ${item.dashboardUid}` });
        return;
      }
      const nodeType = nodeTypeById.get(item.nodeId);
      if (!nodeType) {
        res.status(400).json({
          error: `Node not found in this diagram: ${item.nodeId}`,
        });
        return;
      }
      if (!DASHBOARD_HOST_TYPES.has(nodeType)) {
        res.status(400).json({
          error: `Cannot map dashboards to ${nodeType} (only box or group): ${item.nodeId}`,
        });
        return;
      }
      let tier: DashboardTier | null = null;
      if (item.tier !== undefined && item.tier !== null) {
        if (!validTiers.has(item.tier as DashboardTier)) {
          res.status(400).json({ error: `Unknown tier: ${item.tier}` });
          return;
        }
        tier = item.tier as DashboardTier;
      }
      sanitized.push({
        dashboardUid: item.dashboardUid,
        nodeId: item.nodeId,
        position: Math.max(0, Math.floor(item.position)),
        tier,
      });
    }

    const auditorEvent = await auditor.createEvent({
      eventId: 'grafana-dashboard-map.assignments.update',
      request: req as any,
      severityLevel: 'medium',
      meta: {
        actionType: 'update',
        userRef,
        diagramId: id,
        count: sanitized.length,
      },
    });

    try {
      await store.replaceAssignments(id, sanitized, userRef!);
      await auditorEvent.success({ meta: { count: sanitized.length } });
      res.json({ status: 'ok', count: sanitized.length });
    } catch (error) {
      logger.error(`Failed to save assignments: ${error}`);
      await auditorEvent.fail({ error: error as Error });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to save',
      });
    }
  });

  router.post('/clicks/:uid', async (req, res) => {
    const { uid } = req.params;
    if (!uid || typeof uid !== 'string') {
      res.status(400).json({ error: 'Missing uid' });
      return;
    }
    try {
      const known = await grafana.searchDashboards();
      if (!known.some(d => d.uid === uid)) {
        res.status(400).json({ error: `Unknown dashboardUid: ${uid}` });
        return;
      }
      const result = await store.incrementClick(uid);
      res.json(result);
    } catch (error) {
      logger.error(`Failed to record click: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed',
      });
    }
  });

  return router;
}
