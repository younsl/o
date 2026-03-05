import { Router } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import * as fs from 'fs';
import {
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { parseEntityRef } from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import { RequestStore } from './RequestStore';
import { S3LogService } from './S3LogService';
import { CreateLogExtractInput, ReviewLogExtractInput } from './types';

export interface RouterOptions {
  logger: LoggerService;
  config: Config;
  store: RequestStore;
  s3LogService: S3LogService;
  httpAuth: HttpAuthService;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { config, logger, store, s3LogService, httpAuth } = options;

  const admins = config.getOptionalStringArray('permission.admins') ?? [];
  const isDevMode =
    config.getOptionalBoolean('backend.auth.dangerouslyDisableDefaultAuthPolicy') ?? false;

  async function tryGetUserRef(
    req: express.Request,
  ): Promise<string | undefined> {
    try {
      const credentials = await httpAuth.credentials(req as any, {
        allow: ['user'],
      });
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

  // --- Health ---

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  // --- Config info ---

  router.get('/config', (_, res) => {
    const bucket = config.getOptionalString('s3LogExtract.bucket') ?? '';
    const region = config.getOptionalString('s3LogExtract.region') ?? 'ap-northeast-2';
    const prefix = config.getOptionalString('s3LogExtract.prefix') ?? '';
    const maxTimeRangeMinutes =
      config.getOptionalNumber('s3LogExtract.maxTimeRangeMinutes') ?? 60;
    res.json({ bucket, region, prefix, maxTimeRangeMinutes });
  });

  // --- S3 Health Check (cached 1 min) ---

  let healthCache: { connected: boolean; checkedAt: string; error?: string } | null = null;
  let healthCacheExpiry = 0;

  const runHealthCheck = async () => {
    const result = await s3LogService.checkHealth();
    healthCache = result;
    healthCacheExpiry = Date.now() + 60_000;
    return result;
  };

  // Initial health check
  runHealthCheck().catch(() => {});

  // Background polling every 60s
  const healthInterval = setInterval(() => {
    runHealthCheck().catch(() => {});
  }, 60_000);
  // Cleanup on process exit
  process.on('SIGTERM', () => clearInterval(healthInterval));

  router.get('/s3-health', async (_req, res) => {
    if (healthCache && Date.now() < healthCacheExpiry) {
      res.json(healthCache);
      return;
    }
    const result = await runHealthCheck();
    res.json(result);
  });

  // --- List apps ---

  const listAppsLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });

  router.get('/apps', listAppsLimiter, async (req, res) => {
    try {
      const env = req.query.env as string;
      const date = req.query.date as string;
      const source = (req.query.source as string) || 'k8s';

      if (!env || !date) {
        res.status(400).json({ error: 'env and date are required' });
        return;
      }

      if (source !== 'k8s' && source !== 'ec2') {
        res.status(400).json({ error: 'source must be "k8s" or "ec2"' });
        return;
      }

      const apps = await s3LogService.listApps(env, date, source);
      res.json(apps);
    } catch (error) {
      logger.error(`Failed to list apps: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // --- Submit request ---

  const submitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });

  router.post('/requests', submitLimiter, async (req, res) => {
    try {
      const userRef = (await tryGetUserRef(req)) ?? 'user:default/unknown';

      const input = req.body as CreateLogExtractInput;
      if (
        !input.source ||
        !input.env ||
        !input.date ||
        !input.apps?.length ||
        !input.startTime ||
        !input.endTime ||
        !input.reason
      ) {
        res.status(400).json({
          error:
            'source, env, date, apps, startTime, endTime, and reason are required',
        });
        return;
      }

      if (input.source !== 'k8s' && input.source !== 'ec2') {
        res.status(400).json({ error: 'source must be "k8s" or "ec2"' });
        return;
      }

      // Validate time range against configured maximum
      const maxMinutes =
        config.getOptionalNumber('s3LogExtract.maxTimeRangeMinutes') ?? 60;
      const parseMinutes = (t: string) => {
        const m = t.match(/^(\d{2}):(\d{2})$/);
        return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
      };
      const startMin = parseMinutes(input.startTime);
      const endMin = parseMinutes(input.endTime);
      if (startMin !== null && endMin !== null) {
        const range = endMin >= startMin
          ? endMin - startMin
          : 24 * 60 - startMin + endMin;
        if (range > maxMinutes) {
          res.status(400).json({
            error: `Time range ${range}m exceeds maximum of ${maxMinutes}m`,
          });
          return;
        }
      }

      const request = await store.createRequest(input, userRef);
      logger.info(
        `Log extract requested [${request.id}] by ${userRef}: ${input.env} ${input.date} ${input.apps.join(',')}`,
      );

      res.status(201).json(request);
    } catch (error) {
      logger.error(`Failed to create request: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // --- List requests ---

  router.get('/requests', async (req, res) => {
    try {
      const userRef = await tryGetUserRef(req);
      const requests = await store.listRequests();

      const isGuest = userRef
        ? parseEntityRef(userRef).name === 'guest'
        : false;
      if (userRef && (admins.includes(userRef) || isGuest)) {
        res.json(requests);
        return;
      }

      if (!userRef) {
        res.status(403).json({ error: 'Authentication required' });
        return;
      }

      const filtered = requests.filter(r => r.requesterRef === userRef);
      res.json(filtered);
    } catch (error) {
      logger.error(`Failed to list requests: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // --- Get single request ---

  router.get('/requests/:id', async (req, res) => {
    try {
      const id = req.params.id as string;
      const request = await store.getRequest(id);
      if (!request) {
        res.status(404).json({ error: 'Request not found' });
        return;
      }
      res.json(request);
    } catch (error) {
      logger.error(`Failed to get request: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // --- Review request ---

  const reviewLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many review requests, please try again later' },
  });

  router.post(
    '/requests/:id/review',
    reviewLimiter,
    async (req, res) => {
      try {
        const id = req.params.id as string;
        const reviewerRef = await tryGetUserRef(req);

        if (!reviewerRef || !admins.includes(reviewerRef)) {
          res
            .status(403)
            .json({ error: 'Only admins can review requests' });
          return;
        }

        const input = req.body as ReviewLogExtractInput;

        if (!input.action || !['approve', 'reject'].includes(input.action)) {
          res
            .status(400)
            .json({ error: 'action must be "approve" or "reject"' });
          return;
        }

        if (!input.comment?.trim()) {
          res.status(400).json({ error: 'comment is required' });
          return;
        }

        const existing = await store.getRequest(id);
        if (!existing) {
          res.status(404).json({ error: 'Request not found' });
          return;
        }
        if (existing.status !== 'pending') {
          res
            .status(409)
            .json({ error: `Request already ${existing.status}` });
          return;
        }

        if (input.action === 'reject') {
          const updated = await store.updateStatus(id, 'rejected', {
            reviewerRef,
            reviewComment: input.comment,
          });
          logger.info(`Request rejected [${id}] by ${reviewerRef}`);
          res.json(updated);
          return;
        }

        // Approve: start extraction
        await store.updateStatus(id, 'approved', {
          reviewerRef,
          reviewComment: input.comment,
        });

        await store.updateStatus(id, 'extracting');

        logger.info(
          `Request approved [${id}] by ${reviewerRef}, starting extraction`,
        );

        // Run extraction asynchronously
        s3LogService
          .extractLogs(
            existing.source,
            existing.env,
            existing.date,
            existing.apps,
            existing.startTime,
            existing.endTime,
          )
          .then(async result => {
            await store.updateStatus(id, 'completed', {
              fileCount: result.fileCount,
              archiveSize: result.archiveSize,
              archivePath: result.archivePath,
              firstTimestamp: result.firstTimestamp ?? undefined,
              lastTimestamp: result.lastTimestamp ?? undefined,
            });
            logger.info(
              `Extraction completed [${id}]: ${result.fileCount} files, ${result.archiveSize} bytes`,
            );
          })
          .catch(async err => {
            const errMsg =
              err instanceof Error ? err.message : String(err);
            await store.updateStatus(id, 'failed', {
              errorMessage: errMsg,
            });
            logger.error(`Extraction failed [${id}]: ${errMsg}`);
          });

        const updated = await store.getRequest(id);
        res.json(updated);
      } catch (error) {
        logger.error(`Failed to review request: ${error}`);
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
  );

  // --- Download ---

  const downloadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many download requests, please try again later' },
  });

  router.get(
    '/requests/:id/download',
    downloadLimiter,
    async (req, res) => {
      try {
        const id = req.params.id as string;
        const userRef = await tryGetUserRef(req);
        const request = await store.getRequest(id);

        if (!request) {
          res.status(404).json({ error: 'Request not found' });
          return;
        }

        if (request.status !== 'completed') {
          res.status(400).json({ error: 'Archive is not ready' });
          return;
        }

        if (!request.archivePath || !fs.existsSync(request.archivePath)) {
          res.status(404).json({ error: 'Archive file not found' });
          return;
        }

        // Only the original requester can download
        if (!userRef || userRef !== request.requesterRef) {
          res
            .status(403)
            .json({ error: 'Only the requester can download' });
          return;
        }

        const fileName = `logs-${request.env}-${request.date}.tar.gz`;
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${fileName}"`,
        );
        res.setHeader('Content-Length', request.archiveSize ?? 0);

        const stream = fs.createReadStream(request.archivePath);
        stream.pipe(res);
      } catch (error) {
        logger.error(`Failed to download: ${error}`);
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
  );

  // --- Admin status ---

  router.get('/admin-status', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    res.json({ isAdmin: !!userRef && admins.includes(userRef) });
  });

  return router;
}
