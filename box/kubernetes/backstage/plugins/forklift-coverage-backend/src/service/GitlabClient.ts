import fetch, { Response } from 'node-fetch';
import { LoggerService } from '@backstage/backend-plugin-api';

/** Thrown for 404/403 so callers can treat "not there" as a normal outcome. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export interface GitlabClientOptions {
  apiBaseUrl: string;
  token: string;
  logger: LoggerService;
  /** Max API requests per second across all in-flight scans. */
  rps?: number;
  retries?: number;
  /** Global stall in seconds after a 429 without a Retry-After header. */
  cooldownSeconds?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Rate-limited GitLab REST client.
 *
 * A 429 stalls every caller, not just the one that hit it: per-request backoff
 * alone leaves the other workers firing at the same rate, so the instance
 * never gets back under its limit.
 */
export class GitlabClient {
  private readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly logger: LoggerService;
  private readonly minIntervalMs: number;
  private readonly retries: number;
  private readonly cooldownMs: number;

  private nextSlotAt = 0;
  private pausedUntil = 0;

  constructor(options: GitlabClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.logger = options.logger;
    this.minIntervalMs = 1000 / Math.max(1, options.rps ?? 20);
    this.retries = options.retries ?? 3;
    this.cooldownMs = (options.cooldownSeconds ?? 30) * 1000;
  }

  /** Serialises callers onto a fixed-interval schedule and honours the pause. */
  private async takeSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const waitForPause = this.pausedUntil - now;
      if (waitForPause > 0) {
        await sleep(waitForPause);
        continue;
      }
      const slot = Math.max(now, this.nextSlotAt);
      this.nextSlotAt = slot + this.minIntervalMs;
      const delay = slot - now;
      if (delay > 0) await sleep(delay);
      return;
    }
  }

  private pause(ms: number): void {
    const until = Date.now() + ms;
    if (until > this.pausedUntil) this.pausedUntil = until;
  }

  private async request(path: string): Promise<Response> {
    const url = path.startsWith('http')
      ? path
      : `${this.apiBaseUrl}/${path.replace(/^\//, '')}`;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.takeSlot();
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { 'PRIVATE-TOKEN': this.token },
          timeout: 60_000,
        } as any);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await sleep(500 * (attempt + 1));
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : this.cooldownMs;
        this.logger.warn(
          `[forklift-coverage] 429 from GitLab, pausing all requests for ${Math.round(waitMs / 1000)}s`,
        );
        this.pause(waitMs);
        lastError = new Error('GitLab API rate limited (429)');
        continue;
      }

      if (res.status === 404 || res.status === 403) {
        throw new NotFoundError(`GitLab API ${path} returned ${res.status}`);
      }

      if (res.status >= 500) {
        lastError = new Error(`GitLab API ${path} returned ${res.status}`);
        await sleep(500 * (attempt + 1));
        continue;
      }

      if (!res.ok) {
        throw new Error(
          `GitLab API ${path} returned ${res.status} ${res.statusText}`,
        );
      }

      return res;
    }

    throw lastError ?? new Error(`GitLab API ${path} failed`);
  }

  async getJson<T>(path: string): Promise<T> {
    const res = await this.request(path);
    return (await res.json()) as T;
  }

  async getText(path: string): Promise<string> {
    const res = await this.request(path);
    return res.text();
  }

  /** Follows GitLab's `x-next-page` header until the last page. */
  async getJsonPages<T>(path: string): Promise<T[]> {
    const collected: T[] = [];
    let page = 1;
    for (;;) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await this.request(`${path}${sep}page=${page}`);
      const body = (await res.json()) as T[];
      if (!Array.isArray(body)) break;
      collected.push(...body);
      const next = res.headers.get('x-next-page');
      if (!next) break;
      const parsed = Number(next);
      if (!parsed || parsed <= page) break;
      page = parsed;
    }
    return collected;
  }
}
