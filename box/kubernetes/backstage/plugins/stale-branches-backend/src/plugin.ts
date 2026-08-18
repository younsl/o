import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import {
  StaleBranchesService,
  branchKey,
  isDueNow,
} from './service/StaleBranchesService';
import { ConnectionStore } from './service/ConnectionStore';
import { ScheduleStore } from './service/ScheduleStore';
import { RunStore } from './service/RunStore';
import { NotifiedStore } from './service/NotifiedStore';
import { SlackNotifier, buildBranchText } from './service/SlackNotifier';
import { BranchSchedule, RunDetail, StaleBranch } from './service/types';

/** Notification records older than this are of no further use. */
const NOTIFIED_RETENTION_DAYS = 180;

/** Gap between messages. Slack throttles an incoming webhook at about 1/second. */
const SLACK_SEND_INTERVAL_MS = 1_100;

export const staleBranchesPlugin = createBackendPlugin({
  pluginId: 'stale-branches',
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
          config.getOptionalBoolean('app.plugins.staleBranches') ?? true;
        if (!enabled) {
          logger.info('Stale Branches plugin disabled via config');
          return;
        }

        const knex = await database.getClient();
        const connectionStore = await ConnectionStore.create({ database: knex });
        const scheduleStore = await ScheduleStore.create({ database: knex });
        const runStore = await RunStore.create({ database: knex });
        const notifiedStore = await NotifiedStore.create({ database: knex });

        const service = new StaleBranchesService({
          config,
          logger,
          connectionStore,
          runStore,
        });
        await service.refreshConnection();

        // A run only leaves the running state from the process that started it,
        // so anything still running at boot died with the previous process.
        const orphans = await runStore.failOrphans();
        if (orphans > 0) {
          logger.warn(
            `[stale-branches] marked ${orphans} interrupted runs as failed`,
          );
        }

        const notifier = new SlackNotifier({ logger });

        /**
         * Posts one message per branch that has not been reported at its
         * current tip commit, so a branch nobody touches is mentioned once
         * instead of on every run.
         */
        const sendReport = async (
          schedule: BranchSchedule,
          run: RunDetail,
          dryRun = false,
        ): Promise<{ sent: number; skipped: number; failed: number }> => {
          if (!schedule.webhookUrl || !schedule.webhookEnabled) {
            return { sent: 0, skipped: 0, failed: 0 };
          }

          const fresh: StaleBranch[] = [];
          let skipped = 0;
          for (const branch of run.branches) {
            const key = branchKey(branch);
            if (
              await notifiedStore.hasNotified(
                schedule.id,
                key,
                branch.lastCommitAt,
              )
            ) {
              skipped++;
              continue;
            }
            fresh.push(branch);
          }

          if (fresh.length === 0) {
            logger.info(
              `[stale-branches] '${schedule.name}' has nothing new to report, ${skipped} already notified`,
            );
            return { sent: 0, skipped, failed: 0 };
          }

          // A dry run stops here. It records what would have gone out and
          // leaves the dedupe log alone, so the next real run still reports
          // every branch this one only counted.
          if (dryRun) {
            await runStore.recordNotified(run.id, fresh.length);
            logger.info(
              `[stale-branches] '${schedule.name}' dry run would report ${fresh.length} branches, ${skipped} already notified`,
            );
            return { sent: 0, skipped, failed: 0 };
          }

          let sent = 0;
          let failed = 0;
          for (const branch of fresh) {
            try {
              await notifier.send(
                schedule.webhookUrl,
                buildBranchText({
                  branch,
                  thresholdDays: schedule.thresholdDays,
                  timezone: schedule.timezone,
                }),
              );
              // Recorded per branch, right after its own message lands, so a
              // failure part way through neither loses what was delivered nor
              // marks as delivered what was not.
              await notifiedStore.record(
                schedule.id,
                branchKey(branch),
                branch.lastCommitAt,
              );
              sent++;
            } catch (err) {
              failed++;
              logger.warn(
                `[stale-branches] '${schedule.name}' could not report ${branch.projectPath}@${branch.name}: ${err}`,
              );
            }
            // Slack rejects a burst on an incoming webhook, and a report can
            // carry dozens of branches on its first run, so the loop paces
            // itself rather than relying on the retry path.
            if (branch !== fresh[fresh.length - 1]) {
              await new Promise(resolve =>
                setTimeout(resolve, SLACK_SEND_INTERVAL_MS),
              );
            }
          }

          await runStore.recordNotified(run.id, sent);
          logger.info(
            `[stale-branches] '${schedule.name}' reported ${sent} branches, ${skipped} already notified, ${failed} failed`,
          );
          return { sent, skipped, failed };
        };

        const runAndNotify = async (
          schedule: BranchSchedule,
          triggeredBy: string,
          dryRun = false,
        ) => {
          const run = await service.run(schedule, triggeredBy, dryRun);
          try {
            const outcome = await sendReport(schedule, run, dryRun);
            return { staleCount: run.staleCount, ...outcome };
          } catch (err) {
            // A failed notification must not fail the run that produced it.
            logger.warn(
              `[stale-branches] slack notify for '${schedule.name}' failed: ${err}`,
            );
            return { staleCount: run.staleCount, sent: 0, skipped: 0, failed: 0 };
          }
        };

        const notifyLatest = async (schedule: BranchSchedule) => {
          const latest = await runStore.latestFinished(schedule.id);
          if (!latest) return { sent: 0, skipped: 0, failed: 0 };
          return sendReport(schedule, latest);
        };

        const router = await createRouter({
          service,
          connectionStore,
          scheduleStore,
          runStore,
          notifiedStore,
          logger,
          config,
          httpAuth,
          runAndNotify,
          notifyLatest,
        });
        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });

        // Backstage's scheduler cron is UTC only, and every schedule carries
        // its own expression and zone, so one task ticks every minute and each
        // schedule is gated against its own cron. Schedules are read on each
        // tick, so one created in the UI starts firing without a restart.
        await scheduler.scheduleTask({
          id: 'stale-branches-tick',
          frequency: { cron: '* * * * *' },
          timeout: { minutes: 30 },
          initialDelay: { seconds: 30 },
          fn: async () => {
            const now = new Date();
            let schedules: BranchSchedule[];
            try {
              schedules = await scheduleStore.list();
            } catch (err) {
              logger.error(`[stale-branches] could not read schedules: ${err}`);
              return;
            }

            for (const schedule of schedules) {
              if (!schedule.enabled) continue;
              if (service.isRunning(schedule.id)) continue;
              if (!isDueNow(schedule.cron, schedule.timezone, now)) continue;
              try {
                await runAndNotify(schedule, 'schedule');
              } catch (err) {
                // The run is already recorded as failed, so the tick moves on
                // to the next schedule rather than skipping the rest.
                logger.error(
                  `[stale-branches] scheduled run of '${schedule.name}' failed: ${err}`,
                );
              }
            }
          },
        });

        await scheduler.scheduleTask({
          id: 'stale-branches-prune-notified',
          frequency: { cron: '0 3 * * *' },
          timeout: { minutes: 5 },
          initialDelay: { minutes: 5 },
          fn: async () => {
            const removed = await notifiedStore.prune(NOTIFIED_RETENTION_DAYS);
            if (removed > 0) {
              logger.info(
                `[stale-branches] pruned ${removed} notification records`,
              );
            }
          },
        });

        logger.info('Stale Branches backend plugin initialized');
      },
    });
  },
});

export default staleBranchesPlugin;
