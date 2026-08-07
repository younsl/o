import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import fetch from 'node-fetch';
import https from 'https';
import { IndexSummary } from './types';

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

interface FieldCapsResponse {
  fields?: Record<string, Record<string, any>>;
}

export class OpenSearchDataClient {
  private constructor(
    private readonly endpoint: string,
    private readonly authHeader: string | undefined,
    private readonly agent: https.Agent | undefined,
    private readonly timeoutMs: number,
    private readonly logger: LoggerService,
  ) {}

  static fromConfig(
    config: Config,
    logger: LoggerService,
  ): OpenSearchDataClient | undefined {
    const viewer = config.getOptionalConfig('opensearchViewer');
    const account = config.getOptionalConfig('opensearchAccount');

    const endpoint =
      viewer?.getOptionalString('endpoint') ??
      account?.getOptionalString('endpoint');
    if (!endpoint) return undefined;

    const username =
      viewer?.getOptionalString('username') ??
      account?.getOptionalString('username');
    const password =
      viewer?.getOptionalString('password') ??
      account?.getOptionalString('password');

    const authHeader =
      username && password
        ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
        : undefined;

    const rejectUnauthorized =
      viewer?.getOptionalBoolean('tls.rejectUnauthorized') ??
      account?.getOptionalBoolean('tls.rejectUnauthorized') ??
      true;
    const base = endpoint.replace(/\/+$/, '');
    const agent = base.startsWith('https')
      ? new https.Agent({ rejectUnauthorized })
      : undefined;
    const timeoutMs =
      viewer?.getOptionalNumber('requestTimeoutMs') ??
      DEFAULT_REQUEST_TIMEOUT_MS;

    return new OpenSearchDataClient(
      base,
      authHeader,
      agent,
      timeoutMs,
      logger,
    );
  }

  private encodeIndexExpression(value: string): string {
    return value
      .split(',')
      .map(part => encodeURIComponent(part.trim()))
      .join(',');
  }

  private async requestJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method: 'GET',
      headers: {
        ...(this.authHeader ? { Authorization: this.authHeader } : {}),
      },
      agent: this.agent,
      timeout: this.timeoutMs,
    } as any);

    const text = await response.text();
    let body: any = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }

    if (!response.ok) {
      const detail = body?.error?.reason ?? body?.message ?? body?.raw ?? text;
      throw new Error(`OpenSearch returned ${response.status}: ${detail}`);
    }

    return body as T;
  }

  async listIndices(indexPattern: string): Promise<IndexSummary[]> {
    const params = new URLSearchParams({
      format: 'json',
      h: 'index,docs.count,store.size,status,health',
      expand_wildcards: 'open,hidden',
      s: 'index',
    });
    const encoded = this.encodeIndexExpression(indexPattern);

    try {
      const rows = await this.requestJson<Array<Record<string, string>>>(
        `/_cat/indices/${encoded}?${params.toString()}`,
      );
      return rows.map(row => {
        const docs = Number(row['docs.count']);
        return {
          index: row.index,
          documentCount: Number.isFinite(docs) ? docs : null,
          storeSize: row['store.size'] ?? null,
          health: row.health ?? null,
          status: row.status ?? null,
        };
      });
    } catch (error) {
      this.logger.warn(`Failed to list OpenSearch indices '${indexPattern}': ${error}`);
      throw error;
    }
  }

  /**
   * Deletes a single concrete index. Wildcard, comma-separated, or `_all`
   * expressions are rejected so a delete can never fan out across indices.
   */
  async deleteIndex(index: string): Promise<void> {
    const target = index.trim();
    if (!target) {
      throw new Error('Index name is required');
    }
    if (/[*,?\s]/.test(target) || target === '_all' || target === '*') {
      throw new Error(
        `Refusing to delete unsafe index expression '${index}'; a single concrete index name is required`,
      );
    }

    const response = await fetch(
      `${this.endpoint}/${encodeURIComponent(target)}`,
      {
        method: 'DELETE',
        headers: {
          ...(this.authHeader ? { Authorization: this.authHeader } : {}),
        },
        agent: this.agent,
        timeout: this.timeoutMs,
      } as any,
    );

    const text = await response.text();
    if (!response.ok) {
      let detail: string = text;
      try {
        const body = JSON.parse(text);
        detail = body?.error?.reason ?? body?.message ?? body?.raw ?? text;
      } catch {
        // keep raw text
      }
      throw new Error(`OpenSearch returned ${response.status}: ${detail}`);
    }

    this.logger.info(`Deleted OpenSearch index '${target}'`);
  }

  async getFieldCaps(indexExpression: string): Promise<FieldCapsResponse> {
    const params = new URLSearchParams({
      fields: '*',
      include_unmapped: 'false',
      ignore_unavailable: 'true',
      allow_no_indices: 'true',
      expand_wildcards: 'open,hidden',
    });
    const encoded = this.encodeIndexExpression(indexExpression);
    return this.requestJson<FieldCapsResponse>(
      `/${encoded}/_field_caps?${params.toString()}`,
    );
  }
}
