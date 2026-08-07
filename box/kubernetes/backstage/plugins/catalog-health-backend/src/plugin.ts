import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { CatalogHealthService } from './service/CatalogHealthService';
import { CoverageHistoryStore } from './service/CoverageHistoryStore';

export const catalogHealthPlugin = createBackendPlugin({
  pluginId: 'catalog-health',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        scheduler: coreServices.scheduler,
        database: coreServices.database,
      },
      async init({ httpRouter, httpAuth, logger, config, scheduler, database }) {
        const enabled = config.getOptionalBoolean('app.plugins.catalogHealth') ?? true;
        if (!enabled) {
          logger.info('GitLab Coverage plugin disabled via config');
          return;
        }

        const knex = await database.getClient();
        const historyStore = await CoverageHistoryStore.create({ database: knex });

        const service = new CatalogHealthService({ config, logger, historyStore });

        const router = await createRouter({ service, logger, config, httpAuth, historyStore });
        httpRouter.use(router as any);

        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });

        // Schedule periodic scan
        const scanCron = config.getOptionalString('catalogHealth.schedule.cron') ?? '0 * * * *';
        await scheduler.scheduleTask({
          id: 'catalog-health-scan',
          frequency: { cron: scanCron },
          timeout: { minutes: 30 },
          initialDelay: { seconds: 30 },
          fn: async () => {
            logger.info('Running scheduled GitLab coverage scan');
            await service.scan();
          },
        });

        logger.info('GitLab Coverage plugin initialized');
      },
    });
  },
});
