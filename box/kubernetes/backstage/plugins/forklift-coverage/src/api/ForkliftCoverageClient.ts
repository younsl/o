import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { ForkliftCoverageApi, SaveSettingsInput } from './ForkliftCoverageApi';
import {
  CoverageResponse,
  CoverageSnapshot,
  GroupCoverage,
  HostProbeResult,
  LastCommit,
  PipelineResponse,
  ProjectDetail,
  SettingsResponse,
} from './types';

export class ForkliftCoverageClient implements ForkliftCoverageApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const base = await this.discoveryApi.getBaseUrl('forklift-coverage');
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

  async getCoverage(): Promise<CoverageResponse> {
    return this.req<CoverageResponse>('/coverage');
  }

  async getGroupCoverage(): Promise<GroupCoverage[]> {
    return this.req<GroupCoverage[]>('/coverage/groups');
  }

  async getHistory(days: number = 90): Promise<CoverageSnapshot[]> {
    return this.req<CoverageSnapshot[]>(`/coverage/history?days=${days}`);
  }

  async getProject(projectPath: string): Promise<ProjectDetail> {
    return this.req<ProjectDetail>(
      `/projects/${encodeURIComponent(projectPath)}`,
    );
  }

  async getPipeline(
    projectPath: string,
    ref?: string,
  ): Promise<PipelineResponse> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    return this.req<PipelineResponse>(
      `/projects/${encodeURIComponent(projectPath)}/pipeline${query}`,
    );
  }

  async getLastCommit(projectPath: string): Promise<LastCommit | null> {
    return this.req<LastCommit | null>(
      `/projects/${encodeURIComponent(projectPath)}/last-commit`,
    );
  }

  async getSettings(): Promise<SettingsResponse> {
    return this.req<SettingsResponse>('/settings');
  }

  async testHost(forkliftHost: string): Promise<HostProbeResult> {
    return this.req('/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forkliftHost }),
    });
  }

  async saveSettings(
    input: SaveSettingsInput,
  ): Promise<{ saved: boolean; probe: HostProbeResult }> {
    return this.req('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async setExclusion(
    projectPath: string,
    excluded: boolean,
  ): Promise<{ projectPath: string; excluded: boolean }> {
    return this.req(`/projects/${encodeURIComponent(projectPath)}/exclusion`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excluded }),
    });
  }

  async startScan(): Promise<{ started: boolean }> {
    return this.req('/scan', { method: 'POST' });
  }

  async previewNotify(): Promise<{ text: string; sample: boolean }> {
    return this.req('/notify/preview', { method: 'POST' });
  }

  async notify(): Promise<{ sent: boolean; notApplied: number }> {
    return this.req('/notify', { method: 'POST' });
  }
}
