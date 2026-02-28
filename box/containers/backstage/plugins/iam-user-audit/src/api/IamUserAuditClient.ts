import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { IamUserAuditApi } from './IamUserAuditApi';
import { IamUserResponse, PluginStatus, PasswordResetRequest } from './types';

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
}
