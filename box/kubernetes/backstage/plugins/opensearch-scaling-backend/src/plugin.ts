import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { ScalingRequestStore } from './service/ScalingRequestStore';
import { OpenSearchServiceClient } from './service/OpenSearchServiceClient';
import { registerScheduler } from './service/scheduler';

const DEFAULT_TIMEZONES = ['Asia/Seoul', 'UTC'];

export const opensearchScalingPlugin = createBackendPlugin({
  pluginId: 'opensearch-scaling',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        httpAuth: coreServices.httpAuth,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
      },
      async init({ httpRouter, logger, config, httpAuth, database, scheduler }) {
        const enabled =
          config.getOptionalBoolean('app.plugins.opensearchScaling') ?? true;
        if (!enabled) {
          logger.info('OpenSearch Scaling backend plugin is disabled via config');
          return;
        }

        logger.info('Initializing OpenSearch Scaling backend plugin');

        const knex = await database.getClient();
        const store = await ScalingRequestStore.create({ database: knex });
        const client = OpenSearchServiceClient.fromConfig(config, logger);

        const instanceTypes =
          config.getOptionalStringArray('opensearchScaling.instanceTypes') ?? [];
        const timezones =
          config.getOptionalStringArray('opensearchScaling.timezones') ??
          DEFAULT_TIMEZONES;
        const defaultTimezone =
          config.getOptionalString('opensearchScaling.defaultTimezone') ??
          'Asia/Seoul';
        const graceHours =
          config.getOptionalNumber('opensearchScaling.executionGraceHours') ?? 2;

        const router = await createRouter({
          logger,
          config,
          httpAuth,
          store,
          client,
          instanceTypes,
          timezones,
          defaultTimezone,
        });
        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });

        await registerScheduler({ logger, scheduler, store, client, graceHours });

        logger.info('OpenSearch Scaling backend plugin initialized');
      },
    });
  },
});

export default opensearchScalingPlugin;
