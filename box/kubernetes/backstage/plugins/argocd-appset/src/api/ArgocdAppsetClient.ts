import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { ArgocdAppsetApi } from './ArgocdAppsetApi';
import {
  ApplicationSetResponse,
  AuditLogEntry,
  BranchListResponse,
  PluginStatus,
  ScanStatus,
  UpstreamChart,
} from './types';

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

  async listBranches(repoUrl: string): Promise<BranchListResponse> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/branches?repoUrl=${encodeURIComponent(repoUrl)}`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getUpstreamChart(repository: string, chart: string): Promise<UpstreamChart> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/upstream-chart?repository=${encodeURIComponent(repository)}` +
        `&chart=${encodeURIComponent(chart)}`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async listUpstreamCharts(): Promise<UpstreamChart[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/upstream-charts`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getScanStatus(): Promise<ScanStatus> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/upstream-scan`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  /**
   * A refusal is an expected answer, not a failure: another reader may have a
   * scan running or have just finished one, so 409 and 429 come back as
   * `started: false` rather than as a thrown error.
   */
  async startScan(): Promise<{ started: boolean; status: ScanStatus | null }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/upstream-scan`, {
      method: 'POST',
    });

    if (response.status === 409 || response.status === 429) {
      return { started: false, status: null };
    }
    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return { started: true, status: await response.json() };
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
