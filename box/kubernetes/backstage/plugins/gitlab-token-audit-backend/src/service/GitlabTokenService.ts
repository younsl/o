import fetch from 'node-fetch';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import {
  GitlabToken,
  GitlabTokenKind,
  GitlabTokenState,
} from './types';

interface GitlabApiToken {
  id: number;
  name: string;
  description?: string | null;
  user_id?: number;
  scopes?: string[];
  revoked?: boolean;
  active?: boolean;
  created_at: string;
  last_used_at?: string | null;
  expires_at?: string | null;
  /** Numeric access level for project/group access tokens (10/20/30/40/50). */
  access_level?: number;
  /** True for admin-created impersonation tokens (PAT only). */
  impersonation?: boolean;
}

/**
 * Exclude entries support either exact path match or `/regex/flags` form.
 * Example: 'archived/old-service' (exact) or '/^archived\\//' (regex).
 */
interface ExcludeMatcher {
  exact: Set<string>;
  regexes: RegExp[];
  empty: boolean;
}

function compileExcludeMatcher(
  raw: string[],
  logger: LoggerService,
  label: string,
): ExcludeMatcher {
  const exact = new Set<string>();
  const regexes: RegExp[] = [];
  for (const pattern of raw) {
    const m = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) {
      try {
        regexes.push(new RegExp(m[1], m[2]));
      } catch (err) {
        logger.warn(
          `[gitlab-token-audit] ${label}: invalid regex "${pattern}": ${err}`,
        );
      }
    } else {
      exact.add(pattern);
    }
  }
  return { exact, regexes, empty: exact.size === 0 && regexes.length === 0 };
}

function matchesExclude(matcher: ExcludeMatcher, value: string): boolean {
  if (matcher.empty) return false;
  if (matcher.exact.has(value)) return true;
  return matcher.regexes.some(r => r.test(value));
}

export class GitlabTokenService {
  private readonly host: string;
  private readonly apiBaseUrl: string;
  private readonly webBaseUrl: string;
  private readonly token: string;
  private readonly logger: LoggerService;
  private readonly includeProjects: string[];
  private readonly includeGroups: string[];
  private readonly excludeProjects: ExcludeMatcher;
  private readonly excludeGroups: ExcludeMatcher;

  constructor(options: { config: Config; logger: LoggerService }) {
    const { config, logger } = options;
    this.logger = logger;

    const integrations = config.getConfigArray('integrations.gitlab');
    const first = integrations[0];
    if (!first) {
      throw new Error('No GitLab integration configured');
    }
    this.host = first.getString('host');
    this.apiBaseUrl =
      first.getOptionalString('apiBaseUrl') ?? `https://${this.host}/api/v4`;
    // Strip the API path off to derive the web UI base. e.g.
    // 'https://gitlab.example.com/api/v4' -> 'https://gitlab.example.com'.
    this.webBaseUrl = this.apiBaseUrl.replace(/\/api\/v\d+\/?$/, '');
    this.token = first.getString('token');

    this.includeProjects =
      config.getOptionalStringArray('gitlabTokenAudit.scope.includeProjects') ?? [];
    this.includeGroups =
      config.getOptionalStringArray('gitlabTokenAudit.scope.includeGroups') ?? [];
    this.excludeProjects = compileExcludeMatcher(
      config.getOptionalStringArray('gitlabTokenAudit.scope.excludeProjects') ?? [],
      this.logger,
      'excludeProjects',
    );
    this.excludeGroups = compileExcludeMatcher(
      config.getOptionalStringArray('gitlabTokenAudit.scope.excludeGroups') ?? [],
      this.logger,
      'excludeGroups',
    );
  }

  getHost(): string {
    return this.host;
  }

  getWebBaseUrl(): string {
    return this.webBaseUrl;
  }

