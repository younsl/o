import { LoggerService, SchedulerService } from '@backstage/backend-plugin-api';
import { OpenSearchServiceClient } from './OpenSearchServiceClient';
import { ScalingRequestStore } from './ScalingRequestStore';

export interface SchedulerOptions {
  logger: LoggerService;
  scheduler: SchedulerService;
  store: ScalingRequestStore;
  client: OpenSearchServiceClient;
  /** Hours after the reserved time to keep retrying when a change is in flight. */
  graceHours: number;
}

const SCHEDULER_ACTOR = 'system:opensearch-scaling-scheduler';

/**
 * Runs every minute. Executes reservations whose time has arrived, re-validating
 * that no change is already in progress, and advances finished ones to completed.
 */
export async function registerScheduler(
  options: SchedulerOptions,
): Promise<void> {
  const { logger, scheduler, store, client, graceHours } = options;

  await scheduler.scheduleTask({
    id: 'opensearch-scaling-execute',
    frequency: { cron: '* * * * *' },
    timeout: { minutes: 10 },
    initialDelay: { seconds: 20 },
    fn: async () => {
      const nowIso = new Date().toISOString();
      const due = await store.listDue(nowIso);

      for (const req of due) {
        await store.updateStatus(req.id, 'validating');
        try {
          if (await client.isChangeInProgress(req.domain)) {
            // Within the grace window: leave for the next tick to retry.
            const deadline =
              Date.parse(req.scheduledAt) + graceHours * 60 * 60 * 1000;
            if (Date.now() <= deadline) {
              await store.updateStatus(req.id, 'scheduled');
              logger.info(
                `Deferring ${req.id} (${req.domain}): change already in progress`,
              );
              continue;
            }
            await store.updateStatus(req.id, 'failed', {
              errorMessage:
                'A change was still in progress past the grace window; scaling not applied',
              event: {
                type: 'failed',
                actor: SCHEDULER_ACTOR,
                note: 'change in progress past grace window',
              },
            });
            continue;
          }

          await client.updateScaling(req.domain, {
            instanceType: req.instanceType,
            instanceCount: req.instanceCount,
            volumeSizeGb: req.volumeSizeGb,
          });
          await store.updateStatus(req.id, 'in_progress', {
            event: {
              type: 'executed',
              actor: SCHEDULER_ACTOR,
              note: `${req.instanceType} x${req.instanceCount}, ${req.volumeSizeGb}GB`,
            },
          });
          logger.info(`Executed scaling reservation ${req.id} (${req.domain})`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await store.updateStatus(req.id, 'failed', {
            errorMessage: msg,
            event: { type: 'failed', actor: SCHEDULER_ACTOR, note: msg },
          });
          logger.error(`Scaling reservation ${req.id} failed: ${msg}`);
        }
      }

      // Advance executed requests to completed once AWS reports the change done.
      const inFlight = await store.listInProgress();
      for (const req of inFlight) {
        try {
          if (!(await client.isChangeInProgress(req.domain))) {
            await store.updateStatus(req.id, 'completed', {
              event: {
                type: 'completed',
                actor: SCHEDULER_ACTOR,
                note: 'domain change completed',
              },
            });
            logger.info(`Scaling reservation ${req.id} completed (${req.domain})`);
          }
        } catch (error) {
          logger.debug(`Completion poll for ${req.id} failed: ${error}`);
        }
      }
    },
  });
}
