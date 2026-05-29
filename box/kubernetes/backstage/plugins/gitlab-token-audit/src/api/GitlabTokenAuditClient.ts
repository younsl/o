import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { GitlabTokenAuditApi } from './GitlabTokenAuditApi';
import {
  GitlabToken,
  NotificationLog,
  PluginStatus,
  WebhookConfig,
} from './types';

export class GitlabTokenAuditClient implements GitlabTokenAuditApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async baseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('gitlab-token-audit');
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const base = await this.baseUrl();
    const res = await this.fetchApi.fetch(`${base}${path}`, init);
    if (!res.ok) {
      throw await ResponseError.fromResponse(res as any);
    }
    return res.json();
  }

  async getAdminStatus(): Promise<{ isAdmin: boolean }> {
    try {
      return await this.req<{ isAdmin: boolean }>('/admin-status');
    } catch {
      return { isAdmin: false };
    }
  }

  async getStatus(): Promise<PluginStatus> {
    return this.req<PluginStatus>('/status');
  }

  async listTokens(): Promise<GitlabToken[]> {
    return this.req<GitlabToken[]>('/tokens');
  }

  async refresh(): Promise<{
    ok: boolean;
    lastFetchedAt: string | null;
    totalTokens: number;
  }> {
    return this.req('/refresh', { method: 'POST' });
  }

  async getWebhook(): Promise<WebhookConfig | null> {
    return this.req<WebhookConfig | null>('/webhook');
  }

  async listNotifications(): Promise<NotificationLog[]> {
    const data = await this.req<{ items: NotificationLog[] }>('/notifications');
    return data.items ?? [];
  }

  async previewNotifyPayload(input: {
    tokenKeys?: string[];
    reason?: string;
  }): Promise<{
    candidateCount: number;
    payload: Record<string, unknown>;
  }> {
    return this.req('/notify/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async triggerManualNotify(input: {
    tokenKeys?: string[];
    reason?: string;
    force?: boolean;
  }): Promise<{
    sent: number;
    skipped: number;
    candidates: number;
    note?: string;
  }> {
    return this.req('/notify/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }
}
