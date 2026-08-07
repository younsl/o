import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { parseExpression } from 'cron-parser';
import { createRouter, readWebhookFromConfig, tokenKey } from './service/router';
import { GitlabTokenService } from './service/GitlabTokenService';
import { TokenCache } from './service/TokenCache';
import { NotifiedStore } from './service/NotifiedStore';
import { WebhookNotifier } from './service/WebhookNotifier';

export const gitlabTokenAuditPlugin = createBackendPlugin({
  pluginId: 'gitlab-token-audit',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        scheduler: coreServices.scheduler,
        database: coreServices.database,
        httpAuth: coreServices.httpAuth,
      },
      async init({
        httpRouter,
        logger,
        config,
        scheduler,
        database,
        httpAuth,
      }) {
        const enabled =
          config.getOptionalBoolean('app.plugins.gitlabTokenAudit') ?? true;
        if (!enabled) {
          logger.info('GitLab Token Audit backend plugin disabled via config');
          return;
        }

        logger.info('Initializing GitLab Token Audit backend plugin');

        const cache = new TokenCache();
        const gitlabTokenService = new GitlabTokenService({ config, logger });
        const webhookNotifier = new WebhookNotifier({ logger, config });

        const knex = await database.getClient();
        const notifiedStore = await NotifiedStore.create({ database: knex });

        const bootWebhook = readWebhookFromConfig(config);
        if (bootWebhook) {
          logger.info(
            `[gitlab-token-audit] webhook loaded from app-config (enabled=${bootWebhook.enabled}, days=[${bootWebhook.daysBefore.join(',')}])`,
          );
        } else {
          logger.info(
            '[gitlab-token-audit] no webhook configured in app-config; notifications disabled',
          );
        }

        const fetchCron =
          config.getOptionalString('gitlabTokenAudit.schedule.fetchCron') ??
          '0 */6 * * *';
        const notifyCron =
          config.getOptionalString('gitlabTokenAudit.schedule.notifyCron') ??
          '0 9 * * *';
        const timezone =
          config.getOptionalString('gitlabTokenAudit.schedule.timezone') ??
          'UTC';

        const performScan = async () => {
          const tokens = await gitlabTokenService.listAllTokens();
          cache.update(tokens);
          logger.info(`[gitlab-token-audit] fetched ${tokens.length} tokens`);
        };

        const performNotify = async () => {
          const webhook = readWebhookFromConfig(config);
          if (!webhook || !webhook.enabled || !webhook.url) return;

          const tokens = cache.getTokens();
          for (const token of tokens) {
            if (token.state !== 'active') continue;
            if (!token.expiresAt || token.daysUntilExpiry === null) continue;
            if (token.daysUntilExpiry < 0) continue;

            // Match the smallest threshold the token has just crossed: highest
            // configured threshold >= daysUntilExpiry.
            const sorted = [...webhook.daysBefore].sort((a, b) => a - b);
            const matched = sorted.find(t => token.daysUntilExpiry! <= t);
            if (matched === undefined) continue;

            const key = tokenKey(token);
            const already = await notifiedStore.hasNotified(
              key,
              matched,
              token.expiresAt,
            );
            if (already) continue;

            try {
              await webhookNotifier.send(webhook.url, {
                token,
                threshold: matched,
                daysUntilExpiry: token.daysUntilExpiry,
              });
              await notifiedStore.record({
                tokenKey: key,
                threshold: matched,
                expiresAt: token.expiresAt,
                status: 'success',
              });
            } catch (err) {
              logger.warn(
                `[gitlab-token-audit] webhook send failed for ${key}: ${err}`,
              );
              await notifiedStore.record({
                tokenKey: key,
                threshold: matched,
                expiresAt: token.expiresAt,
                status: 'failed',
                errorMessage: err instanceof Error ? err.message : String(err),
              });
            }
          }
        };

        const router = await createRouter({
          cache,
          logger,
          config,
          notifiedStore,
          webhookNotifier,
          gitlabTokenService,
          httpAuth,
          triggerScan: performScan,
        });
        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
        httpRouter.addAuthPolicy({
          path: '/admin-status',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({ path: '/status', allow: 'unauthenticated' });
        httpRouter.addAuthPolicy({ path: '/tokens', allow: 'unauthenticated' });
        httpRouter.addAuthPolicy({ path: '/refresh', allow: 'unauthenticated' });
        httpRouter.addAuthPolicy({ path: '/webhook', allow: 'unauthenticated' });
        httpRouter.addAuthPolicy({
          path: '/notifications',
          allow: 'unauthenticated',
        });

        // Backstage scheduler's cron is UTC-only. Fire every minute and gate
        // by a timezone-aware cron-parser check so wall-clock crons like
        // '0 */6 * * *' fire at 00:00/06:00/... in the configured timezone.
        logger.info(
          `[gitlab-token-audit] fetch cron='${fetchCron}' timezone='${timezone}'`,
        );
        await scheduler.scheduleTask({
          id: 'gitlab-token-audit-fetch',
          frequency: { cron: '* * * * *' },
          timeout: { minutes: 10 },
          initialDelay: { seconds: 20 },
          fn: async () => {
            try {
              const now = new Date();
              const interval = parseExpression(fetchCron, {
                tz: timezone,
                currentDate: now,
              });
              const prev = interval.prev().toDate();
              if (now.getTime() - prev.getTime() > 60_000) {
                return;
              }
              await performScan();
            } catch (err) {
              logger.error(`[gitlab-token-audit] scan failed: ${err}`);
            }
          },
        });

        // Backstage cron scheduler does NOT run "immediately" on boot — it
        // waits for the next cron fire. Kick off a one-shot initial scan in
        // the background so the cache is populated on cold start.
        setTimeout(() => {
          performScan().catch(err =>
            logger.warn(`[gitlab-token-audit] initial scan failed: ${err}`),
          );
        }, 5_000);

        // Backstage scheduler's cron is UTC-only. Fire every minute and gate
        // by a timezone-aware cron-parser check so wall-clock crons like
        // '0 9 * * *' fire at 09:00 in the configured timezone.
        logger.info(
          `[gitlab-token-audit] notify cron='${notifyCron}' timezone='${timezone}'`,
        );
        await scheduler.scheduleTask({
          id: 'gitlab-token-audit-notify',
          frequency: { cron: '* * * * *' },
          timeout: { minutes: 10 },
          initialDelay: { seconds: 60 },
          fn: async () => {
            try {
              const now = new Date();
              const interval = parseExpression(notifyCron, {
                tz: timezone,
                currentDate: now,
              });
              const prev = interval.prev().toDate();
              if (now.getTime() - prev.getTime() > 60_000) {
                return;
              }
              await performNotify();
            } catch (err) {
              logger.error(`[gitlab-token-audit] notify failed: ${err}`);
            }
          },
        });

        logger.info('GitLab Token Audit backend plugin initialized');
      },
    });
  },
});

export default gitlabTokenAuditPlugin;
