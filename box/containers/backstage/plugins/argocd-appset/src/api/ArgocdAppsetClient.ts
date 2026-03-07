import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { ArgocdAppsetApi } from './ArgocdAppsetApi';
import { ApplicationSetResponse, AuditLogEntry, PluginStatus } from './types';

export class ArgocdAppsetClient implements ArgocdAppsetApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('argocd-appset');
  }

  async listApplicationSets(): Promise<ApplicationSetResponse[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/application-sets`,
    );

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

  async mute(namespace: string, name: string): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/application-sets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/mute`,
      { method: 'POST' },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }
  }

  async unmute(namespace: string, name: string): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/application-sets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/unmute`,
      { method: 'POST' },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }
  }

  async setTargetRevision(namespace: string, name: string, targetRevision: string): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/application-sets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/target-revision`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetRevision }),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }
  }

  async listBranches(repoUrl: string): Promise<{ branches: string[]; defaultBranch: string | null }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/branches?repoUrl=${encodeURIComponent(repoUrl)}`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getAdminStatus(): Promise<{ isAdmin: boolean }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/admin-status`);

    if (!response.ok) {
      return { isAdmin: false };
    }

    return response.json();
  }

  async listAuditLogs(namespace: string, name: string): Promise<AuditLogEntry[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/audit-logs?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }
}
