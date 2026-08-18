import express, { Router } from 'express';
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import {
  DEFAULT_IGNORED_BRANCHES,
  StaleBranchesService,
  nextRunAt,
  nextRuns,
} from './StaleBranchesService';
import { ConnectionStore } from './ConnectionStore';
import { ScheduleStore } from './ScheduleStore';
import { RunStore } from './RunStore';
import { NotifiedStore } from './NotifiedStore';
import { probeCredentials, probeEndpoint } from './GitlabClient';
import { buildBranchText, buildSampleBranchText } from './SlackNotifier';
import {
  BranchSchedule,
  ConnectionResponse,
  ScheduleInput,
  ScheduleSummary,
  SchedulesResponse,
} from './types';

/** Runs shown per schedule in the history strip on the list page. */
const RECENT_RUNS_IN_LIST = 12;

export interface RouterOptions {
  service: StaleBranchesService;
  connectionStore: ConnectionStore;
  scheduleStore: ScheduleStore;
  runStore: RunStore;
  notifiedStore: NotifiedStore;
  logger: LoggerService;
  config: Config;
  httpAuth: HttpAuthService;
  /** Runs a schedule and sends its report. Shared with the scheduler. */
  runAndNotify: (
    schedule: BranchSchedule,
    triggeredBy: string,
    dryRun?: boolean,
  ) => Promise<{
    staleCount: number;
    sent: number;
    skipped: number;
    failed: number;
  }>;
  /** Sends the newest finished run again, without scanning. */
  notifyLatest: (
    schedule: BranchSchedule,
  ) => Promise<{ sent: number; skipped: number; failed: number }>;
}

/** Shows enough of the URL to recognise it without leaking the secret path. */
export function maskWebhook(url: string | null): string | null {
  if (!url) return null;
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return '…';
  }
}

/**
 * Keeps the token's prefix, which is what tells a `glpat-` personal token from
 * a project or group one, and hides everything that makes it usable.
 */
export function maskToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 8) return '…';
  return `${token.slice(0, 6)}…${token.slice(-2)}`;
}

/** Accepts an API root such as https://gitlab.example.com/api/v4. */
export function validateApiBaseUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'GitLab API URL is required';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter a full URL such as https://gitlab.example.com/api/v4';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'URL must use http or https';
  }
  if (!/\/api\/v\d+\/?$/.test(parsed.pathname)) {
    return 'URL must end with the API root, for example /api/v4';
  }
  return null;
}

const asList = (value: unknown, fallback: string[]): string[] =>
  Array.isArray(value)
    ? value.map(String).map(item => item.trim()).filter(Boolean)
    : fallback;

