import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { readPlatformNames } from './service/platformNames';
import { VisitStore } from './service/VisitStore';

export const platformsPlugin = createBackendPlugin({
  pluginId: 'platforms',
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
      async init({
        httpRouter,
        httpAuth,
        logger,
        config,
        scheduler,
        database,
      }) {
        // No enable flag: the Platforms page is always mounted, so its stats
        // backend follows it without an app-config opt-in.
        const timezone =
          config.getOptionalString('platforms.timezone') ?? 'Asia/Seoul';
        const knex = await database.getClient();
        const store = await VisitStore.create({ database: knex, timezone });

        const router = await createRouter({ store, logger, config, httpAuth });
        httpRouter.use(router as any);

        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });

        await scheduler.scheduleTask({
          id: 'platforms-visit-purge',
          // Interval rather than cron so a redeploy that drops a platform from
          // app-config clears its rows within the hour, not at the next 03:00.
          frequency: { hours: 6 },
          timeout: { minutes: 10 },
          initialDelay: { minutes: 1 },
          fn: async () => {
            const expired = await store.purgeExpired();
            if (expired > 0) {
              logger.info(`Purged ${expired} expired platform visit rows`);
            }
            // Reads the config each run rather than at init, so a platform
            // removed from app-config is cleaned up on the next redeploy.
            const orphaned = await store.purgeUnknownPlatforms(
              readPlatformNames(config),
            );
            if (orphaned > 0) {
              logger.info(
                `Purged ${orphaned} visit rows for platforms no longer in the catalog`,
              );
            }
          },
        });

        logger.info(`Platforms plugin initialized (timezone: ${timezone})`);
      },
    });
  },
});
