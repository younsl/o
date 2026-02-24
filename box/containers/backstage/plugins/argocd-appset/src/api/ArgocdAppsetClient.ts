import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { ArgocdAppsetApi } from './ArgocdAppsetApi';
import { ApplicationSetResponse, PluginStatus } from './types';

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

  async getAdminStatus(): Promise<{ isAdmin: boolean }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/admin-status`);

    if (!response.ok) {
      return { isAdmin: false };
    }

    return response.json();
  }
}
