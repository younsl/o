import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { IamUserAuditApi } from './IamUserAuditApi';
import { IamUserResponse, PluginStatus, PasswordResetRequest, WarningDmLog, SlackHealth } from './types';

export class IamUserAuditClient implements IamUserAuditApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('iam-user-audit');
  }

  async listUsers(): Promise<IamUserResponse[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/users`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getStatus(): Promise<PluginStatus> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/status`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async createPasswordResetRequest(input: {
    iamUserName: string;
    iamUserArn: string;
    reason: string;
    requesterEmail?: string;
  }): Promise<PasswordResetRequest> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/password-reset/requests`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async listPasswordResetRequests(): Promise<PasswordResetRequest[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/password-reset/requests`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async reviewPasswordResetRequest(
    id: string,
    input: {
      action: 'approve' | 'reject';
      comment?: string;
      newPassword?: string;
    },
  ): Promise<PasswordResetRequest> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/password-reset/requests/${id}/review`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getAdminStatus(): Promise<{ isAdmin: boolean }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/password-reset/admin-status`,
    );

    if (!response.ok) {
      return { isAdmin: false };
    }

    return response.json();
  }

  async checkSlackUsers(userNames: string[]): Promise<Record<string, boolean>> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/admin/check-slack-users`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userNames }),
      },
    );

    if (!response.ok) {
      return {};
    }

    return response.json();
  }

  async getSlackUserInfo(userName: string): Promise<{
    id: string;
    realName: string;
    displayName: string;
    title: string;
    image48: string;
    email: string;
  }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/admin/slack-user-info?userName=${encodeURIComponent(userName)}`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async sendStatusDm(userName: string, message: string): Promise<{ success: boolean }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/admin/notify-user`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName, message }),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getWarningDmLogs(userNames: string[]): Promise<Record<string, WarningDmLog | null>> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/status/warning-dm-logs?userNames=${encodeURIComponent(userNames.join(','))}`,
    );

    if (!response.ok) {
      return {};
    }

    return response.json();
  }

  async getSlackHealth(): Promise<SlackHealth> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/status/slack-health`,
    );

    if (!response.ok) {
      return {
        webhook: { configured: false },
        bot: { configured: false, valid: false },
        checkedAt: new Date().toISOString(),
      };
    }

    return response.json();
  }
}