  async getServerVersion(): Promise<{
    version: string | null;
    revision: string | null;
    enterprise: boolean | null;
    latencyMs: number | null;
    ok: boolean;
  }> {
    const startedAt = Date.now();
    try {
      const res = await fetch(`${this.apiBaseUrl}/version`, {
        headers: { 'PRIVATE-TOKEN': this.token },
      });
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        return {
          version: null,
          revision: null,
          enterprise: null,
          latencyMs,
          ok: false,
        };
      }
      const body = (await res.json()) as {
        version?: string;
        revision?: string;
        enterprise?: boolean;
      };
      return {
        version: body.version ?? null,
        revision: body.revision ?? null,
        enterprise: typeof body.enterprise === 'boolean' ? body.enterprise : null,
        latencyMs,
        ok: true,
      };
    } catch {
      return {
        version: null,
        revision: null,
        enterprise: null,
        latencyMs: Date.now() - startedAt,
        ok: false,
      };
    }
  }

  async listAllTokens(): Promise<GitlabToken[]> {
    const all: GitlabToken[] = [];

    try {
      const pats = await this.listPersonalAccessTokens();
      all.push(...pats);
    } catch (err) {
      this.logger.warn(`[gitlab-token-audit] PAT fetch failed: ${err}`);
    }

    for (const project of this.includeProjects) {
      try {
        const tokens = await this.listProjectAccessTokens(project);
        all.push(...tokens);
      } catch (err) {
        this.logger.warn(
          `[gitlab-token-audit] project ${project} token fetch failed: ${err}`,
        );
      }
    }

    for (const group of this.includeGroups) {
      try {
        const tokens = await this.listGroupAccessTokens(group);
        all.push(...tokens);
      } catch (err) {
        this.logger.warn(
          `[gitlab-token-audit] group ${group} token fetch failed: ${err}`,
        );
      }
    }

    await this.populateUserNames(all);
    const ownerPaths = await this.resolveBotOwnerPaths(all);
    // GitLab's `/personal_access_tokens` endpoint returns project/group bot
    // tokens mixed with human PATs. Re-classify them by inspecting the bot
    // username pattern and lifting the resolved owner path into `ownerScope`.
    for (const t of all) {
      if (t.kind === 'personal' && t.userName) {
        const p = t.userName.match(/^project_(\d+)_bot_/);
        const g = t.userName.match(/^group_(\d+)_bot_/);
        if (p) {
          t.kind = 'project';
          // Only set ownerScope if we resolved a real path; otherwise leave
          // undefined so buildWebUrl correctly emits no link.
          const path = ownerPaths.projects[Number(p[1])];
          if (path) t.ownerScope = path;
        } else if (g) {
          t.kind = 'group';
          const path = ownerPaths.groups[Number(g[1])];
          if (path) t.ownerScope = path;
        }
      }
      t.webUrl = this.buildWebUrl(t, ownerPaths);
    }

    if (this.excludeProjects.empty && this.excludeGroups.empty) {
      return all;
    }
    const before = all.length;
    const filtered = all.filter(t => {
      if (
        t.kind === 'project' &&
        t.ownerScope &&
        matchesExclude(this.excludeProjects, t.ownerScope)
      ) {
        return false;
      }
      if (
        t.kind === 'group' &&
        t.ownerScope &&
        matchesExclude(this.excludeGroups, t.ownerScope)
      ) {
        return false;
      }
      return true;
    });
    if (before !== filtered.length) {
      this.logger.info(
        `[gitlab-token-audit] excluded ${before - filtered.length} tokens (excludeProjects=${this.excludeProjects.exact.size + this.excludeProjects.regexes.length}, excludeGroups=${this.excludeGroups.exact.size + this.excludeGroups.regexes.length})`,
      );
    }
    return filtered;
  }

  /**
   * For project/group bot users in PAT listings, resolve their target
   * project/group ID to a `path_with_namespace` so we can build the canonical
   * settings URL. Returns two maps keyed by ID. Lookups failing (deleted
   * project, insufficient token scope) are skipped; the corresponding token
   * just gets no webUrl.
   */
  private async resolveBotOwnerPaths(
    tokens: GitlabToken[],
  ): Promise<{ projects: Record<number, string>; groups: Record<number, string> }> {
    const projectIds = new Set<number>();
    const groupIds = new Set<number>();
    for (const t of tokens) {
      const u = t.userName ?? '';
      const p = u.match(/^project_(\d+)_bot_/);
      const g = u.match(/^group_(\d+)_bot_/);
      if (p) projectIds.add(Number(p[1]));
      if (g) groupIds.add(Number(g[1]));
    }

    const projects: Record<number, string> = {};
    const groups: Record<number, string> = {};

    const concurrency = 10;
    const tasks: Array<{ kind: 'project' | 'group'; id: number }> = [
      ...Array.from(projectIds).map(id => ({ kind: 'project' as const, id })),
      ...Array.from(groupIds).map(id => ({ kind: 'group' as const, id })),
    ];
    let index = 0;
    const worker = async () => {
      while (index < tasks.length) {
        const job = tasks[index++];
        try {
          const url =
            job.kind === 'project'
              ? `${this.apiBaseUrl}/projects/${job.id}`
              : `${this.apiBaseUrl}/groups/${job.id}`;
          const res = await fetch(url, {
            headers: { 'PRIVATE-TOKEN': this.token },
          });
          if (!res.ok) continue;
          const body = (await res.json()) as {
            path_with_namespace?: string;
            full_path?: string;
          };
          const path = body.path_with_namespace ?? body.full_path;
          if (!path) continue;
          if (job.kind === 'project') projects[job.id] = path;
          else groups[job.id] = path;
        } catch (err) {
          this.logger.debug?.(
            `[gitlab-token-audit] ${job.kind} ${job.id} resolve failed: ${err}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, tasks.length) }, () =>
        worker(),
      ),
    );
    return { projects, groups };
  }

  private buildWebUrl(
    token: GitlabToken,
    ownerPaths: { projects: Record<number, string>; groups: Record<number, string> },
  ): string | undefined {
    const base = this.webBaseUrl;
    const fragment = `#token-${token.id}`;
    const username = token.userName ?? '';
    const projectBotMatch = username.match(/^project_(\d+)_bot_/);
    const groupBotMatch = username.match(/^group_(\d+)_bot_/);

    switch (token.kind) {
      case 'personal':
        if (projectBotMatch) {
          const projectId = Number(projectBotMatch[1]);
          const path = ownerPaths.projects[projectId];
          // Without a resolved path, no working URL exists — skip rather than
          // emit a 404. (Project deleted, or token lacks read_api on it.)
          return path
            ? `${base}/${path}/-/settings/access_tokens${fragment}`
            : undefined;
        }
        if (groupBotMatch) {
          const groupId = Number(groupBotMatch[1]);
          const path = ownerPaths.groups[groupId];
          return path
            ? `${base}/groups/${path}/-/settings/access_tokens${fragment}`
            : undefined;
        }
        return token.userName
          ? `${base}/admin/users/${encodeURIComponent(token.userName)}`
          : undefined;
      case 'project':
        return token.ownerScope
          ? `${base}/${token.ownerScope}/-/settings/access_tokens${fragment}`
          : undefined;
      case 'group':
        return token.ownerScope
          ? `${base}/groups/${token.ownerScope}/-/settings/access_tokens${fragment}`
          : undefined;
      default:
        return undefined;
    }
  }

  private async populateUserNames(tokens: GitlabToken[]): Promise<void> {
    const idsNeeded = new Set<number>();
    for (const t of tokens) {
      if (t.userId && !t.userName) idsNeeded.add(t.userId);
    }
    if (idsNeeded.size === 0) return;

    const ids = Array.from(idsNeeded);
    const map: Record<number, { username: string; name?: string }> = {};
    const concurrency = 10;
    let index = 0;

    const worker = async () => {
      while (index < ids.length) {
        const i = index++;
        const id = ids[i];
        try {
          const res = await fetch(`${this.apiBaseUrl}/users/${id}`, {
            headers: { 'PRIVATE-TOKEN': this.token },
          });
          if (!res.ok) continue;
          const body = (await res.json()) as { username: string; name?: string };
          map[id] = { username: body.username, name: body.name };
        } catch (err) {
          this.logger.debug?.(
            `[gitlab-token-audit] user ${id} resolve failed: ${err}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()),
    );

    for (const t of tokens) {
      if (t.userId && map[t.userId]) {
        t.userName = map[t.userId].username;
      }
    }
  }

  private async listPersonalAccessTokens(): Promise<GitlabToken[]> {
    const raw = await this.paginate('/personal_access_tokens');
    return raw.map(t => this.normalize(t, 'personal'));
  }

  private async listProjectAccessTokens(
    projectIdOrPath: string,
  ): Promise<GitlabToken[]> {
    const encoded = encodeURIComponent(projectIdOrPath);
    const raw = await this.paginate(`/projects/${encoded}/access_tokens`);
    return raw.map(t =>
      this.normalize(t, 'project', {
        ownerScope: projectIdOrPath,
      }),
    );
  }

  private async listGroupAccessTokens(
    groupIdOrPath: string,
  ): Promise<GitlabToken[]> {
    const encoded = encodeURIComponent(groupIdOrPath);
    const raw = await this.paginate(`/groups/${encoded}/access_tokens`);
    return raw.map(t =>
      this.normalize(t, 'group', {
        ownerScope: groupIdOrPath,
      }),
    );
  }

  private async paginate(path: string): Promise<GitlabApiToken[]> {
    const collected: GitlabApiToken[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const url = `${this.apiBaseUrl}${path}?per_page=${perPage}&page=${page}`;
      const res = await fetch(url, {
        headers: {
          'PRIVATE-TOKEN': this.token,
        },
      });
      if (!res.ok) {
        throw new Error(
          `GitLab API ${path} returned ${res.status} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as GitlabApiToken[];
      collected.push(...body);
      const nextPage = res.headers.get('x-next-page');
      if (!nextPage) break;
      page = Number(nextPage);
      if (!page) break;
    }
    return collected;
  }

  private normalize(
    raw: GitlabApiToken,
    kind: GitlabTokenKind,
    extra: { ownerScope?: string } = {},
  ): GitlabToken {
    const expiresAt = raw.expires_at ?? null;
    const daysUntilExpiry = expiresAt
      ? Math.floor(
          (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        )
      : null;

    const revoked = !!raw.revoked;
    const active = raw.active !== false && !revoked;

    let state: GitlabTokenState;
    if (revoked) {
      state = 'revoked';
    } else if (!active) {
      state = 'inactive';
    } else if (daysUntilExpiry !== null && daysUntilExpiry < 0) {
      state = 'expired';
    } else {
      state = 'active';
    }

    return {
      id: raw.id,
      kind,
      name: raw.name,
      description: raw.description ?? null,
      userId: raw.user_id,
      scopes: raw.scopes ?? [],
      active,
      revoked,
      createdAt: raw.created_at,
      lastUsedAt: raw.last_used_at ?? null,
      expiresAt,
      daysUntilExpiry,
      state,
      ownerScope: extra.ownerScope,
      accessLevel: raw.access_level,
      impersonation: raw.impersonation,
    };
  }
}
