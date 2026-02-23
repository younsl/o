import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { ApplicationSetService } from './service/ApplicationSetService';
import { SlackNotifier } from './service/SlackNotifier';
import { AppSetCache } from './service/AppSetCache';

export const argocdAppsetPlugin = createBackendPlugin({
  pluginId: 'argocd-appset',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        scheduler: coreServices.scheduler,
      },
      async init({ httpRouter, logger, config, scheduler }) {
        const enabled = config.getOptionalBoolean('argocdApplicationSet.enabled') ?? true;
        if (!enabled) {
          logger.info('ArgoCD AppSet backend plugin is disabled via config');
          return;
        }

        logger.info('Initializing ArgoCD AppSet backend plugin');

        const appsetService = new ApplicationSetService({ config, logger });
        const slackNotifier = new SlackNotifier({ config, logger });
        const cache = new AppSetCache();

        const router = await createRouter({ service: appsetService, cache, logger, config });

        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/status',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/application-sets',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/application-sets/*',
          allow: 'unauthenticated',
        });

        // Background task: periodically fetch ApplicationSets and update cache
        const fetchCron = config.getOptionalString('argocdApplicationSet.schedule.fetchCron') ?? '* * * * *';
        await scheduler.scheduleTask({
          id: 'argocd-appset-fetch',
          frequency: { cron: fetchCron },
          timeout: { minutes: 2 },
          initialDelay: { seconds: 10 },
          fn: async () => {
            try {
              const appSets = await appsetService.listApplicationSets();
              cache.update(appSets);
              logger.debug(`Fetched ${appSets.length} ApplicationSets`);
            } catch (error) {
              logger.error(`Background fetch failed: ${error}`);
            }
          },
        });

        // Background task: Slack notification for non-HEAD revisions
        const webhookUrl = config.getOptionalString('argocdApplicationSet.slack.webhookUrl');
        if (webhookUrl) {
          const notifyCron = config.getOptionalString('argocdApplicationSet.schedule.cron') ?? '0 10-11,14-18 * * 1-5';
          await scheduler.scheduleTask({
            id: 'argocd-appset-notify',
            frequency: { cron: notifyCron },
            timeout: { minutes: 5 },
            initialDelay: { seconds: 30 },
            fn: async () => {
              try {
                const appSets = cache.getAppSets();
                const nonHeadAppSets = appSets.filter(a => !a.isHeadRevision && !a.muted);
                if (nonHeadAppSets.length > 0) {
                  await slackNotifier.notify(nonHeadAppSets);
                  logger.info(`Notified Slack about ${nonHeadAppSets.length} non-HEAD ApplicationSets`);
                }
              } catch (error) {
                logger.error(`Slack notification failed: ${error}`);
              }
            },
          });
        }

        logger.info('ArgoCD AppSet backend plugin initialized');
      },
    });
  },
});

export default argocdAppsetPlugin;
