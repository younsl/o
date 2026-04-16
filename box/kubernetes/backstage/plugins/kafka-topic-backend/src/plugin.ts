import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { TopicRequestStore } from './service/TopicRequestStore';

export const kafkaTopicPlugin = createBackendPlugin({
  pluginId: 'kafka-topic',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        httpAuth: coreServices.httpAuth,
        database: coreServices.database,
      },
      async init({ httpRouter, logger, config, httpAuth, database }) {
        const enabled = config.getOptionalBoolean('app.plugins.kafkaTopic') ?? true;
        if (!enabled) {
          logger.info('Kafka Topic backend plugin is disabled via config');
          return;
        }

        logger.info('Initializing Kafka Topic backend plugin');

        const knex = await database.getClient();
        const store = await TopicRequestStore.create({ database: knex });

        const router = await createRouter({ logger, config, httpAuth, store });

        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/clusters',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/clusters/*',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/topics',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/topics/*',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/user-role',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/requests',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/requests/*',
          allow: 'unauthenticated',
        });

        logger.info('Kafka Topic backend plugin initialized');
      },
    });
  },
});

export default kafkaTopicPlugin;
