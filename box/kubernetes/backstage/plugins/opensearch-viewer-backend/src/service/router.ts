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

  return router;
}
