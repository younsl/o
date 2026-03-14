import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { OpenCostService } from './service/OpenCostService';
import { OpenCostCostStore } from './service/OpenCostCostStore';
import { OpenCostCollector } from './service/OpenCostCollector';

export const opencostPlugin = createBackendPlugin({
  pluginId: 'opencost',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
      },
      async init({ httpRouter, logger, config, database, scheduler }) {
        const enabled = config.getOptionalBoolean('app.plugins.opencost') ?? true;
        if (!enabled) {
          logger.info('OpenCost backend plugin is disabled via config');
          return;
        }

        logger.info('Initializing OpenCost backend plugin');

        const service = OpenCostService.fromConfig(config, logger);

        // Initialize database store
        const knex = await database.getClient();
        const costStore = await OpenCostCostStore.create({ database: knex });
        logger.info('OpenCost database tables initialized');

        // Initialize collector with scheduled tasks
        const collector = new OpenCostCollector(costStore, config, logger);
        await collector.registerTasks(scheduler);

        const router = await createRouter({ service, costStore, logger });

        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/allocation',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/costs',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/costs/daily-summary',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/costs/daily',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/costs/pods',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/costs/collection-runs',
          allow: 'unauthenticated',
        });

        logger.info('OpenCost backend plugin initialized');
      },
    });
  },
});
