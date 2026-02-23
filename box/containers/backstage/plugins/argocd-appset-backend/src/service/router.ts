import { Router } from 'express';
import express from 'express';
import { LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { ApplicationSetService } from './ApplicationSetService';
import { AppSetCache } from './AppSetCache';

export interface RouterOptions {
  service: ApplicationSetService;
  cache: AppSetCache;
  logger: LoggerService;
  config: Config;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { service, cache, logger, config } = options;

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/status', (_, res) => {
    const cron = config.getOptionalString('argocdApplicationSet.schedule.cron') ?? '0 10-11,14-18 * * 1-5';
    const fetchCron = config.getOptionalString('argocdApplicationSet.schedule.fetchCron') ?? '* * * * *';
    const slackConfigured = !!config.getOptionalString('argocdApplicationSet.slack.webhookUrl');
    const lastFetchedAt = cache.getLastFetchedAt();
    res.json({ cron, fetchCron, slackConfigured, lastFetchedAt });
  });

  router.get('/application-sets', (_, res) => {
    res.json(cache.getAppSets());
  });

  router.post('/application-sets/:namespace/:name/mute', async (req, res) => {
    const { namespace, name } = req.params;
    try {
      await service.setMuted(namespace, name, true);
      const appSets = await service.listApplicationSets();
      cache.update(appSets);
      res.json({ status: 'muted' });
    } catch (error) {
      logger.error(`Failed to mute ${namespace}/${name}: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/application-sets/:namespace/:name/unmute', async (req, res) => {
    const { namespace, name } = req.params;
    try {
      await service.setMuted(namespace, name, false);
      const appSets = await service.listApplicationSets();
      cache.update(appSets);
      res.json({ status: 'unmuted' });
    } catch (error) {
      logger.error(`Failed to unmute ${namespace}/${name}: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
