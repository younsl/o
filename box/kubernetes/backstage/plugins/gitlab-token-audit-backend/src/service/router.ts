import { Router } from 'express';
import express from 'express';
import {
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { parseEntityRef } from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import { TokenCache } from './TokenCache';
import { NotifiedStore } from './NotifiedStore';
import { WebhookNotifier } from './WebhookNotifier';
import { GitlabTokenService } from './GitlabTokenService';
import { GitlabToken, WebhookConfig } from './types';

export interface RouterOptions {
  cache: TokenCache;
  logger: LoggerService;
  config: Config;
  notifiedStore: NotifiedStore;
  webhookNotifier: WebhookNotifier;
  gitlabTokenService: GitlabTokenService;
  httpAuth: HttpAuthService;
  triggerScan: () => Promise<void>;
}

export function readWebhookFromConfig(config: Config): WebhookConfig | null {
  const url = config.getOptionalString('gitlabTokenAudit.webhook.url');
  if (!url) return null;
  const enabled =
    config.getOptionalBoolean('gitlabTokenAudit.webhook.enabled') ?? true;
  const rawDays = config.getOptional('gitlabTokenAudit.webhook.daysBefore');
  const daysBefore = Array.isArray(rawDays)
    ? rawDays.map(v => Number(v)).filter(n => Number.isFinite(n) && n >= 0)
    : [30, 14];
  return {
    url,
    daysBefore,
    enabled,
    updatedBy: 'system:app-config',
    updatedAt: '',
  };
}

export function tokenKey(token: GitlabToken): string {
  return `${token.kind}:${token.ownerScope ?? 'pat'}:${token.id}`;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const {
    cache,
    config,
    logger,
    notifiedStore,
    webhookNotifier,
    gitlabTokenService,
    httpAuth,
    triggerScan,
  } = options;

  // Cache GitLab server health (version + latency). 60s TTL so /status acts
  // as a 1-minute health probe without hammering GitLab on each request.
  let versionCache:
    | { value: Awaited<ReturnType<typeof gitlabTokenService.getServerVersion>>; at: number }
    | null = null;
  const getCachedVersion = async () => {
    if (versionCache && Date.now() - versionCache.at < 60 * 1000) {
      return versionCache.value;
    }
    const value = await gitlabTokenService.getServerVersion();
    versionCache = { value, at: Date.now() };
    return value;
  };

  const admins = config.getOptionalStringArray('permission.admins') ?? [];
  const isDevMode =
    config.getOptionalBoolean('backend.auth.dangerouslyDisableDefaultAuthPolicy') ?? false;

  async function tryGetUserRef(req: express.Request): Promise<string | undefined> {
    try {
      const credentials = await httpAuth.credentials(req as any, { allow: ['user'] });
      return credentials.principal.userEntityRef;
    } catch {
      if (isDevMode) return 'user:development/guest';
      return undefined;
    }
  }

  function isAdminOrGuest(userRef: string | undefined): boolean {
    if (!userRef) return false;
    if (admins.includes(userRef)) return true;
    return parseEntityRef(userRef).name === 'guest';
  }

  function adminGuard(): express.RequestHandler {
    return async (req, res, next) => {
      const userRef = await tryGetUserRef(req);
      if (!isAdminOrGuest(userRef)) {
        res.status(403).json({ error: 'Admin only' });
        return;
      }
      (req as any).userRef = userRef;
      next();
    };
  }

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/admin-status', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    const isAdmin = isAdminOrGuest(userRef);
    logger.info(
      `[gitlab-token-audit][auth-debug] /admin-status userRef=${userRef ?? 'undefined'} isAdmin=${isAdmin} admins=[${admins.join(',')}]`,
    );
    res.json({ isAdmin });
  });

  router.get('/status', adminGuard(), async (_, res) => {
    const enabled =
      config.getOptionalBoolean('gitlabTokenAudit.enabled') ?? true;
    const fetchCron =
      config.getOptionalString('gitlabTokenAudit.schedule.fetchCron') ??
      '0 */6 * * *';
    const notifyCron =
      config.getOptionalString('gitlabTokenAudit.schedule.notifyCron') ??
      '0 9 * * *';
    const webhook = readWebhookFromConfig(config);
    const tokens = cache.getTokens();
    const soonThreshold = Math.max(
      ...(webhook?.daysBefore ?? [30]),
      30,
    );

    const serverVersion = await getCachedVersion();

    res.json({
      enabled,
      fetchCron,
      notifyCron,
      webhookConfigured: !!webhook && !!webhook.url && webhook.enabled,
      lastFetchedAt: cache.getLastFetchedAt(),
      totalTokens: tokens.length,
      expiredTokens: tokens.filter(t => t.state === 'expired').length,
      expiringSoonTokens: tokens.filter(
        t =>
          t.state === 'active' &&
          t.daysUntilExpiry !== null &&
          t.daysUntilExpiry <= soonThreshold,
      ).length,
      server: {
        host: gitlabTokenService.getHost(),
        webBaseUrl: gitlabTokenService.getWebBaseUrl(),
        version: serverVersion.version,
        revision: serverVersion.revision,
        enterprise: serverVersion.enterprise,
        latencyMs: serverVersion.latencyMs,
        healthy: serverVersion.ok,
      },
    });
  });

  router.get('/tokens', adminGuard(), async (_, res) => {
    res.json(cache.getTokens());
  });

  router.post('/refresh', adminGuard(), async (_, res) => {
    try {
      await triggerScan();
      res.json({
        ok: true,
        lastFetchedAt: cache.getLastFetchedAt(),
        totalTokens: cache.getTokens().length,
      });
    } catch (err) {
      logger.error(`Manual refresh failed: ${err}`);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/webhook', adminGuard(), async (_, res) => {
    const webhook = readWebhookFromConfig(config);
    res.json(webhook ?? null);
  });

  router.get('/notifications', adminGuard(), async (_, res) => {
    const recent = await notifiedStore.listRecent(200);
    res.json({ items: recent });
  });

  router.post('/notify/preview', adminGuard(), async (req, res) => {
    try {
      const actorRef = (req as any).userRef as string;
      const { tokenKeys, reason } = req.body as {
        tokenKeys?: string[];
        reason?: string;
      };
      const webhook = readWebhookFromConfig(config);
      const allTokens = cache.getTokens();
      let candidates = allTokens;

      if (Array.isArray(tokenKeys) && tokenKeys.length > 0) {
        const set = new Set(tokenKeys);
        candidates = allTokens.filter(t => set.has(tokenKey(t)));
      } else if (webhook) {
        const maxThreshold = Math.max(...webhook.daysBefore, 0);
        candidates = allTokens.filter(
          t =>
            t.state === 'active' &&
            t.expiresAt !== null &&
            t.daysUntilExpiry !== null &&
            t.daysUntilExpiry <= maxThreshold,
        );
      } else {
        candidates = [];
      }

      const payload = webhookNotifier.buildBulkPreview(candidates, {
        trigger: 'manual',
        actorRef,
        reason,
      });

      res.json({
        candidateCount: candidates.length,
        payload,
      });
    } catch (err) {
      logger.error(`[gitlab-token-audit] preview error: ${err}`);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post('/notify/manual', adminGuard(), async (req, res) => {
    try {
      const actorRef = (req as any).userRef as string;
      const {
        tokenKeys,
        reason,
        force,
      } = req.body as {
        tokenKeys?: string[];
        reason?: string;
        force?: boolean;
      };

      const webhook = readWebhookFromConfig(config);
      if (!webhook || !webhook.url) {
        res.status(400).json({ error: 'Webhook is not configured' });
        return;
      }
      if (!webhook.enabled) {
        res.status(400).json({ error: 'Webhook is disabled' });
        return;
      }

      const allTokens = cache.getTokens();
      let candidates = allTokens;

      if (Array.isArray(tokenKeys) && tokenKeys.length > 0) {
        const set = new Set(tokenKeys);
        candidates = allTokens.filter(t => set.has(tokenKey(t)));
      } else {
        const maxThreshold = Math.max(...webhook.daysBefore, 0);
        candidates = allTokens.filter(
          t =>
            t.state === 'active' &&
            t.expiresAt !== null &&
            t.daysUntilExpiry !== null &&
            t.daysUntilExpiry <= maxThreshold,
        );
      }

      if (candidates.length === 0) {
        res.json({ sent: 0, skipped: 0, candidates: 0 });
        return;
      }

      // Per-token dedup record (unless force=true). Match the smallest
      // configured threshold the token has crossed, same logic as scheduled
      // notify. force=true bypasses dedup so a re-send can happen.
      const sorted = [...webhook.daysBefore].sort((a, b) => a - b);
      const toSend: typeof candidates = [];
      const skipped: string[] = [];
      for (const token of candidates) {
        const days = token.daysUntilExpiry;
        const matched =
          days === null ? undefined : sorted.find(t => days <= t);
        const key = tokenKey(token);
        if (!force && matched !== undefined && token.expiresAt) {
          const already = await notifiedStore.hasNotified(
            key,
            matched,
            token.expiresAt,
          );
          if (already) {
            skipped.push(key);
            continue;
          }
        }
        toSend.push(token);
      }

      if (toSend.length === 0) {
        res.json({
          sent: 0,
          skipped: skipped.length,
          candidates: candidates.length,
          note: 'All candidates already notified — use force=true to resend.',
        });
        return;
      }

      try {
        await webhookNotifier.sendBulk(webhook.url, toSend, {
          trigger: 'manual',
          actorRef,
          reason,
        });
      } catch (err) {
        logger.error(`[gitlab-token-audit] manual notify failed: ${err}`);
        res.status(502).json({
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // Record dedup entries so the next scheduled run won't re-send for the
      // same (token, threshold, expiresAt) tuple.
      for (const token of toSend) {
        const days = token.daysUntilExpiry;
        const matched =
          days === null ? undefined : sorted.find(t => days <= t);
        if (matched !== undefined && token.expiresAt) {
          await notifiedStore.record({
            tokenKey: tokenKey(token),
            threshold: matched,
            expiresAt: token.expiresAt,
            status: 'success',
          });
        }
      }

      logger.info(
        `[gitlab-token-audit] manual notify by ${actorRef}: sent=${toSend.length} skipped=${skipped.length} candidates=${candidates.length} force=${!!force}`,
      );

      res.json({
        sent: toSend.length,
        skipped: skipped.length,
        candidates: candidates.length,
      });
    } catch (err) {
      logger.error(`[gitlab-token-audit] manual notify error: ${err}`);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
