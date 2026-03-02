import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { IamUserService } from './service/IamUserService';
import { SlackNotifier } from './service/SlackNotifier';
import { IamUserCache } from './service/IamUserCache';
import { PasswordResetStore } from './service/PasswordResetStore';
import { WarningDmStore } from './service/WarningDmStore';
import { parseExpression } from 'cron-parser';

export const iamUserAuditPlugin = createBackendPlugin({
  pluginId: 'iam-user-audit',
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
          config.getOptionalBoolean('app.plugins.iamUserAudit') ?? true;
        if (!enabled) {
          logger.info(
            'IAM User Audit backend plugin is disabled via config',
          );
          return;
        }

        logger.info('Initializing IAM User Audit backend plugin');

        const inactiveDays =
          config.getOptionalNumber('iamUserAudit.inactiveDays') ?? 90;
        const iamUserService = new IamUserService({ config, logger });
        const slackNotifier = new SlackNotifier({ config, logger });
        const cache = new IamUserCache();

        // Initialize database stores
        const knex = await database.getClient();
        const store = await PasswordResetStore.create({ database: knex });
        const warningDmStore = await WarningDmStore.create({ database: knex });

        const router = await createRouter({
          cache,
          logger,
          config,
          store,
          warningDmStore,
          iamUserService,
          slackNotifier,
          httpAuth,
        });

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
          path: '/status/*',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/users',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/password-reset/*',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/admin/*',
          allow: 'unauthenticated',
        });

        // Background task: periodically fetch IAM users and update cache
        const fetchCron =
          config.getOptionalString('iamUserAudit.schedule.fetchCron') ??
          '*/5 * * * *';
        await scheduler.scheduleTask({
          id: 'iam-user-audit-fetch',
          frequency: { cron: fetchCron },
          timeout: { minutes: 5 },
          initialDelay: { seconds: 15 },
          fn: async () => {
            try {
              const users = await iamUserService.listUsers();
              cache.update(users);
              logger.info(`Fetched ${users.length} IAM users`);
            } catch (error) {
              logger.error(`Background IAM user fetch failed: ${error}`);
            }
          },
        });

        // Background task: Slack notification for inactive users
        const webhookUrl = config.getOptionalString(
          'iamUserAudit.slack.webhookUrl',
        );
        if (webhookUrl) {
          const notifyCron =
            config.getOptionalString('iamUserAudit.schedule.cron') ??
            '0 10 * * 1-5';
          await scheduler.scheduleTask({
            id: 'iam-user-audit-notify',
            frequency: { cron: notifyCron },
            timeout: { minutes: 5 },
            initialDelay: { seconds: 30 },
            fn: async () => {
              try {
                // Guard against Backstage scheduler firing immediately after pod
                // restart regardless of the cron expression (overdue task catchup).
                const now = new Date();
                const interval = parseExpression(notifyCron, { utc: true });
                const prev = interval.prev().toDate();
                const diffMs = now.getTime() - prev.getTime();
                if (diffMs > 60_000) {
                  logger.info(
                    `Skipped Slack notification: ${now.toISOString()} is outside cron schedule`,
                  );
                  return;
                }

                const allUsers = cache.getUsers();
                const inactiveUsers = allUsers.filter(
                  u => u.inactiveDays >= inactiveDays,
                );
                if (inactiveUsers.length > 0) {
                  await slackNotifier.notify(inactiveUsers, inactiveDays);
                  logger.info(
                    `Notified Slack about ${inactiveUsers.length} inactive IAM users`,
                  );
                }
              } catch (error) {
                logger.error(`Slack notification failed: ${error}`);
              }
            },
          });
        }

        // Background task: DM warning for users approaching threshold (14 days remaining)
        const botToken = config.getOptionalString('iamUserAudit.slack.botToken');
        if (botToken) {
          const warningDays =
            config.getOptionalNumber('iamUserAudit.warningDays') ?? 14;
          const emailDomain = config.getOptionalString('iamUserAudit.slack.emailDomain') ?? '';

          const deriveEmail = (userName: string): string => {
            if (userName.includes('@')) return userName;
            if (!emailDomain) return userName;
            return `${userName}@${emailDomain}`;
          };

          const warningCron =
            config.getOptionalString('iamUserAudit.schedule.warningCron') ??
            '0 10 * * 1-5';
          await scheduler.scheduleTask({
            id: 'iam-user-audit-warning-dm',
            frequency: { cron: warningCron },
            timeout: { minutes: 5 },
            initialDelay: { seconds: 45 },
            fn: async () => {
              try {
                const now = new Date();
                const interval = parseExpression(warningCron, { utc: true });
                const prev = interval.prev().toDate();
                const diffMs = now.getTime() - prev.getTime();
                if (diffMs > 60_000) {
                  logger.info(
                    `Skipped warning DM: ${now.toISOString()} is outside cron schedule`,
                  );
                  return;
                }

                const warningThreshold = inactiveDays - warningDays;
                if (warningThreshold <= 0) return;

                const allUsers = cache.getUsers();
                const candidates = allUsers.filter(
                  u => u.inactiveDays >= warningThreshold,
                );

                for (const user of candidates) {
                  // DB-based dedup: skip if already sent successfully today
                  const alreadySent = await warningDmStore.hasSuccessToday(user.userName);
                  if (alreadySent) continue;

                  const email = deriveEmail(user.userName);
                  const slackUser = await slackNotifier.lookupSlackUser(email);
                  if (!slackUser) continue;

                  try {
                    await slackNotifier.sendStatusDm(
                      email,
                      user,
                      user.inactiveDays,
                      'system',
                      `Your IAM account has been inactive for *${user.inactiveDays} days*. The inactivity threshold is *${inactiveDays} days* (*${inactiveDays - user.inactiveDays} days remaining*). Please take action to avoid account restrictions.`,
                    );
                    await warningDmStore.recordDm({
                      iamUserName: user.userName,
                      senderRef: 'system',
                      platform: 'slack',
                      status: 'success',
                    });
                    logger.info(`[warning-dm] Sent warning DM to ${email} for ${user.userName} (${user.inactiveDays}d inactive)`);
                  } catch (err) {
                    await warningDmStore.recordDm({
                      iamUserName: user.userName,
                      senderRef: 'system',
                      platform: 'slack',
                      status: 'failed',
                      errorMessage: err instanceof Error ? err.message : String(err),
                    });
                    logger.warn(`[warning-dm] Failed to send warning DM to ${email}: ${err}`);
                  }
                }
              } catch (error) {
                logger.error(`Warning DM task failed: ${error}`);
              }
            },
          });
        }

        logger.info('IAM User Audit backend plugin initialized');
      },
    });
  },
});

export default iamUserAuditPlugin;
