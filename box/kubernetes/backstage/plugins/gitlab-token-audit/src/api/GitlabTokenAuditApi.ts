import { createApiRef } from '@backstage/core-plugin-api';
import {
  GitlabToken,
  NotificationLog,
  PluginStatus,
  WebhookConfig,
} from './types';

export interface GitlabTokenAuditApi {
  getAdminStatus(): Promise<{ isAdmin: boolean }>;
  getStatus(): Promise<PluginStatus>;
  listTokens(): Promise<GitlabToken[]>;
  refresh(): Promise<{ ok: boolean; lastFetchedAt: string | null; totalTokens: number }>;
  getWebhook(): Promise<WebhookConfig | null>;
  listNotifications(): Promise<NotificationLog[]>;
  triggerManualNotify(input: {
    tokenKeys?: string[];
    reason?: string;
    force?: boolean;
  }): Promise<{
    sent: number;
    skipped: number;
    candidates: number;
    note?: string;
  }>;
  previewNotifyPayload(input: {
    tokenKeys?: string[];
    reason?: string;
  }): Promise<{
    candidateCount: number;
    payload: Record<string, unknown>;
  }>;
}

export const gitlabTokenAuditApiRef = createApiRef<GitlabTokenAuditApi>({
  id: 'plugin.gitlab-token-audit.api',
});
