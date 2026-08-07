import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { parseExpression } from 'cron-parser';
import { createRouter } from './service/router';
import { ForkliftCoverageService } from './service/ForkliftCoverageService';
import { CoverageHistoryStore } from './service/CoverageHistoryStore';
import { SettingsStore } from './service/SettingsStore';
import { ResultStore } from './service/ResultStore';
import { ExclusionStore } from './service/ExclusionStore';
import { SlackNotifier, buildSummaryText } from './service/SlackNotifier';

export const forkliftCoveragePlugin = createBackendPlugin({
  pluginId: 'forklift-coverage',
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
        const enabled =
          config.getOptionalBoolean('app.plugins.forkliftCoverage') ?? true;
        if (!enabled) {
          logger.info('Forklift Coverage plugin disabled via config');
          return;
        }

        const knex = await database.getClient();
        const historyStore = await CoverageHistoryStore.create({
          database: knex,
        });
        const settingsStore = await SettingsStore.create({ database: knex });
        const resultStore = await ResultStore.create({ database: knex });
        const exclusionStore = await ExclusionStore.create({ database: knex });
        const service = new ForkliftCoverageService({
          config,
          logger,
          settingsStore,
          resultStore,
          exclusionStore,
          historyStore,
        });
        await service.refreshSettings();
        await service.refreshExclusions();
        await service.restoreLastResult();
        const notifier = new SlackNotifier({ logger });

        const router = await createRouter({
          service,
          historyStore,
          settingsStore,
          notifier,
          logger,
          config,
          httpAuth,
        });
        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });

        const runScanAndNotify = async () => {
          await service.scan();
          const webhook = await service.getEffectiveWebhook();
          if (!webhook.url || !webhook.enabled) return;
          try {
            const coverage = service.getCoverage();
            await notifier.send(
              webhook.url,
              buildSummaryText(coverage, service.getNotAppliedProjects()),
            );
          } catch (err) {
            // A failed notification must not fail the scan itself.
            logger.warn(`[forklift-coverage] slack notify failed: ${err}`);
          }
        };

        const boot = service.getSchedule();
        logger.info(
          `[forklift-coverage] scan cron='${boot.cron}' timezone='${boot.timezone}' auto=${boot.autoScanEnabled} forkliftHost='${service.getForkliftHost() ?? 'not configured'}'`,
        );

        // Backstage's scheduler evaluates cron in UTC only, and the schedule
        // itself is editable at runtime. Fire every minute and gate on a
        // timezone-aware check against whatever the current settings say, so a
        // wall-clock cron like '0 10 * * 1-5' fires at 10:00 locally and an
        // edit in the wizard takes effect without a restart.
        await scheduler.scheduleTask({
          id: 'forklift-coverage-scan',
          frequency: { cron: '* * * * *' },
          timeout: { minutes: 60 },
          initialDelay: { seconds: 30 },
          fn: async () => {
            try {
              const schedule = service.getSchedule();
              if (!schedule.autoScanEnabled || !service.isConfigured()) return;
              const now = new Date();
              const interval = parseExpression(schedule.cron, {
                tz: schedule.timezone,
                currentDate: now,
              });
              const prev = interval.prev().toDate();
              if (now.getTime() - prev.getTime() > 60_000) return;
              await runScanAndNotify();
            } catch (err) {
              logger.error(`[forklift-coverage] scheduled scan failed: ${err}`);
            }
          },
        });

        // Results are persisted, so a restart already has something to show
        // and must not trigger a scan of its own. Only a first run, with no
        // stored result at all, seeds the page in the background.
        const scanOnStart =
          config.getOptionalBoolean('forkliftCoverage.schedule.scanOnStart') ??
          true;
        const hasStoredResult = !!service.getCoverage().lastScannedAt;
        if (scanOnStart && service.isConfigured() && !hasStoredResult) {
          setTimeout(() => {
            service
              .scan()
              .catch(err =>
                logger.warn(`[forklift-coverage] initial scan failed: ${err}`),
              );
          }, 10_000);
        }

        logger.info('Forklift Coverage plugin initialized');
      },
    });
  },
});

export default forkliftCoveragePlugin;
