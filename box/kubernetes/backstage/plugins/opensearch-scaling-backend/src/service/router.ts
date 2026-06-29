import { Router } from 'express';
import express from 'express';
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { OpenSearchServiceClient } from './OpenSearchServiceClient';
import { ScalingRequestStore } from './ScalingRequestStore';

export interface RouterOptions {
  logger: LoggerService;
  config: Config;
  httpAuth: HttpAuthService;
  store: ScalingRequestStore;
  client: OpenSearchServiceClient;
  instanceTypes: string[];
  timezones: string[];
  defaultTimezone: string;
}

const DEFAULT_INSTANCE_TYPES = [
  'r6g.large.search',
  'r6g.xlarge.search',
  'r6g.2xlarge.search',
  'r6g.4xlarge.search',
  'm6g.large.search',
  'm6g.xlarge.search',
  'm6g.2xlarge.search',
  'c6g.large.search',
  'c6g.xlarge.search',
];

// OpenSearch Service minimum gp3/gp2 volume size per data node.
const MIN_VOLUME_GB = 10;

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { logger, config, httpAuth, store, client } = options;

  const isDevMode =
    config.getOptionalBoolean(
      'backend.auth.dangerouslyDisableDefaultAuthPolicy',
    ) ?? false;

  const instanceTypes =
    options.instanceTypes.length > 0
      ? options.instanceTypes
      : DEFAULT_INSTANCE_TYPES;

  // Viewing is open to any authenticated user; creating and cancelling
  // reservations is restricted to admins listed in `permission.admins`.
  const admins = config.getOptionalStringArray('permission.admins') ?? [];

  async function tryGetUserRef(
    req: express.Request,
  ): Promise<string | undefined> {
    try {
      const credentials = await httpAuth.credentials(req as any, {
        allow: ['user'],
      });
      return credentials.principal.userEntityRef;
    } catch {
      return isDevMode ? 'user:development/guest' : undefined;
    }
  }

  /** Returns the authenticated user ref, or sends 401 and returns undefined. */
  async function requireUser(
    req: express.Request,
    res: express.Response,
  ): Promise<string | undefined> {
    const userRef = await tryGetUserRef(req);
    if (!userRef) {
      res.status(401).json({ error: 'Authentication required' });
      return undefined;
    }
    return userRef;
  }

  /** Returns the user ref if they are an admin, else sends 401/403. */
  async function requireAdmin(
    req: express.Request,
    res: express.Response,
  ): Promise<string | undefined> {
    const userRef = await requireUser(req, res);
    if (!userRef) return undefined;
    if (!admins.includes(userRef)) {
      res.status(403).json({ error: 'Admin access required' });
      return undefined;
    }
    return userRef;
  }

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, res) => res.json({ status: 'ok' }));

  router.get('/config', (_, res) => {
    res.json({
      configured: true,
      instanceTypes,
      timezones: options.timezones,
      defaultTimezone: options.defaultTimezone,
    });
  });

  // Current user's role so the UI can show create/cancel only to admins.
  router.get('/user-role', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    res.json({ isAdmin: !!userRef && admins.includes(userRef), admins });
  });

  // List OpenSearch Service domains the credentials can see.
  router.get('/domains', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    try {
      res.json(await client.listDomains());
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to list domains: ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  // Current config + in-progress flag + valid instance types (drives the form).
  router.get('/domains/:name', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    try {
      const summary = await client.describeDomain(req.params.name);
      const changeInProgress =
        summary.processing || summary.upgradeProcessing
          ? true
          : await client.isChangeInProgress(req.params.name);

      // Instance types come from the API for the domain's engine version;
      // best-effort so the rest of the form still works if this call fails.
      let domainInstanceTypes: string[] = [];
      if (summary.engineVersion) {
        try {
          domainInstanceTypes = await client.listInstanceTypes(
            summary.engineVersion,
            req.params.name,
          );
        } catch (e) {
          logger.warn(
            `Failed to list instance types for '${req.params.name}': ${e}`,
          );
        }
      }
      // Fall back to the configured list if the API returned nothing.
      const types =
        domainInstanceTypes.length > 0 ? domainInstanceTypes : instanceTypes;

      res.json({ ...summary, changeInProgress, instanceTypes: types });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to describe domain '${req.params.name}': ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  // Dry-run the change so AWS reports the deployment type (Blue/Green vs
  // DynamicUpdate) without applying it. Admin only, since it uses
  // UpdateDomainConfig and is part of the create flow.
  router.post('/domains/:name/preview', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const instanceType = (req.body?.instanceType as string | undefined)?.trim();
    const instanceCount = Number(req.body?.instanceCount);
    const volumeSizeGb = Number(req.body?.volumeSizeGb);
    if (
      !instanceType ||
      !Number.isInteger(instanceCount) ||
      instanceCount < 1 ||
      !Number.isInteger(volumeSizeGb) ||
      volumeSizeGb < MIN_VOLUME_GB
    ) {
      res.status(400).json({ error: 'invalid instanceType/instanceCount/volumeSizeGb' });
      return;
    }
    try {
      const result = await client.dryRunScaling(req.params.name, {
        instanceType,
        instanceCount,
        volumeSizeGb,
      });
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Dry-run failed for '${req.params.name}': ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  // All reservations (newest first). Viewing is open to any authenticated user.
  router.get('/requests', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    res.json(await store.listRequests());
  });

  // Create a reserved scaling request (admin only).
  router.post('/requests', async (req, res) => {
    const userRef = await requireAdmin(req, res);
    if (!userRef) return;

    const domain = (req.body?.domain as string | undefined)?.trim();
    const instanceType = (req.body?.instanceType as string | undefined)?.trim();
    const instanceCount = Number(req.body?.instanceCount);
    const volumeSizeGb = Number(req.body?.volumeSizeGb);
    const scheduledAt = (req.body?.scheduledAt as string | undefined)?.trim();
    const timezone =
      (req.body?.timezone as string | undefined)?.trim() ||
      options.defaultTimezone;
    const reason = (req.body?.reason as string | undefined)?.trim() || null;

    // 1) Input validation.
    if (!domain) {
      res.status(400).json({ error: 'domain is required' });
      return;
    }
    if (!instanceType) {
      res.status(400).json({ error: 'instanceType is required' });
      return;
    }
    if (!Number.isInteger(instanceCount) || instanceCount < 1) {
      res.status(400).json({ error: 'instanceCount must be an integer >= 1' });
      return;
    }
    if (!Number.isInteger(volumeSizeGb) || volumeSizeGb < MIN_VOLUME_GB) {
      res
        .status(400)
        .json({ error: `volumeSizeGb must be an integer >= ${MIN_VOLUME_GB}` });
      return;
    }
    const scheduledTime = scheduledAt ? Date.parse(scheduledAt) : NaN;
    if (Number.isNaN(scheduledTime)) {
      res
        .status(400)
        .json({ error: 'scheduledAt must be a valid ISO 8601 timestamp' });
      return;
    }
    if (scheduledTime <= Date.now()) {
      res.status(400).json({ error: 'scheduledAt must be in the future' });
      return;
    }
    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }

    // 2) Pre-validation: reject if a change/upgrade is already running.
    let snapshot = null;
    try {
      const summary = await client.describeDomain(domain);
      snapshot = {
        instanceType: summary.instanceType,
        instanceCount: summary.instanceCount,
        volumeSizeGb: summary.volumeSizeGb,
      };
      if (summary.processing || summary.upgradeProcessing) {
        res.status(409).json({
          error: `Domain '${domain}' already has a change in progress; try again after it completes`,
        });
        return;
      }
      if (await client.isChangeInProgress(domain)) {
        res.status(409).json({
          error: `Domain '${domain}' already has a change in progress; try again after it completes`,
        });
        return;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Pre-validation failed for '${domain}': ${msg}`);
      res.status(502).json({ error: `Failed to validate domain: ${msg}` });
      return;
    }

    // 3) Reject duplicate reservations on the same domain.
    if (await store.hasActiveRequest(domain)) {
      res.status(409).json({
        error: `Domain '${domain}' already has a scheduled or in-progress request`,
      });
      return;
    }

    // 4) Persist the reservation (absolute UTC instant).
    const request = await store.addRequest({
      domain,
      instanceType,
      instanceCount,
      volumeSizeGb,
      currentSnapshot: snapshot,
      scheduledAt: new Date(scheduledTime).toISOString(),
      timezone,
      requester: userRef,
      reason,
    });
    logger.info(
      `Scaling reservation for '${domain}' by ${userRef} at ${request.scheduledAt} (id: ${request.id})`,
    );
    res.status(201).json(request);
  });

  // Cancel a still-scheduled reservation (admin only).
  router.post('/requests/:id/cancel', async (req, res) => {
    const userRef = await requireAdmin(req, res);
    if (!userRef) return;

    const request = await store.getRequest(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    if (request.status !== 'scheduled') {
      res
        .status(400)
        .json({ error: `Only scheduled requests can be cancelled (is ${request.status})` });
      return;
    }
    const updated = await store.updateStatus(request.id, 'cancelled', {
      event: { type: 'cancelled', actor: userRef, note: 'cancelled by admin' },
    });
    logger.info(`Cancelled scaling request ${request.id} by ${userRef}`);
    res.json(updated);
  });

  return router;
}
