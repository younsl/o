import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import fetch from 'node-fetch';
import https from 'https';

export interface InternalUser {
  username: string;
  backendRoles: string[];
  securityRoles: string[];
  reserved: boolean;
  hidden: boolean;
  static: boolean;
}

export interface CreateUserInput {
  /** Plaintext password (OpenSearch hashes it). Mutually exclusive with `hash`. */
  password?: string;
  /** Precomputed bcrypt hash (preferred; plaintext never leaves the requester). */
  hash?: string;
  backendRoles: string[];
  securityRoles: string[];
  attributes?: Record<string, string>;
}

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Thin client over the OpenSearch Security plugin REST API
 * (`/_plugins/_security/api/...`). Authenticates with admin basic auth.
 */
export class OpenSearchSecurityClient {
  private constructor(
    private readonly apiBase: string,
    private readonly authHeader: string,
    private readonly agent: https.Agent | undefined,
    private readonly logger: LoggerService,
  ) {}

  static fromConfig(
    config: Config,
    logger: LoggerService,
  ): OpenSearchSecurityClient | undefined {
    const sec = config.getOptionalConfig('opensearchAccount');
    const endpoint = sec?.getOptionalString('endpoint');
    const username = sec?.getOptionalString('username');
    const password = sec?.getOptionalString('password');
    if (!endpoint || !username || !password) {
      return undefined;
    }

    const base = endpoint.replace(/\/+$/, '');
    const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const rejectUnauthorized =
      sec?.getOptionalBoolean('tls.rejectUnauthorized') ?? true;
    const agent = base.startsWith('https')
      ? new https.Agent({ rejectUnauthorized })
      : undefined;

    return new OpenSearchSecurityClient(
      `${base}/_plugins/_security/api`,
      authHeader,
      agent,
      logger,
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      agent: this.agent,
      timeout: REQUEST_TIMEOUT_MS,
    } as any);

    let json: any = undefined;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    return { status: res.status, json };
  }

  async listInternalUsers(): Promise<InternalUser[]> {
    const { status, json } = await this.request('GET', '/internalusers');
    if (status !== 200) {
      throw new Error(`OpenSearch returned ${status} listing internal users`);
    }
    return Object.entries(json as Record<string, any>)
      .map(([username, u]) => ({
        username,
        backendRoles: Array.isArray(u.backend_roles) ? u.backend_roles : [],
        securityRoles: Array.isArray(u.opendistro_security_roles)
          ? u.opendistro_security_roles
          : [],
        reserved: Boolean(u.reserved),
        hidden: Boolean(u.hidden),
        static: Boolean(u.static),
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async listRoles(): Promise<string[]> {
    const { status, json } = await this.request('GET', '/roles');
    if (status !== 200) {
      throw new Error(`OpenSearch returned ${status} listing roles`);
    }
    return Object.keys(json as Record<string, unknown>).sort((a, b) =>
      a.localeCompare(b),
    );
  }

  /**
   * Distinct backend roles currently in use, gathered from internal users and
   * role mappings. Backend roles are arbitrary (IdP-driven) strings, so this is
   * a best-effort "known values" list, not an exhaustive enum.
   */
  async listBackendRoles(): Promise<string[]> {
    const set = new Set<string>();

    try {
      const users = await this.listInternalUsers();
      users.forEach(u => u.backendRoles.forEach(r => set.add(r)));
    } catch (e) {
      this.logger.debug(`Could not read users for backend roles: ${e}`);
    }

    try {
      const { status, json } = await this.request('GET', '/rolesmapping');
      if (status === 200 && json) {
        for (const v of Object.values(json as Record<string, any>)) {
          if (Array.isArray(v?.backend_roles)) {
            v.backend_roles.forEach((r: string) => set.add(r));
          }
        }
      }
    } catch (e) {
      this.logger.debug(`Could not read rolesmapping for backend roles: ${e}`);
    }

    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  async userExists(username: string): Promise<boolean> {
    const { status } = await this.request(
      'GET',
      `/internalusers/${encodeURIComponent(username)}`,
    );
    return status === 200;
  }

  async createInternalUser(
    username: string,
    input: CreateUserInput,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      backend_roles: input.backendRoles,
      opendistro_security_roles: input.securityRoles,
      attributes: input.attributes ?? {},
    };
    if (input.hash) body.hash = input.hash;
    else body.password = input.password;

    const { status, json } = await this.request(
      'PUT',
      `/internalusers/${encodeURIComponent(username)}`,
      body,
    );
    if (status !== 200 && status !== 201) {
      const msg = json?.message || json?.raw || `HTTP ${status}`;
      throw new Error(`Failed to create user '${username}': ${msg}`);
    }
    this.logger.info(`Created OpenSearch internal user '${username}'`);
  }

  /**
   * Updates an existing user's roles via JSON Patch (preserves the password
   * unless `password` is supplied). Uses `add` ops so absent fields are created.
   */
  async modifyInternalUser(
    username: string,
    input: { backendRoles: string[]; securityRoles: string[]; password?: string },
  ): Promise<void> {
    const ops: Array<{ op: string; path: string; value: unknown }> = [
      { op: 'add', path: '/backend_roles', value: input.backendRoles },
      { op: 'add', path: '/opendistro_security_roles', value: input.securityRoles },
    ];
    if (input.password) {
      ops.push({ op: 'add', path: '/password', value: input.password });
    }
    const { status, json } = await this.request(
      'PATCH',
      `/internalusers/${encodeURIComponent(username)}`,
      ops,
    );
    if (status !== 200) {
      const msg = json?.message || json?.raw || `HTTP ${status}`;
      throw new Error(`Failed to modify user '${username}': ${msg}`);
    }
    this.logger.info(`Modified OpenSearch internal user '${username}'`);
  }

  async deleteInternalUser(username: string): Promise<void> {
    const { status, json } = await this.request(
      'DELETE',
      `/internalusers/${encodeURIComponent(username)}`,
    );
    if (status === 404) {
      throw Object.assign(new Error(`User '${username}' does not exist`), {
        statusCode: 404,
      });
    }
    if (status !== 200) {
      const msg = json?.message || json?.raw || `HTTP ${status}`;
      throw new Error(`Failed to delete user '${username}': ${msg}`);
    }
    this.logger.info(`Deleted OpenSearch internal user '${username}'`);
  }
}
