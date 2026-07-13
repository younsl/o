import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { S3LogService } from './service/S3LogService';
import { ExtractionQueue } from './service/ExtractionQueue';
import { RequestStore, APPROVAL_TIMEOUT_HOURS } from './service/RequestStore';

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
        scheduler: coreServices.scheduler,
      },
      async init({
        httpRouter,
        logger,
        config,
        database,
        httpAuth,
        scheduler,
      }) {
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

        // Extractions do not survive restarts; without this, rows from a
        // crashed run (e.g. OOM kill) would show as 'extracting' forever.
        const interrupted = await store.failInterruptedExtractions();
        if (interrupted > 0) {
          logger.warn(
            `Marked ${interrupted} extraction(s) as failed (interrupted by restart)`,
          );
        }

        const extractionQueue = new ExtractionQueue({
          store,
          s3LogService,
          logger,
        });

        // Resume requests that were approved (queued) before the restart.
        extractionQueue.pump();

        const router = await createRouter({
          logger,
          config,
          store,
          s3LogService,
          extractionQueue,
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
          path: '/precheck',
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

        // Safety net: pump() is triggered on every approval and at startup,
        // but a drain aborted by a transient DB error would otherwise leave
        // approved requests waiting until the next approval.
        await scheduler.scheduleTask({
          id: 's3-log-extract-queue-pump',
          frequency: { minutes: 1 },
          timeout: { seconds: 30 },
          initialDelay: { seconds: 30 },
          fn: async () => {
            extractionQueue.pump();
          },
        });

        await scheduler.scheduleTask({
          id: 's3-log-extract-auto-reject',
          frequency: { minutes: 5 },
          timeout: { minutes: 2 },
          initialDelay: { seconds: 30 },
          fn: async () => {
            try {
              const expired = await store.listPendingExpired();
              if (expired.length === 0) return;
              for (const req of expired) {
                await store.updateStatus(req.id, 'rejected', {
                  reviewerRef: 'system:auto-reject',
                  reviewComment: `Automatically rejected after ${APPROVAL_TIMEOUT_HOURS} hours without approval`,
                });
                logger.info(
                  `Auto-rejected request [${req.id}] (pending > ${APPROVAL_TIMEOUT_HOURS} hours)`,
                );
              }
            } catch (error) {
              logger.error(`Auto-reject task failed: ${error}`);
            }
          },
        });

        logger.info('S3 Log Extract backend plugin initialized');
      },
    });
  },
});

export default s3LogExtractPlugin;
