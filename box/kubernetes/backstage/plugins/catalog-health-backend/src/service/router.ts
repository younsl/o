import { Router } from 'express';
import express from 'express';
import { LoggerService, HttpAuthService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { CatalogHealthService } from './CatalogHealthService';
import { CoverageHistoryStore } from './CoverageHistoryStore';

export interface RouterOptions {
  service: CatalogHealthService;
  logger: LoggerService;
  config: Config;
  httpAuth: HttpAuthService;
  historyStore: CoverageHistoryStore;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { service, logger, config, httpAuth, historyStore } = options;
  const router = Router();
  router.use(express.json());

  const admins = config.getOptionalStringArray('permission.admins') ?? [];
  const isDevMode = config.getOptionalBoolean('backend.auth.dangerouslyDisableDefaultAuthPolicy') ?? false;

  async function tryGetUserRef(req: express.Request): Promise<string | undefined> {
    try {
      const credentials = await httpAuth.credentials(req as any, { allow: ['user'] });
      return credentials.principal.userEntityRef;
    } catch {
      if (isDevMode) {
        return 'user:development/guest';
      }
      return undefined;
    }
  }

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/coverage', (_, res) => {
    try {
      const coverage = service.getCoverage();
      res.json(coverage);
    } catch (error) {
      logger.error(`Failed to get coverage: ${error}`);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  router.get('/coverage/groups', (_, res) => {
    try {
      const groups = service.getGroupCoverage();
      res.json(groups);
    } catch (error) {
      logger.error(`Failed to get group coverage: ${error}`);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  router.get('/coverage/history', async (req, res) => {
    try {
      const days = Number(req.query.days) || 90;
      const history = await historyStore.getHistory(days);
      res.json(history);
    } catch (error) {
      logger.error(`Failed to get coverage history: ${error}`);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  router.get('/admin-status', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    res.json({ isAdmin: !!userRef && admins.includes(userRef) });
  });

  router.post('/toggle-ignore/:projectId', async (req, res) => {
    try {
      const userRef = await tryGetUserRef(req);
      if (!userRef || !admins.includes(userRef)) {
        res.status(403).json({ error: 'Only admins can toggle ignore status' });
        return;
      }
      const projectId = Number(req.params.projectId);
      if (!projectId) {
        res.status(400).json({ error: 'Invalid projectId' });
        return;
      }
      const result = await service.toggleIgnore(projectId);
      res.json(result);
    } catch (error) {
      logger.error(`Failed to toggle ignore: ${error}`);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to toggle ignore' });
    }
  });

  router.get('/branches/:projectId', async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);
      if (!projectId) {
        res.status(400).json({ error: 'Invalid projectId' });
        return;
      }
      const branches = await service.getBranches(projectId);
      res.json(branches);
    } catch (error) {
      logger.error(`Failed to get branches: ${error}`);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get branches' });
    }
  });

  router.post('/submit-catalog-info', async (req, res) => {
    try {
      const { projectId, name, description, type, lifecycle, owner, tags, targetBranch } = req.body ?? {};
      if (!projectId || !name) {
        res.status(400).json({ error: 'projectId and name are required' });
        return;
      }
      const result = await service.submitCatalogInfo({
        projectId,
        name: name || '',
        description: description || '',
        type: type || 'service',
        lifecycle: lifecycle || 'production',
        owner: owner || 'unknown',
        tags: Array.isArray(tags) ? tags : [],
        targetBranch: targetBranch || undefined,
      });
      res.json(result);
    } catch (error) {
      logger.error(`Failed to submit catalog-info.yaml: ${error}`);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to submit' });
    }
  });

  router.post('/scan', async (_, res) => {
    try {
      await service.scan();
      res.json({ status: 'ok' });
    } catch (error) {
      logger.error(`Scan failed: ${error}`);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Scan failed' });
    }
  });

  return router;
}
