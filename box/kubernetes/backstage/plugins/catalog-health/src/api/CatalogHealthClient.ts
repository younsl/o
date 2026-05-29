import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { CatalogHealthApi } from './CatalogHealthApi';
import { CoverageResponse, CoverageSnapshot, GitlabBranch, GroupCoverage, SubmitCatalogInfoRequest, SubmitCatalogInfoResponse } from './types';

export class CatalogHealthClient implements CatalogHealthApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('catalog-health');
  }

  async getCoverage(): Promise<CoverageResponse> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/coverage`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getGroupCoverage(): Promise<GroupCoverage[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/coverage/groups`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getCoverageHistory(days: number = 90): Promise<CoverageSnapshot[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/coverage/history?days=${days}`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async triggerScan(): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/scan`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }
  }

  async getAdminStatus(): Promise<{ isAdmin: boolean }> {
    const baseUrl = await this.getBaseUrl();
    try {
      const response = await this.fetchApi.fetch(`${baseUrl}/admin-status`);
      if (!response.ok) return { isAdmin: false };
      return response.json();
    } catch {
      return { isAdmin: false };
    }
  }

  async getBranches(projectId: number): Promise<GitlabBranch[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/branches/${projectId}`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async toggleIgnore(projectId: number): Promise<{ ignored: boolean }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/toggle-ignore/${projectId}`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async submitCatalogInfo(req: SubmitCatalogInfoRequest): Promise<SubmitCatalogInfoResponse> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/submit-catalog-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }
}
