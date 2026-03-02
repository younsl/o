import { Router } from 'express';
import express from 'express';
import {
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { parseEntityRef } from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import { IamUserCache } from './IamUserCache';
import { IamUserService } from './IamUserService';
import { SlackNotifier } from './SlackNotifier';
import { PasswordResetStore } from './PasswordResetStore';
import { WarningDmStore } from './WarningDmStore';
import { CreatePasswordResetInput, ReviewPasswordResetInput } from './types';

export interface RouterOptions {
  cache: IamUserCache;
  logger: LoggerService;
  config: Config;
  store: PasswordResetStore;
  warningDmStore: WarningDmStore;
  iamUserService: IamUserService;
  slackNotifier: SlackNotifier;
  httpAuth: HttpAuthService;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const {
    cache,
    config,
    logger,
    store,
    warningDmStore,
    iamUserService,
    slackNotifier,
    httpAuth,
  } = options;

  const admins = config.getOptionalStringArray('permission.admins') ?? [];
  const dryRun = config.getOptionalBoolean('iamUserAudit.dryRun') ?? false;

  const isDevMode = config.getOptionalBoolean('backend.auth.dangerouslyDisableDefaultAuthPolicy') ?? false;

  // Helper: try to extract user identity from request.
  // In dev mode (dangerouslyDisableDefaultAuthPolicy), falls back to guest identity
  // so admin-gated routes can be properly tested.
  async function tryGetUserRef(req: express.Request): Promise<string | undefined> {
    try {
      const credentials = await httpAuth.credentials(req as any, { allow: ['user'] });
      const ref = credentials.principal.userEntityRef;
      logger.info(`[auth-debug] userRef=${ref}, isAdmin=${admins.includes(ref)}`);
      return ref;
    } catch (err) {
      if (isDevMode) {
        const guestRef = 'user:development/guest';
        logger.info(`[auth-debug] dev mode fallback: ${guestRef}`);
        return guestRef;
      }
      logger.info(`[auth-debug] credentials failed: ${err}`);
      return undefined;
    }
  }

  const router = Router();
  router.use(express.json());

  // --- Existing routes ---

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/status', (_, res) => {
    const enabled =
      config.getOptionalBoolean('iamUserAudit.enabled') ?? true;
    const inactiveDays =
      config.getOptionalNumber('iamUserAudit.inactiveDays') ?? 90;
    const cron =
      config.getOptionalString('iamUserAudit.schedule.cron') ??
      '0 10 * * 1-5';
    const fetchCron =
      config.getOptionalString('iamUserAudit.schedule.fetchCron') ??
      '0 * * * *';
    const warningDays =
      config.getOptionalNumber('iamUserAudit.warningDays') ?? 14;
    const slackConfigured = !!config.getOptionalString(
      'iamUserAudit.slack.webhookUrl',
    );
    const botConfigured = !!config.getOptionalString(
      'iamUserAudit.slack.botToken',
    );
    const lastFetchedAt = cache.getLastFetchedAt();
    const users = cache.getUsers();

    res.json({
      enabled,
      inactiveDays,
      warningDays,
      cron,
      fetchCron,
      slackConfigured,
      botConfigured,
      lastFetchedAt,
      totalUsers: users.length,
      inactiveUsers: users.filter(u => u.inactiveDays >= inactiveDays).length,
    });
  });

  router.get('/status/slack-health', async (_, res) => {
    try {
      const health = await slackNotifier.healthCheck();
      res.json(health);
    } catch (error) {
      logger.error(`Failed to check Slack health: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/status/warning-dm-logs', async (req, res) => {
    try {
      const raw = req.query.userNames as string | undefined;
      if (!raw) {
        res.json({});
        return;
      }
      const userNames = raw.split(',').map(n => n.trim()).filter(Boolean);
      const logs = await warningDmStore.getLastDmMap(userNames);
      res.json(logs);
    } catch (error) {
      logger.error(`Failed to get warning DM logs: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/users', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    const allUsers = cache.getUsers();

    // Admin or guest → return all users (guest skips IAM name matching)
    const isGuest = userRef ? parseEntityRef(userRef).name === 'guest' : false;
    if (userRef && (admins.includes(userRef) || isGuest)) {
      res.json(allUsers);
      return;
    }

    // No identity → deny
    if (!userRef) {
      res.status(403).json({ error: 'Authentication required' });
      return;
    }

    // Regular user → filter to own IAM user only
    const entityName = parseEntityRef(userRef).name.toLowerCase();
    const filtered = allUsers.filter(
      u => u.userName.toLowerCase().split('@')[0] === entityName,
    );
    res.json(filtered);
  });

  // --- Password Reset routes ---

  router.post('/password-reset/requests', async (req, res) => {
    try {
      const userRef = (await tryGetUserRef(req)) ?? 'user:default/unknown';

      const input = req.body as CreatePasswordResetInput;
      if (!input.iamUserName || !input.iamUserArn || !input.reason) {
        res
          .status(400)
          .json({ error: 'iamUserName, iamUserArn, and reason are required' });
        return;
      }

      const request = await store.createRequest(input, userRef);
      logger.info(
        `Password reset requested [${request.id}] for ${input.iamUserName} by ${userRef}`,
      );

      slackNotifier.notifyPasswordResetRequest(request).catch(err => {
        logger.warn(`Slack notification failed: ${err}`);
      });

      res.status(201).json(request);
    } catch (error) {
      logger.error(`Failed to create password reset request: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/password-reset/requests', async (req, res) => {
    try {
      const userRef = await tryGetUserRef(req);
      const requests = await store.listRequests();

      // Admin or guest → return all requests
      const isGuest = userRef ? parseEntityRef(userRef).name === 'guest' : false;
      if (userRef && (admins.includes(userRef) || isGuest)) {
        res.json(requests);
        return;
      }

      // No identity → deny
      if (!userRef) {
        res.status(403).json({ error: 'Authentication required' });
        return;
      }

      // Regular user → filter to own requests only
      const filtered = requests.filter(r => r.requesterRef === userRef);
      res.json(filtered);
    } catch (error) {
      logger.error(`Failed to list password reset requests: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/password-reset/requests/:id', async (req, res) => {
    try {
      const request = await store.getRequest(req.params.id);
      if (!request) {
        res.status(404).json({ error: 'Request not found' });
        return;
      }
      res.json(request);
    } catch (error) {
      logger.error(`Failed to get password reset request: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/password-reset/requests/:id/review', async (req, res) => {
    try {
      const reviewerRef = await tryGetUserRef(req);

      // Admin check: only admins in config list can review
      if (!reviewerRef || !admins.includes(reviewerRef)) {
        res
          .status(403)
          .json({ error: 'Only admins can review password reset requests' });
        return;
      }

      const input = req.body as ReviewPasswordResetInput;

      if (!input.action || !['approve', 'reject'].includes(input.action)) {
        res
          .status(400)
          .json({ error: 'action must be "approve" or "reject"' });
        return;
      }

      if (!input.comment?.trim()) {
        res
          .status(400)
          .json({ error: 'comment is required' });
        return;
      }

      const existing = await store.getRequest(req.params.id);
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

      if (input.action === 'approve') {
        if (!input.newPassword) {
          res
            .status(400)
            .json({ error: 'newPassword is required for approval' });
          return;
        }

        // Call AWS IAM to reset the password
        if (dryRun) {
          logger.info(
            `[dryRun] Skipped AWS IAM password reset [${req.params.id}] for ${existing.iamUserName}`,
          );
        } else {
          try {
            await iamUserService.resetLoginProfile(
              existing.iamUserName,
              input.newPassword,
            );
          } catch (awsError) {
            logger.error(
              `AWS IAM password reset failed [${req.params.id}] for ${existing.iamUserName}: ${awsError}`,
            );
            res.status(502).json({
              error: `AWS IAM password reset failed: ${awsError instanceof Error ? awsError.message : 'Unknown AWS error'}`,
            });
            return;
          }
        }
        logger.info(
          `Password reset approved [${req.params.id}] for ${existing.iamUserName} by ${reviewerRef}`,
        );

        // Send DM with temporary password to requester
        if (existing.requesterEmail) {
          slackNotifier
            .sendPasswordDm(existing.requesterEmail, existing.iamUserName, input.newPassword, existing.id, reviewerRef)
            .catch(err => {
              logger.warn(`[slack] Failed to send password DM: ${err}`);
            });
        } else {
          logger.info(`[slack] Skipping password DM: requesterEmail is empty for request ${existing.id}`);
        }
      }

      const status = input.action === 'approve' ? 'approved' : 'rejected';
      if (input.action === 'reject') {
        logger.info(
          `Password reset rejected [${req.params.id}] for ${existing.iamUserName} by ${reviewerRef}`,
        );

        // Send rejection DM to requester
        if (existing.requesterEmail) {
          slackNotifier
            .sendRejectionDm(existing.requesterEmail, existing.iamUserName, existing.id, reviewerRef, input.comment)
            .catch(err => {
              logger.warn(`[slack] Failed to send rejection DM: ${err}`);
            });
        } else {
          logger.info(`[slack] Skipping rejection DM: requesterEmail is empty for request ${existing.id}`);
        }
      }
      const updated = await store.updateStatus(
        req.params.id,
        status,
        reviewerRef,
        input.comment,
      );

      if (updated) {
        slackNotifier.notifyPasswordResetReview(updated).catch(err => {
          logger.warn(`Slack notification failed: ${err}`);
        });
      }

      res.json(updated);
    } catch (error) {
      logger.error(`Failed to review password reset request: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/password-reset/admin-status', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    res.json({ isAdmin: !!userRef && admins.includes(userRef) });
  });

  // --- Admin routes ---

  const emailDomain = config.getOptionalString('iamUserAudit.slack.emailDomain') ?? '';

  function deriveEmail(userName: string): string {
    if (userName.includes('@')) return userName;
    if (!emailDomain) return userName;
    return `${userName}@${emailDomain}`;
  }

  router.post('/admin/check-slack-users', async (req, res) => {
    try {
      const userRef = await tryGetUserRef(req);
      if (!userRef || !admins.includes(userRef)) {
        res.status(403).json({ error: 'Only admins can check Slack users' });
        return;
      }

      const { userNames } = req.body as { userNames: string[] };
      if (!Array.isArray(userNames) || userNames.length === 0) {
        res.status(400).json({ error: 'userNames array is required' });
        return;
      }

      const results: Record<string, boolean> = {};
      for (const userName of userNames) {
        const email = deriveEmail(userName);
        results[userName] = await slackNotifier.checkSlackUser(email);
      }

      res.json(results);
    } catch (error) {
      logger.error(`Failed to check Slack users: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/admin/slack-user-info', async (req, res) => {
    try {
      const userRef = await tryGetUserRef(req);
      if (!userRef || !admins.includes(userRef)) {
        res.status(403).json({ error: 'Only admins can lookup Slack users' });
        return;
      }

      const userName = req.query.userName as string;
      if (!userName) {
        res.status(400).json({ error: 'userName query parameter is required' });
        return;
      }

      const email = deriveEmail(userName);
      const slackUser = await slackNotifier.lookupSlackUser(email);
      if (!slackUser) {
        res.status(404).json({ error: `Slack user not found for ${email}` });
        return;
      }

      res.json(slackUser);
    } catch (error) {
      logger.error(`Failed to lookup Slack user: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/admin/notify-user', async (req, res) => {
    try {
      const userRef = await tryGetUserRef(req);
      if (!userRef || !admins.includes(userRef)) {
        res.status(403).json({ error: 'Only admins can send status notifications' });
        return;
      }

      const input = req.body as { userName: string; message: string };
      if (!input.message?.trim()) {
        res.status(400).json({ error: 'message is required' });
        return;
      }

      const allUsers = cache.getUsers();
      const user = allUsers.find(u => u.userName === input.userName);
      if (!user) {
        res.status(404).json({ error: `IAM user ${input.userName} not found` });
        return;
      }

      const email = deriveEmail(input.userName);
      try {
        await slackNotifier.sendStatusDm(
          email,
          user,
          user.inactiveDays,
          userRef,
          input.message.trim(),
        );
        await warningDmStore.recordDm({
          iamUserName: input.userName,
          senderRef: userRef,
          platform: 'slack',
          status: 'success',
        });
      } catch (sendError) {
        await warningDmStore.recordDm({
          iamUserName: input.userName,
          senderRef: userRef,
          platform: 'slack',
          status: 'failed',
          errorMessage: sendError instanceof Error ? sendError.message : String(sendError),
        });
        throw sendError;
      }

      res.json({ success: true });
    } catch (error) {
      logger.error(`Failed to send status notification: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
