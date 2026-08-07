import express from 'express';
import { Router } from 'express';
import { Config } from '@backstage/config';
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import { OpenSearchConflictService } from './OpenSearchConflictService';

export interface RouterOptions {
  logger: LoggerService;
  config: Config;
  httpAuth: HttpAuthService;
  service: OpenSearchConflictService;
  scanCron: string;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { config, httpAuth, service, scanCron } = options;
  const router = Router();
  router.use(express.json());

  const isDevMode =
    config.getOptionalBoolean(
      'backend.auth.dangerouslyDisableDefaultAuthPolicy',
    ) ?? false;
  const admins = config.getOptionalStringArray('permission.admins') ?? [];

  async function requireUser(
    req: express.Request,
    res: express.Response,
  ): Promise<boolean> {
    try {
      await httpAuth.credentials(req as any, { allow: ['user'] });
      return true;
    } catch {
      if (isDevMode) return true;
      res.status(401).json({ error: 'Authentication required' });
      return false;
    }
  }

  /** Returns true only for authenticated users listed in `permission.admins`. */
  async function requireAdmin(
    req: express.Request,
    res: express.Response,
  ): Promise<boolean> {
    let userRef: string | undefined;
    try {
      const credentials = await httpAuth.credentials(req as any, {
        allow: ['user'],
      });
      userRef = credentials.principal.userEntityRef;
    } catch {
      userRef = isDevMode ? 'user:development/guest' : undefined;
    }
    if (!userRef) {
      res.status(401).json({ error: 'Authentication required' });
      return false;
    }
    if (!admins.includes(userRef)) {
      res.status(403).json({ error: 'Admin access required' });
      return false;
    }
    return true;
  }

  function requireManualRefresh(
    req: express.Request,
    res: express.Response,
  ): boolean {
    const explicitBody = req.body?.manualRefresh === true;
    const explicitHeader =
      req.header('x-opensearch-viewer-action') === 'manual-refresh';
    if (explicitBody && explicitHeader) return true;

    res.status(400).json({
      error:
        'Manual refresh confirmation is required. Use the Refresh button to start a scan.',
    });
    return false;
  }

  router.get('/health', (_, res) => res.json({ status: 'ok' }));

  router.get('/config', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    res.json({
      configured: service.isConfigured(),
      targets: service.getTargets(),
      scanCron,
    });
  });

  router.get('/snapshots', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    res.json(await service.listSnapshots());
  });

  router.get('/snapshots/:targetId', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const snapshot = await service.getSnapshot(req.params.targetId);
    if (!snapshot) {
      res.status(404).json({ error: 'target not found' });
      return;
    }
    res.json(snapshot);
  });

  router.post('/scan', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    if (!requireManualRefresh(req, res)) return;
    try {
      const targetId = (req.body?.targetId as string | undefined)?.trim();
      if (targetId) {
        res.json(await service.scanTarget(targetId));
        return;
      }
      res.json(await service.scanAll());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('already running') ? 409 : 500).json({ error: message });
    }
  });

  router.post('/scan/:targetId', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    if (!requireManualRefresh(req, res)) return;
    try {
      res.json(await service.scanTarget(req.params.targetId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('already running') ? 409 : 500).json({ error: message });
    }
  });

  // Admin-only, type-to-confirm index deletion. The confirmation string must
  // equal the index name both here (defense in depth) and in the UI modal.
  router.post('/indices/delete', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const index = (req.body?.index as string | undefined)?.trim();
    const confirm = (req.body?.confirm as string | undefined)?.trim();
    if (!index) {
      res.status(400).json({ error: 'index is required' });
      return;
    }
    if (confirm !== index) {
      res
        .status(400)
        .json({ error: 'Confirmation does not match the index name' });
      return;
    }

    try {
      await service.deleteIndex(index);
      res.json({ deleted: true, index });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
