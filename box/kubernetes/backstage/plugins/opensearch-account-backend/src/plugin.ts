import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { AccountRequestStore } from './service/AccountRequestStore';
import { OpenSearchSecurityClient } from './service/OpenSearchClient';

export const opensearchAccountPlugin = createBackendPlugin({
  pluginId: 'opensearch-account',
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
        const enabled =
          config.getOptionalBoolean('app.plugins.opensearchAccount') ?? true;
        if (!enabled) {
          logger.info('OpenSearch Account backend plugin is disabled via config');
          return;
        }

        logger.info('Initializing OpenSearch Account backend plugin');

        const knex = await database.getClient();
        const store = await AccountRequestStore.create({ database: knex });
        const client = OpenSearchSecurityClient.fromConfig(config, logger);
        if (!client) {
          logger.warn(
            'OpenSearch Account: opensearchAccount.endpoint/username/password not set; account operations will return 503',
          );
        }

        const router = await createRouter({ logger, config, httpAuth, store, client });
        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });

        logger.info('OpenSearch Account backend plugin initialized');
      },
    });
  },
});

export default opensearchAccountPlugin;
