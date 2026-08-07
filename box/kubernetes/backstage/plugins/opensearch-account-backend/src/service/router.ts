import { Router } from 'express';
import express from 'express';
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { OpenSearchSecurityClient } from './OpenSearchClient';
import {
  AccountRequest,
  AccountRequestStore,
  AccountAction,
} from './AccountRequestStore';

/** Parse an attributes object from the request body, keeping string entries only. */
function parseAttributes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k.trim() !== '' && (typeof v === 'string' || typeof v === 'number')) {
        out[k] = String(v);
      }
    }
  }
  return out;
}

export interface RouterOptions {
  logger: LoggerService;
  config: Config;
  httpAuth: HttpAuthService;
  store: AccountRequestStore;
  client?: OpenSearchSecurityClient;
}

// OpenSearch internal usernames: letters, digits, and . _ @ - only.
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{2,64}$/;

/**
 * Generates a random password guaranteed to contain an uppercase, lowercase,
 * digit, and symbol, satisfying the default OpenSearch password policy.
 */
function generatePassword(): string {
  const bytes = randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  return `${bytes}Aa1!`;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { logger, config, httpAuth, store, client } = options;

  const admins = config.getOptionalStringArray('permission.admins') ?? [];
  const requiresApproval =
    config.getOptionalBoolean('opensearchAccount.requiresApproval') ?? true;
  // The master account the plugin authenticates with; never deletable.
  const masterUsername =
    config.getOptionalString('opensearchAccount.username') ?? '';
  const isDevMode =
    config.getOptionalBoolean(
      'backend.auth.dangerouslyDisableDefaultAuthPolicy',
    ) ?? false;

  async function tryGetUserRef(req: express.Request): Promise<string | undefined> {
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

  function requireClient(res: express.Response): boolean {
    if (!client) {
      res.status(503).json({
        error:
          'OpenSearch is not configured: set opensearchAccount.endpoint/username/password',
      });
      return false;
    }
    return true;
  }

  /** Run the OpenSearch side-effect for a request; returns generated password for create/reset. */
  async function execute(
    request: AccountRequest,
    opts?: { resetPassword?: boolean },
  ): Promise<{ generatedPassword?: string }> {
    if (!client) throw new Error('OpenSearch client not configured');

    if (request.action === 'create') {
      if (await client.userExists(request.username)) {
        throw Object.assign(
          new Error(`User '${request.username}' already exists`),
          { statusCode: 409 },
        );
      }
      // Use the bcrypt hash captured at request time; plaintext is never stored.
      const hash = await store.getPasswordHash(request.id);
      if (!hash) {
        throw new Error('Stored password hash is missing for this request');
      }
      await client.createInternalUser(request.username, {
        hash,
        backendRoles: request.backendRoles,
        securityRoles: request.securityRoles,
        attributes: {
          ...request.attributes,
          created_by: 'backstage',
          requester: request.requester,
        },
      });
      return {};
    }

    if (request.action === 'modify') {
      if (!(await client.userExists(request.username))) {
        throw Object.assign(
          new Error(`User '${request.username}' does not exist`),
          { statusCode: 404 },
        );
      }
      const password = opts?.resetPassword ? generatePassword() : undefined;
      await client.modifyInternalUser(request.username, {
        backendRoles: request.backendRoles,
        securityRoles: request.securityRoles,
        password,
      });
      return password ? { generatedPassword: password } : {};
    }

    // delete (defense-in-depth: the master account is never deletable)
    if (masterUsername && request.username === masterUsername) {
      throw Object.assign(
        new Error(`Refusing to delete the master account '${masterUsername}'`),
        { statusCode: 400 },
      );
    }
    await client.deleteInternalUser(request.username);
    return {};
  }

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, res) => res.json({ status: 'ok' }));

  router.get('/config', (_, res) => {
    res.json({ configured: Boolean(client), requiresApproval, masterUsername });
  });

  router.get('/user-role', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    res.json({ isAdmin: !!userRef && admins.includes(userRef), admins });
  });

  // 조회: list existing internal users (admin-only)
  router.get('/accounts', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    if (!requireClient(res)) return;
    try {
      const users = await client!.listInternalUsers();
      res.json(users);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to list accounts: ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  // role names for the create form
  router.get('/roles', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    if (!requireClient(res)) return;
    try {
      res.json(await client!.listRoles());
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to list roles: ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  // known backend roles (from existing users + role mappings) for the form
  router.get('/backend-roles', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    if (!requireClient(res)) return;
    try {
      res.json(await client!.listBackendRoles());
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to list backend roles: ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  // create a create/delete request (or execute directly when approval is off)
  router.post('/requests', async (req, res) => {
    const userRef = await requireUser(req, res);
    if (!userRef) return;
    if (!requireClient(res)) return;

    const action = req.body?.action as AccountAction | undefined;
    const username = (req.body?.username as string | undefined)?.trim();
    const backendRoles: string[] = Array.isArray(req.body?.backendRoles)
      ? req.body.backendRoles.filter((r: unknown) => typeof r === 'string')
      : [];
    const securityRoles: string[] = Array.isArray(req.body?.securityRoles)
      ? req.body.securityRoles.filter((r: unknown) => typeof r === 'string')
      : [];
    const attributes = parseAttributes(req.body?.attributes);
    const reason = (req.body?.reason as string | undefined)?.trim() || null;
    const password = req.body?.password as string | undefined;

    if (action !== 'create' && action !== 'delete' && action !== 'modify') {
      res.status(400).json({ error: "action must be 'create', 'delete', or 'modify'" });
      return;
    }
    if (!username || !USERNAME_PATTERN.test(username)) {
      res.status(400).json({
        error: 'username is required (letters, digits, . _ @ - ; 2-64 chars)',
      });
      return;
    }

    // Guardrail: never delete the master/admin account the plugin authenticates with.
    if (action === 'delete' && masterUsername && username === masterUsername) {
      res.status(400).json({
        error: `Refusing to delete the configured master account '${masterUsername}'`,
      });
      return;
    }

    const requester = userRef;
    const isAdmin = admins.includes(userRef);

    // Regular users may only submit create requests; delete/modify are admin-only.
    if ((action === 'delete' || action === 'modify') && !isAdmin) {
      res.status(403).json({ error: `Only admins can ${action} accounts` });
      return;
    }

    // Delete requires a justification reason recorded in the audit log.
    if (action === 'delete' && !reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }

    // Create requires a requester-supplied password (stored only as a bcrypt
    // hash) and a justification reason.
    let passwordHash: string | null = null;
    if (action === 'create') {
      if (!password || typeof password !== 'string' || password.length < 8) {
        res.status(400).json({ error: 'password is required (min 8 characters)' });
        return;
      }
      if (!reason) {
        res.status(400).json({ error: 'reason is required' });
        return;
      }
      passwordHash = await bcrypt.hash(password, 10);
    }

    const rolesRelevant = action === 'create' || action === 'modify';
    const baseInput = {
      action,
      username,
      backendRoles: rolesRelevant ? backendRoles : [],
      securityRoles: rolesRelevant ? securityRoles : [],
      attributes: action === 'create' ? attributes : {},
      requester,
      reason,
      passwordHash,
    };

    // Modify and delete are admin-only, immediate actions (no approval): they
    // execute right away and are recorded in the requests DB for audit.
    if (action === 'modify' || action === 'delete') {
      const request = await store.addRequest({ ...baseInput, status: 'pending' });
      try {
        const resetPassword = req.body?.resetPassword === true;
        const { generatedPassword } = await execute(request, { resetPassword });
        const updated = await store.updateStatus(request.id, 'executed', {
          reviewer: requester,
          event: { type: 'executed', actor: requester, note: `admin ${action}` },
        });
        logger.info(`Admin ${requester} ${action} account '${username}'`);
        res.status(201).json({ ...updated, generatedPassword });
      } catch (error: any) {
        const msg = error instanceof Error ? error.message : String(error);
        await store.updateStatus(request.id, 'failed', {
          reviewer: requester,
          errorMessage: msg,
          event: { type: 'failed', actor: requester, note: msg },
        });
        logger.error(`Failed to ${action} '${username}': ${msg}`);
        res.status(error.statusCode ?? 502).json({ error: msg });
      }
      return;
    }

    if (requiresApproval) {
      const request = await store.addRequest({ ...baseInput, status: 'pending' });
      logger.info(
        `OpenSearch ${action} request for '${username}' queued by ${requester} (id: ${request.id})`,
      );
      res.status(202).json(request);
      return;
    }

    // Approval disabled: execute immediately.
    try {
      const request = await store.addRequest({ ...baseInput, status: 'pending' });
      const { generatedPassword } = await execute(request);
      const updated = await store.updateStatus(request.id, 'executed', {
        reviewer: requester,
        event: { type: 'executed', actor: requester, note: null },
      });
      res.status(201).json({ ...updated, generatedPassword });
    } catch (error: any) {
      const statusCode = error.statusCode ?? 502;
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to ${action} '${username}': ${msg}`);
      res.status(statusCode).json({ error: msg });
    }
  });

  // Admins see all requests; regular users see only their own.
  router.get('/requests', async (req, res) => {
    const userRef = await requireUser(req, res);
    if (!userRef) return;
    const isAdmin = admins.includes(userRef);
    res.json(await store.listRequests(isAdmin ? undefined : userRef));
  });

  router.get('/requests/:id', async (req, res) => {
    const userRef = await requireUser(req, res);
    if (!userRef) return;
    const request = await store.getRequest(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    if (!admins.includes(userRef) && request.requester !== userRef) {
      res.status(403).json({ error: 'You can only view your own requests' });
      return;
    }
    res.json(request);
  });

  router.post('/requests/:id/approve', async (req, res) => {
    if (!requireClient(res)) return;

    const userRef = await tryGetUserRef(req);
    if (!userRef || !admins.includes(userRef)) {
      res.status(403).json({ error: 'Only admins can approve requests' });
      return;
    }
    const reason = (req.body?.reason as string | undefined)?.trim();
    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }

    const request = await store.getRequest(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    if (request.status !== 'pending') {
      res.status(400).json({ error: `Request already ${request.status}` });
      return;
    }

    // Record the approval decision distinctly from its execution result.
    await store.addEvent(request.id, 'approved', userRef, reason);
    try {
      const { generatedPassword } = await execute(request);
      const updated = await store.updateStatus(request.id, 'executed', {
        reviewer: userRef,
        reviewerNote: reason,
        errorMessage: null,
        event: { type: 'executed', actor: userRef, note: null },
      });
      logger.info(
        `Approved & executed ${request.action} '${request.username}' by ${userRef}`,
      );
      // generatedPassword is returned once here and never persisted.
      res.json({ ...updated, generatedPassword });
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      await store.updateStatus(request.id, 'failed', {
        reviewer: userRef,
        reviewerNote: reason,
        errorMessage: msg,
        event: { type: 'failed', actor: userRef, note: msg },
      });
      logger.error(`Execution failed for request ${request.id}: ${msg}`);
      res.status(error.statusCode ?? 502).json({ error: msg });
    }
  });

  router.post('/requests/:id/reject', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    if (!userRef || !admins.includes(userRef)) {
      res.status(403).json({ error: 'Only admins can reject requests' });
      return;
    }
    const reason = (req.body?.reason as string | undefined)?.trim();
    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }

    const request = await store.getRequest(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    if (request.status !== 'pending') {
      res.status(400).json({ error: `Request already ${request.status}` });
      return;
    }

    const updated = await store.updateStatus(request.id, 'rejected', {
      reviewer: userRef,
      reviewerNote: reason,
      event: { type: 'rejected', actor: userRef, note: reason },
    });
    logger.info(
      `Rejected ${request.action} request '${request.username}' by ${userRef}`,
    );
    res.json(updated);
  });

  return router;
}
