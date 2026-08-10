import express, { Router } from 'express';
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { aggregateStats } from './aggregate';
import { readPlatformNames } from './platformNames';
import { VisitStore } from './VisitStore';
import { PlatformStatsResponse } from './types';

export interface RouterOptions {
  store: VisitStore;
  logger: LoggerService;
  config: Config;
  httpAuth: HttpAuthService;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { store, logger, config, httpAuth } = options;
  const router = Router();
  router.use(express.json());

  const isDevMode =
    config.getOptionalBoolean(
      'backend.auth.dangerouslyDisableDefaultAuthPolicy',
    ) ?? false;

  async function tryGetUserRef(
    req: express.Request,
  ): Promise<string | undefined> {
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

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/stats', async (_, res) => {
    try {
      const rows = await store.getRecentVisits();
      const stats = aggregateStats({
        platforms: readPlatformNames(config),
        rows,
        today: store.todayKey(),
      });
      const response: PlatformStatsResponse = {
        stats,
        rankedCount: stats.filter(entry => entry.rank !== null).length,
        generatedAt: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error(`Failed to build platform stats: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/visits', async (req, res) => {
    try {
      const platform = req.body?.platform;
      if (typeof platform !== 'string' || !platform.trim()) {
        res.status(400).json({ error: 'platform is required' });
        return;
      }
      if (!readPlatformNames(config).includes(platform)) {
        res.status(400).json({ error: `Unknown platform: ${platform}` });
        return;
      }

      const userRef = await tryGetUserRef(req);
      if (!userRef) {
        res.status(403).json({ error: 'Authentication required' });
        return;
      }

      await store.recordVisit(platform, userRef);
      res.status(204).end();
    } catch (error) {
      logger.error(`Failed to record platform visit: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
