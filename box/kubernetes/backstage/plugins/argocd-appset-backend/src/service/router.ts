import { Router } from 'express';
import express from 'express';
import {
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { ApplicationSetService } from './ApplicationSetService';
import { AppSetCache } from './AppSetCache';
import { AuditStore } from './AuditStore';
import { UpstreamChartStore } from './UpstreamChartStore';
import { UpstreamScanner } from './UpstreamScanner';
import { UpstreamVersionStore } from './UpstreamVersionStore';

export interface RouterOptions {
  service: ApplicationSetService;
  cache: AppSetCache;
  logger: LoggerService;
  config: Config;
  httpAuth: HttpAuthService;
  auditStore: AuditStore;
  upstreamCharts: UpstreamChartStore;
  upstreamVersions: UpstreamVersionStore;
  upstreamScanner: UpstreamScanner;
}

/**
 * The (repository, chart) pairs the cluster actually pulls charts from, taken
 * from the ApplicationSets already fetched. The upstream lookup makes the
 * backend issue an outbound request on a caller's behalf, so the target must
 * come from data the cluster produced rather than from the query string, which
 * would otherwise let a caller aim the backend at any address it can reach.
 *
 * Keyed by `repository|chart`, which is also what the single-chart route
 * validates against.
 */
export function knownUpstreamPairs(
  cache: AppSetCache,
): Map<string, { repository: string; chart: string }> {
  const pairs = new Map<string, { repository: string; chart: string }>();

  for (const appSet of cache.getAppSets()) {
    for (const info of Object.values(appSet.applicationInfos ?? {})) {
      if (info.upstreamRepository && info.upstreamChart) {
        pairs.set(`${info.upstreamRepository}|${info.upstreamChart}`, {
          repository: info.upstreamRepository,
          chart: info.upstreamChart,
        });
      }
    }
  }

  return pairs;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const {
    service,
    cache,
    logger,
    config,
    httpAuth,
    auditStore,
    upstreamCharts,
    upstreamVersions,
    upstreamScanner,
  } = options;

  const admins = config.getOptionalStringArray('permission.admins') ?? [];

  const isDevMode = config.getOptionalBoolean('backend.auth.dangerouslyDisableDefaultAuthPolicy') ?? false;

  // In dev mode, fall back to guest identity so admin-gated routes can be tested.
  async function tryGetUserRef(req: express.Request): Promise<string | undefined> {
    try {
      const credentials = await httpAuth.credentials(req as any, { allow: ['user'] });
      return credentials.principal.userEntityRef;
    } catch {
      if (isDevMode) {
        return 'user:development/guest';
      }
      return undefined;
    }
  }

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/status', (_, res) => {
    const cron = config.getOptionalString('argocdApplicationSet.schedule.cron') ?? '0 10-11,14-18 * * 1-5';
    const fetchCron = config.getOptionalString('argocdApplicationSet.schedule.fetchCron') ?? '* * * * *';
    const slackConfigured = !!config.getOptionalString('argocdApplicationSet.slack.webhookUrl');
    const lastFetchedAt = cache.getLastFetchedAt();
    res.json({
      cron,
      fetchCron,
      slackConfigured,
      lastFetchedAt,
      applicationsReadable: service.isApplicationsReadable(),
    });
  });

  router.get('/branches', async (req, res) => {
    const repoUrl = req.query.repoUrl as string | undefined;
    if (!repoUrl || typeof repoUrl !== 'string') {
      res.status(400).json({ error: 'repoUrl query parameter is required' });
      return;
    }
    try {
      const result = await service.listBranches(repoUrl);
      res.json(result);
    } catch (error) {
      logger.error(`Failed to list branches for ${repoUrl}: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/application-sets', (_, res) => {
    res.json(cache.getAppSets());
  });

  router.post('/application-sets/:namespace/:name/mute', async (req, res) => {
    const { namespace, name } = req.params;
    try {
      const userRef = await tryGetUserRef(req);
      if (!userRef || !admins.includes(userRef)) {
        res.status(403).json({ error: 'Only admins can mute ApplicationSets' });
        return;
      }

      await service.setMuted(namespace, name, true);
      const appSets = await service.listApplicationSets();
      cache.update(appSets);

      await auditStore.addEntry({
        action: 'mute',
        appsetNamespace: namespace,
        appsetName: name,
        userRef,
        oldValue: 'false',
        newValue: 'true',
      });

      res.json({ status: 'muted' });
    } catch (error) {
      logger.error(`Failed to mute ${namespace}/${name}: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/application-sets/:namespace/:name/unmute', async (req, res) => {
    const { namespace, name } = req.params;
    try {
      const userRef = await tryGetUserRef(req);
      if (!userRef || !admins.includes(userRef)) {
        res.status(403).json({ error: 'Only admins can unmute ApplicationSets' });
        return;
      }

      await service.setMuted(namespace, name, false);
      const appSets = await service.listApplicationSets();
      cache.update(appSets);

      await auditStore.addEntry({
        action: 'unmute',
        appsetNamespace: namespace,
        appsetName: name,
        userRef,
        oldValue: 'true',
        newValue: 'false',
      });

      res.json({ status: 'unmuted' });
    } catch (error) {
      logger.error(`Failed to unmute ${namespace}/${name}: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/application-sets/:namespace/:name/target-revision', async (req, res) => {
    const { namespace, name } = req.params;
    const { targetRevision } = req.body ?? {};
    try {
      const userRef = await tryGetUserRef(req);
      if (!userRef || !admins.includes(userRef)) {
        res.status(403).json({ error: 'Only admins can change target revision' });
        return;
      }

      if (!targetRevision || typeof targetRevision !== 'string' || targetRevision.trim() === '') {
        res.status(400).json({ error: 'targetRevision is required' });
        return;
      }

      const currentAppSet = cache.getAppSets().find(
        a => a.namespace === namespace && a.name === name,
      );
      const oldRevision = currentAppSet?.targetRevisions?.join(', ') ?? null;

      await service.setTargetRevision(namespace, name, targetRevision.trim());
      const appSets = await service.listApplicationSets();
      cache.update(appSets);

      await auditStore.addEntry({
        action: 'set_target_revision',
        appsetNamespace: namespace,
        appsetName: name,
        userRef,
        oldValue: oldRevision,
        newValue: targetRevision.trim(),
      });

      res.json({ status: 'updated', targetRevision: targetRevision.trim() });
    } catch (error) {
      logger.error(`Failed to set targetRevision for ${namespace}/${name}: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /*
   * Looked up on request rather than during the refresh, since a Helm index is
   * far too large to pull on a one-minute schedule and the answer is only ever
   * read when someone opens the chart version detail.
   */
  router.get('/upstream-chart', async (req, res) => {
    const repository = req.query.repository as string | undefined;
    const chart = req.query.chart as string | undefined;

    if (!repository || !chart) {
      res.status(400).json({ error: 'repository and chart query parameters are required' });
      return;
    }

    // Only repositories the cluster already depends on, so this endpoint cannot
    // be used to make the backend reach an arbitrary address.
    if (!knownUpstreamPairs(cache).has(`${repository}|${chart}`)) {
      res.status(400).json({
        error: 'No ApplicationSet depends on that chart and repository',
      });
      return;
    }

    try {
      const result = await upstreamCharts.getLatest(repository, chart);

      // Write-through, so one person running a scan fills the record for
      // everyone. A failure to persist must not fail the lookup itself.
      try {
        await upstreamVersions.save(result);
      } catch (error) {
        logger.warn(`Failed to persist upstream version for ${chart}: ${error}`);
      }

      res.json(result);
    } catch (error) {
      logger.error(`Failed to read upstream versions for ${chart}: ${error}`);
      res.status(500).json({ error: 'Failed to read upstream versions' });
    }
  });

  /*
   * What the last scan recorded, whoever ran it. Read on page load so the page
   * marks what is upgradable without every reader pressing the button, and so a
   * restarted backend still knows what it found.
   */
  router.get('/upstream-charts', async (_, res) => {
    try {
      res.json(await upstreamVersions.listAll());
    } catch (error) {
      logger.error(`Failed to list stored upstream versions: ${error}`);
      res.status(500).json({ error: 'Failed to list stored upstream versions' });
    }
  });

  /*
   * Progress and cooldown of the shared scan. Polled while one is running, so
   * every reader watches the same scan rather than starting their own.
   */
  router.get('/upstream-scan', async (_, res) => {
    try {
      res.json(await upstreamScanner.status());
    } catch (error) {
      logger.error(`Failed to read scan status: ${error}`);
      res.status(500).json({ error: 'Failed to read scan status' });
    }
  });

  router.post('/upstream-scan', async (_, res) => {
    try {
      const outcome = await upstreamScanner.start([
        ...knownUpstreamPairs(cache).values(),
      ]);

      if (outcome === 'already-running') {
        res.status(409).json({ error: 'A scan is already running' });
        return;
      }
      if (outcome === 'cooling-down') {
        const { cooldownSeconds } = await upstreamScanner.status();
        res
          .status(429)
          .json({ error: `Another scan may start in ${cooldownSeconds} seconds` });
        return;
      }

      res.status(202).json(await upstreamScanner.status());
    } catch (error) {
      logger.error(`Failed to start scan: ${error}`);
      res.status(500).json({ error: 'Failed to start scan' });
    }
  });

  router.get('/audit-logs', async (req, res) => {
    const namespace = req.query.namespace as string | undefined;
    const name = req.query.name as string | undefined;
    try {
      const entries = await auditStore.listEntries({ namespace, name });
      res.json(entries);
    } catch (error) {
      logger.error(`Failed to list audit logs: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/admin-status', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    res.json({ isAdmin: !!userRef && admins.includes(userRef) });
  });

  return router;
}
