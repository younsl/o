import { Router } from 'express';
import express from 'express';
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { ForkliftCoverageService } from './ForkliftCoverageService';
import { CoverageHistoryStore } from './CoverageHistoryStore';
import { SettingsStore } from './SettingsStore';
import { nextRunAt } from './ForkliftCoverageService';
import { normalizeHost, probeHost, validateHost } from './hostProbe';
import {
  SlackNotifier,
  buildSampleSummaryText,
  buildSummaryText,
} from './SlackNotifier';
import { SettingsResponse } from './types';

export interface RouterOptions {
  service: ForkliftCoverageService;
  historyStore: CoverageHistoryStore;
  settingsStore: SettingsStore;
  notifier: SlackNotifier;
  logger: LoggerService;
  config: Config;
  httpAuth: HttpAuthService;
}

/** Shows enough of the URL to recognise it without leaking the secret path. */
function maskWebhook(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/…`;
  } catch {
    return '…';
  }
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const {
    service,
    historyStore,
    settingsStore,
    notifier,
    logger,
    config,
    httpAuth,
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
    logger.error(`[forklift-coverage] ${context}: ${error}`);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  };

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/admin-status', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    res.json({ isAdmin: !!userRef && admins.includes(userRef) });
  });

  router.get('/coverage', (_, res) => {
    try {
      res.json(service.getCoverage());
    } catch (error) {
      fail(res, error, 'failed to build coverage response');
    }
  });

  router.get('/coverage/groups', (_, res) => {
    try {
      res.json(service.getGroupCoverage());
    } catch (error) {
      fail(res, error, 'failed to build group coverage');
    }
  });

  router.get('/coverage/history', async (req, res) => {
    try {
      const days = Number(req.query.days) || 90;
      res.json(await historyStore.getHistory(days));
    } catch (error) {
      fail(res, error, 'failed to read coverage history');
    }
  });

  router.get('/projects/:projectPath', async (req, res) => {
    try {
      const project = await service.getProjectDetail(
        decodeURIComponent(String(req.params.projectPath)),
      );
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json(project);
    } catch (error) {
      fail(res, error, 'failed to read the project');
    }
  });

  // Toggling an opt-out is a change to what gets measured, so it is admin only.
  router.put('/projects/:projectPath/exclusion', adminGuard(), async (req, res) => {
    try {
      const projectPath = decodeURIComponent(String(req.params.projectPath));
      const { excluded } = (req.body ?? {}) as { excluded?: boolean };
      if (typeof excluded !== 'boolean') {
        res.status(400).json({ error: 'excluded must be a boolean' });
        return;
      }
      await service.setManualExclusion(
        projectPath,
        excluded,
        (req as any).userRef ?? null,
      );
      res.json({ projectPath, excluded });
    } catch (error) {
      fail(res, error, 'failed to change the exclusion');
    }
  });

  router.get('/projects/:projectPath/last-commit', async (req, res) => {
    try {
      const projectPath = decodeURIComponent(String(req.params.projectPath));
      res.json(await service.getLastCommit(projectPath));
    } catch (error) {
      fail(res, error, 'failed to read the last commit');
    }
  });

  // Pipeline definitions only. The service reads nothing but GitLab CI files,
  // so this exposes how a project builds without exposing its source.
  router.get('/projects/:projectPath/pipeline', adminGuard(), async (req, res) => {
    try {
      const projectPath = decodeURIComponent(String(req.params.projectPath));
      const ref =
        typeof req.query.ref === 'string' && req.query.ref
          ? req.query.ref
          : undefined;
      res.json(await service.getPipeline(projectPath, ref));
    } catch (error) {
      fail(res, error, 'failed to read pipeline definitions');
    }
  });

  router.get('/settings', adminGuard(), async (_, res) => {
    try {
      const stored = await settingsStore.read();
      const pinnedHost = config.getOptional('forkliftCoverage.forkliftHost');
      const managedByConfig =
        typeof pinnedHost === 'string' && pinnedHost.trim() !== '';
      const webhook = await service.getEffectiveWebhook();
      const body: SettingsResponse = {
        forkliftHost: service.getForkliftHost(),
        webhookUrlMasked: maskWebhook(webhook.url),
        webhookEnabled: webhook.enabled,
        schedule: service.getSchedule(),
        source: stored?.forkliftHost
          ? 'database'
          : managedByConfig
          ? 'app-config'
          : 'unset',
        configured: service.isConfigured(),
        managedByConfig,
        updatedBy: stored?.updatedBy ?? null,
        updatedAt: stored?.updatedAt ?? null,
      };
      res.json(body);
    } catch (error) {
      fail(res, error, 'failed to read settings');
    }
  });

  // Probing a host the admin typed is a deliberate outbound request, so it is
  // admin gated and the probe itself only ever hits `https://<host>/`.
  router.post('/settings/test', adminGuard(), async (req, res) => {
    const host = String((req.body ?? {}).forkliftHost ?? '');
    const invalid = validateHost(host);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    res.json(await probeHost(host));
  });

  router.put('/settings', adminGuard(), async (req, res) => {
    try {
      const {
        forkliftHost,
        webhookUrl,
        webhookEnabled,
        scanCron,
        timezone,
        autoScanEnabled,
      } = (req.body ?? {}) as {
        forkliftHost?: string;
        webhookUrl?: string | null;
        webhookEnabled?: boolean;
        scanCron?: string;
        timezone?: string;
        autoScanEnabled?: boolean;
      };

      const invalid = validateHost(String(forkliftHost ?? ''));
      if (invalid) {
        res.status(400).json({ error: invalid });
        return;
      }
      const host = normalizeHost(String(forkliftHost));

      // A host that cannot be reached would make every scan report zero
      // coverage, so the save is refused rather than silently accepted.
      const probe = await probeHost(host);
      if (!probe.reachable) {
        res.status(400).json({
          error: `Cannot reach https://${host}. ${probe.error ?? ''}`.trim(),
          probe,
        });
        return;
      }

      const rawWebhook =
        typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
      if (rawWebhook && !/^https:\/\//i.test(rawWebhook)) {
        res.status(400).json({ error: 'Webhook URL must start with https://' });
        return;
      }

      const cron = typeof scanCron === 'string' ? scanCron.trim() : '';
      const tz = typeof timezone === 'string' ? timezone.trim() : '';
      if (cron && nextRunAt(cron, tz || 'UTC') === null) {
        res.status(400).json({
          error: `'${cron}' is not a valid cron expression for timezone '${tz || 'UTC'}'`,
        });
        return;
      }

      const existing = await settingsStore.read();
      await settingsStore.write({
        forkliftHost: host,
        // An empty field keeps the stored webhook, so saving the host alone
        // does not wipe a URL the admin cannot see in full.
        webhookUrl: rawWebhook || existing?.webhookUrl || null,
        webhookEnabled: webhookEnabled ?? existing?.webhookEnabled ?? false,
        scanCron: cron || existing?.scanCron || null,
        timezone: tz || existing?.timezone || null,
        autoScanEnabled: autoScanEnabled ?? existing?.autoScanEnabled ?? null,
        updatedBy: (req as any).userRef ?? null,
      });
      await service.refreshSettings();

      logger.info(
        `[forklift-coverage] settings saved by ${(req as any).userRef}: host=${host} (probe ${probe.status ?? 'n/a'} in ${probe.latencyMs}ms)`,
      );
      res.json({ saved: true, probe });
    } catch (error) {
      fail(res, error, 'failed to save settings');
    }
  });

  router.post('/scan', adminGuard(), async (req, res) => {
    if (service.isScanning()) {
      res.status(409).json({ error: 'Scan already in progress' });
      return;
    }
    // Scans take minutes, so return immediately and let the UI poll
    // /coverage for scanProgress.
    service
      .scan((req as any).userRef)
      .catch(err => logger.error(`[forklift-coverage] manual scan failed: ${err}`));
    res.json({ started: true });
  });

  router.post('/notify', adminGuard(), async (req, res) => {
    try {
      const webhook = await service.getEffectiveWebhook();
      if (!webhook.url) {
        res.status(400).json({ error: 'Webhook is not configured' });
        return;
      }
      if (!webhook.enabled) {
        res.status(400).json({ error: 'Webhook is disabled' });
        return;
      }
      const coverage = service.getCoverage();
      if (!coverage.lastScannedAt) {
        res.status(400).json({ error: 'No scan result to report yet' });
        return;
      }
      const notApplied = service.getNotAppliedProjects();
      const text = buildSummaryText(coverage, notApplied);
      await notifier.send(webhook.url, text);
      logger.info(
        `[forklift-coverage] manual notify by ${(req as any).userRef}`,
      );
      res.json({ sent: true, notApplied: notApplied.length });
    } catch (error) {
      logger.error(`[forklift-coverage] manual notify failed: ${error}`);
      res.status(502).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/notify/preview', adminGuard(), (_, res) => {
    try {
      const coverage = service.getCoverage();
      // Before the first scan there are no numbers to show, so the wizard gets
      // a clearly labelled example of the message shape instead of all zeros.
      if (!coverage.lastScannedAt) {
        res.json({ sample: true, text: buildSampleSummaryText(coverage) });
        return;
      }
      res.json({
        sample: false,
        text: buildSummaryText(coverage, service.getNotAppliedProjects()),
      });
    } catch (error) {
      fail(res, error, 'failed to build notify preview');
    }
  });

  return router;
}