/** Validates a create or update body, returning either an error or the input. */
export function parseScheduleInput(
  body: Record<string, unknown>,
): { error: string } | { input: ScheduleInput } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { error: 'Name is required' };
  if (name.length > 100) return { error: 'Name must be 100 characters or less' };

  const projectNames = asList(body.projectNames, []);
  if (projectNames.length === 0) {
    return { error: 'At least one project is required' };
  }

  const thresholdDays = Number(body.thresholdDays);
  if (!Number.isInteger(thresholdDays) || thresholdDays < 1 || thresholdDays > 3650) {
    return { error: 'Threshold must be a whole number of days from 1 to 3650' };
  }

  const cron = typeof body.cron === 'string' ? body.cron.trim() : '';
  const timezone =
    typeof body.timezone === 'string' && body.timezone.trim()
      ? body.timezone.trim()
      : 'UTC';
  if (!cron) return { error: 'Cron expression is required' };
  if (nextRunAt(cron, timezone) === null) {
    return {
      error: `'${cron}' is not a valid cron expression for timezone '${timezone}'`,
    };
  }

  const webhookUrl =
    typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : '';
  if (webhookUrl && !/^https:\/\//i.test(webhookUrl)) {
    return { error: 'Webhook URL must start with https://' };
  }

  return {
    input: {
      name,
      description:
        typeof body.description === 'string' && body.description.trim()
          ? body.description.trim()
          : null,
      projectNames,
      thresholdDays,
      ignoredBranches: asList(body.ignoredBranches, DEFAULT_IGNORED_BRANCHES),
      ignoreProtected:
        typeof body.ignoreProtected === 'boolean' ? body.ignoreProtected : true,
      webhookUrl,
      webhookDescription:
        typeof body.webhookDescription === 'string' && body.webhookDescription.trim()
          ? body.webhookDescription.trim().slice(0, 120)
          : null,
      webhookEnabled:
        typeof body.webhookEnabled === 'boolean' ? body.webhookEnabled : false,
      cron,
      timezone,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
    },
  };
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const {
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
  } = options;

  const router = Router();
  router.use(express.json());

  const admins = config.getOptionalStringArray('permission.admins') ?? [];
  const isDevMode =
    config.getOptionalBoolean(
      'backend.auth.dangerouslyDisableDefaultAuthPolicy',
    ) ?? false;

  async function tryGetUserRef(
    req: express.Request,
  ): Promise<string | undefined> {
    try {
      const credentials = await httpAuth.credentials(req as any, {
        allow: ['user'],
      });
      return credentials.principal.userEntityRef;
    } catch {
      if (isDevMode) return 'user:development/guest';
      return undefined;
    }
  }

  function adminGuard(): express.RequestHandler {
    return async (req, res, next) => {
      const userRef = await tryGetUserRef(req);
      if (!userRef || !admins.includes(userRef)) {
        res.status(403).json({ error: 'Admin only' });
        return;
      }
      (req as any).userRef = userRef;
      next();
    };
  }

  const fail = (res: express.Response, error: unknown, context: string) => {
    logger.error(`[stale-branches] ${context}: ${error}`);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  };

  /** Loads the schedule named by the route, or answers 404. */
  async function loadSchedule(
    req: express.Request,
    res: express.Response,
  ): Promise<BranchSchedule | null> {
    const schedule = await scheduleStore.get(String(req.params.id));
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return null;
    }
    return schedule;
  }

  function toSummary(
    schedule: BranchSchedule,
    runs: RunSummaryList,
  ): ScheduleSummary {
    const { webhookUrl, ...rest } = schedule;
    return {
      ...rest,
      webhookUrlMasked: maskWebhook(webhookUrl),
      // A paused schedule has no next run, which is the whole point of pausing
      // it, so the column says so rather than showing a time nothing fires at.
      nextRunAt: schedule.enabled
        ? nextRunAt(schedule.cron, schedule.timezone)
        : null,
      recentRuns: runs,
      lastRun: runs[0] ?? null,
      running: service.isRunning(schedule.id),
      progress: service.getProgress(schedule.id),
    };
  }

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/admin-status', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    res.json({ isAdmin: !!userRef && admins.includes(userRef) });
  });

  // The overview and the schedule list are readable by any signed-in user.
  // Everything that changes state or reveals a secret is admin gated below.
  router.get('/schedules', async (_, res) => {
    try {
      const schedules = await scheduleStore.list();
      const runs = await runStore.recentBySchedule(
        schedules.map(schedule => schedule.id),
        RECENT_RUNS_IN_LIST,
      );
      const body: SchedulesResponse = {
        schedules: schedules.map(schedule =>
          toSummary(schedule, runs.get(schedule.id) ?? []),
        ),
        stats: await service.buildOverview(schedules, runs),
        connected: service.isConnected(),
        gitlabWebUrl: service.getGitlabWebUrl(),
        backstageUrl: service.getBackstageUrl(),
      };
      res.json(body);
    } catch (error) {
      fail(res, error, 'failed to list schedules');
    }
  });

  router.post('/schedules', adminGuard(), async (req, res) => {
    try {
      const parsed = parseScheduleInput((req.body ?? {}) as Record<string, unknown>);
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const clash = await scheduleStore.findByName(parsed.input.name);
      if (clash) {
        res.status(409).json({ error: 'A schedule with that name exists' });
        return;
      }
      const created = await scheduleStore.create(
        parsed.input,
        (req as any).userRef ?? null,
      );
      logger.info(
        `[stale-branches] schedule '${created.name}' created by ${(req as any).userRef}`,
      );
      res.status(201).json(toSummary(created, []));
    } catch (error) {
      fail(res, error, 'failed to create the schedule');
    }
  });

  router.get('/schedules/:id', async (req, res) => {
    try {
      const schedule = await loadSchedule(req, res);
      if (!schedule) return;
      const runs = await runStore.recent(schedule.id, RECENT_RUNS_IN_LIST);
      res.json(toSummary(schedule, runs));
    } catch (error) {
      fail(res, error, 'failed to read the schedule');
    }
  });

  router.put('/schedules/:id', adminGuard(), async (req, res) => {
    try {
      const schedule = await loadSchedule(req, res);
      if (!schedule) return;
      const parsed = parseScheduleInput((req.body ?? {}) as Record<string, unknown>);
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const clash = await scheduleStore.findByName(parsed.input.name);
      if (clash && clash.id !== schedule.id) {
        res.status(409).json({ error: 'A schedule with that name exists' });
        return;
      }
      const updated = await scheduleStore.update(
        schedule.id,
        parsed.input,
        (req as any).userRef ?? null,
      );
      if (!updated) {
        res.status(404).json({ error: 'Schedule not found' });
        return;
      }
      logger.info(
        `[stale-branches] schedule '${updated.name}' updated by ${(req as any).userRef}`,
      );
      const runs = await runStore.recent(updated.id, RECENT_RUNS_IN_LIST);
      res.json(toSummary(updated, runs));
    } catch (error) {
      fail(res, error, 'failed to update the schedule');
    }
  });

  // Pausing is its own endpoint so the list toggle does not have to send, and
  // therefore cannot corrupt, a whole schedule body.
  router.patch('/schedules/:id/enabled', adminGuard(), async (req, res) => {
    try {
      const { enabled } = (req.body ?? {}) as { enabled?: boolean };
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      const updated = await scheduleStore.setEnabled(
        String(req.params.id),
        enabled,
        (req as any).userRef ?? null,
      );
      if (!updated) {
        res.status(404).json({ error: 'Schedule not found' });
        return;
      }
      logger.info(
        `[stale-branches] schedule '${updated.name}' ${enabled ? 'resumed' : 'paused'} by ${(req as any).userRef}`,
      );
      const runs = await runStore.recent(updated.id, RECENT_RUNS_IN_LIST);
      res.json(toSummary(updated, runs));
    } catch (error) {
      fail(res, error, 'failed to change the schedule state');
    }
  });

  router.delete('/schedules/:id', adminGuard(), async (req, res) => {
    try {
      const schedule = await loadSchedule(req, res);
      if (!schedule) return;
      if (service.isRunning(schedule.id)) {
        res.status(409).json({ error: 'A run is in progress' });
        return;
      }
      // The history and the dedupe log belong to the schedule, so they go with
      // it rather than being left behind pointing at an id nothing resolves.
      await runStore.deleteForSchedule(schedule.id);
      await notifiedStore.clear(schedule.id);
      await scheduleStore.delete(schedule.id);
      logger.info(
        `[stale-branches] schedule '${schedule.name}' deleted by ${(req as any).userRef}`,
      );
      res.json({ deleted: true });
    } catch (error) {
      fail(res, error, 'failed to delete the schedule');
    }
  });

  router.post('/schedules/:id/trigger', adminGuard(), async (req, res) => {
    try {
      const schedule = await loadSchedule(req, res);
      if (!schedule) return;
      if (service.isRunning(schedule.id)) {
        res.status(409).json({ error: 'A run is already in progress' });
        return;
      }
      if (!service.isConnected()) {
        res.status(400).json({ error: 'Set up the GitLab connection first' });
        return;
      }
      // A dry run scans and records like any other, but sends nothing and
      // leaves the dedupe log untouched, so it can be used to check a new
      // schedule without putting anything in front of a team.
      const { dryRun } = (req.body ?? {}) as { dryRun?: boolean };
      const isDryRun = dryRun === true;

      // A run takes as long as GitLab takes to answer, so it runs detached and
      // the UI polls the schedule list for its progress.
      const userRef = (req as any).userRef ?? 'manual';
      runAndNotify(schedule, userRef, isDryRun).catch(err =>
        logger.error(
          `[stale-branches] manual run of '${schedule.name}' failed: ${err}`,
        ),
      );
      res.json({ started: true, dryRun: isDryRun });
    } catch (error) {
      fail(res, error, 'failed to start the run');
    }
  });

  router.get('/schedules/:id/runs', async (req, res) => {
    try {
      const schedule = await loadSchedule(req, res);
      if (!schedule) return;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      res.json(await runStore.recent(schedule.id, limit));
    } catch (error) {
      fail(res, error, 'failed to read the run history');
    }
  });

  /** The newest finished run, which is what a schedule page opens on. */
  router.get('/schedules/:id/runs/latest', async (req, res) => {
    try {
      const schedule = await loadSchedule(req, res);
      if (!schedule) return;
      const latest = await runStore.latestFinished(schedule.id);
      if (!latest) {
        res.status(404).json({ error: 'The schedule has not finished a run' });
        return;
      }
      res.json(latest);
    } catch (error) {
      fail(res, error, 'failed to read the latest run');
    }
  });

  router.get('/runs/:runId', async (req, res) => {
    try {
      const run = await runStore.get(String(req.params.runId));
      if (!run) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.json(run);
    } catch (error) {
      fail(res, error, 'failed to read the run');
    }
  });

  router.post('/schedules/:id/notify', adminGuard(), async (req, res) => {
    try {
      const schedule = await loadSchedule(req, res);
      if (!schedule) return;
      if (!schedule.webhookUrl) {
        res.status(400).json({ error: 'Webhook is not configured' });
        return;
      }
      if (!schedule.webhookEnabled) {
        res.status(400).json({ error: 'Webhook is disabled' });
        return;
      }
      const latest = await runStore.latestFinished(schedule.id);
      if (!latest || latest.state !== 'success') {
        res.status(400).json({ error: 'No successful run to report yet' });
        return;
      }
      res.json(await notifyLatest(schedule));
    } catch (error) {
      logger.error(`[stale-branches] manual notify failed: ${error}`);
      res.status(502).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/schedules/:id/notify/preview', adminGuard(), async (req, res) => {
    try {
      const schedule = await loadSchedule(req, res);
      if (!schedule) return;
      const latest = await runStore.latestFinished(schedule.id);
      // One message covers one branch, so the preview renders the oldest one
      // the newest run found. Before there is a run, or when the run found
      // nothing, it falls back to a clearly labelled example.
      const subject =
        latest?.state === 'success' ? latest.branches[0] : undefined;
      if (!subject) {
        res.json({
          sample: true,
          text: buildSampleBranchText({
            thresholdDays: schedule.thresholdDays,
            timezone: schedule.timezone,
          }),
        });
        return;
      }
      res.json({
        sample: false,
        text: buildBranchText({
          branch: subject,
          thresholdDays: schedule.thresholdDays,
          timezone: schedule.timezone,
        }),
      });
    } catch (error) {
      fail(res, error, 'failed to build the notify preview');
    }
  });

  // Clearing the dedupe log makes the next send report every stale branch
  // again, which is the way out when a message was lost.
  router.post('/schedules/:id/notify/reset', adminGuard(), async (req, res) => {
    try {
      const schedule = await loadSchedule(req, res);
      if (!schedule) return;
      await notifiedStore.clear(schedule.id);
      logger.info(
        `[stale-branches] notification history of '${schedule.name}' cleared by ${(req as any).userRef}`,
      );
      res.json({ cleared: true });
    } catch (error) {
      fail(res, error, 'failed to clear the notification history');
    }
  });

  router.get('/connection', adminGuard(), async (_, res) => {
    try {
      const stored = await connectionStore.read();
      const credentials = service.getCredentials();
      const body: ConnectionResponse = {
        apiBaseUrl: credentials?.apiBaseUrl ?? null,
        gitlabTokenMasked: maskToken(credentials?.token ?? null),
        source: credentials?.source ?? 'unset',
        configured: !!credentials,
        managedByConfig: service.isManagedByConfig(),
        username: null,
        updatedBy: stored?.updatedBy ?? null,
        updatedAt: stored?.updatedAt ?? null,
      };
      res.json(body);
    } catch (error) {
      fail(res, error, 'failed to read the connection');
    }
  });

  // Reachability only, so it answers while the token field is still empty.
  // Admin gated all the same: it makes this backend fetch a URL a caller chose.
  router.post('/connection/reachability', adminGuard(), async (req, res) => {
    try {
      const { apiBaseUrl } = (req.body ?? {}) as { apiBaseUrl?: string };
      const invalid = validateApiBaseUrl(String(apiBaseUrl ?? ''));
      if (invalid) {
        res.status(400).json({ error: invalid });
        return;
      }
      res.json(await probeEndpoint(String(apiBaseUrl)));
    } catch (error) {
      fail(res, error, 'failed to reach the endpoint');
    }
  });

  // Calls GitLab with the pair the admin typed. Admin gated because it is a
  // deliberate outbound request carrying a credential.
  router.post('/connection/test', adminGuard(), async (req, res) => {
    try {
      const { apiBaseUrl, gitlabToken } = (req.body ?? {}) as {
        apiBaseUrl?: string;
        gitlabToken?: string;
      };
      const invalid = validateApiBaseUrl(String(apiBaseUrl ?? ''));
      if (invalid) {
        res.status(400).json({ error: invalid });
        return;
      }
      // An empty field means "keep what is in effect", so the probe reuses the
      // resolved token rather than reporting a failure nobody can act on.
      const token =
        (typeof gitlabToken === 'string' && gitlabToken.trim()) ||
        service.getCredentials()?.token ||
        '';
      if (!token) {
        res.status(400).json({ error: 'GitLab token is required' });
        return;
      }
      res.json(await probeCredentials(String(apiBaseUrl), token));
    } catch (error) {
      fail(res, error, 'failed to test the connection');
    }
  });

  router.put('/connection', adminGuard(), async (req, res) => {
    try {
      const { apiBaseUrl, gitlabToken } = (req.body ?? {}) as {
        apiBaseUrl?: string;
        gitlabToken?: string;
      };
      const invalid = validateApiBaseUrl(String(apiBaseUrl ?? ''));
      if (invalid) {
        res.status(400).json({ error: invalid });
        return;
      }

      const existing = await connectionStore.read();
      const rawToken =
        typeof gitlabToken === 'string' ? gitlabToken.trim() : '';
      // Write-only field: an empty value keeps whatever is already in effect,
      // which is what the masked placeholder in the form promises.
      const token =
        rawToken || existing?.gitlabToken || service.getCredentials()?.token || '';
      if (!token) {
        res.status(400).json({ error: 'GitLab token is required' });
        return;
      }

      // Credentials that cannot read the API would make every run report zero
      // stale branches, so the save is refused rather than silently accepted.
      const probe = await probeCredentials(String(apiBaseUrl), token);
      if (!probe.reachable) {
        res.status(400).json({
          error: `Cannot reach GitLab. ${probe.error ?? ''}`.trim(),
          probe,
        });
        return;
      }

      await connectionStore.write({
        apiBaseUrl: String(apiBaseUrl).trim(),
        // Only a token typed into the form is stored. A value that came from
        // app-config stays there rather than being copied into the database,
        // where it would outlive the config it was read from.
        gitlabToken: rawToken || existing?.gitlabToken || null,
        updatedBy: (req as any).userRef ?? null,
      });
      await service.refreshConnection();

      logger.info(
        `[stale-branches] connection saved by ${(req as any).userRef}, token belongs to ${probe.username ?? 'unknown'}`,
      );
      res.json({ saved: true, probe });
    } catch (error) {
      fail(res, error, 'failed to save the connection');
    }
  });

  // Resolves a cron and timezone the admin is still typing, so the form can
  // show what the expression actually means before it is saved. Mirrors the
  // preview GitLab shows on a pipeline schedule.
  router.post('/cron/preview', adminGuard(), (req, res) => {
    const { cron, timezone } = (req.body ?? {}) as {
      cron?: string;
      timezone?: string;
    };
    const expression = String(cron ?? '').trim();
    const tz = String(timezone ?? '').trim() || 'UTC';
    if (!expression) {
      res.status(400).json({ error: 'Cron expression is required' });
      return;
    }
    const runs = nextRuns(expression, tz, 3);
    res.json({
      valid: runs.length > 0,
      timezone: tz,
      nextRuns: runs,
      error:
        runs.length > 0
          ? null
          : `'${expression}' is not a valid cron expression for timezone '${tz}'`,
    });
  });

  return router;
}

type RunSummaryList = Awaited<ReturnType<RunStore['recent']>>;
