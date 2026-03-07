import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { S3LogService } from './service/S3LogService';
import { RequestStore } from './service/RequestStore';

export const s3LogExtractPlugin = createBackendPlugin({
  pluginId: 's3-log-extract',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        database: coreServices.database,
        httpAuth: coreServices.httpAuth,
      },
      async init({ httpRouter, logger, config, database, httpAuth }) {
        const enabled =
          config.getOptionalBoolean('app.plugins.s3LogExtract') ?? true;
        if (!enabled) {
          logger.info(
            'S3 Log Extract backend plugin is disabled via config',
          );
          return;
        }

        logger.info('Initializing S3 Log Extract backend plugin');

        const bucket = config.getOptionalString('s3LogExtract.bucket');
        if (!bucket) {
          logger.warn(
            'S3 Log Extract: s3LogExtract.bucket is not configured, plugin will start without S3 access',
          );
        }

        const s3LogService = new S3LogService({ config, logger });

        const knex = await database.getClient();
        const store = await RequestStore.create({ database: knex });

        const router = await createRouter({
          logger,
          config,
          store,
          s3LogService,
          httpAuth,
        });

        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/config',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/s3-health',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/apps',
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
        httpRouter.addAuthPolicy({
          path: '/admin-status',
          allow: 'unauthenticated',
        });

        logger.info('S3 Log Extract backend plugin initialized');
      },
    });
  },
});

export default s3LogExtractPlugin;
