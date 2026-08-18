import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { StaleBranchesApi } from './StaleBranchesApi';
import {
  ConnectionResponse,
  CredentialProbeResult,
  CronPreview,
  EndpointProbeResult,
  RunDetail,
  RunSummary,
  ScheduleInput,
  ScheduleSummary,
  SchedulesResponse,
} from './types';

export class StaleBranchesClient implements StaleBranchesApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const base = await this.discoveryApi.getBaseUrl('stale-branches');
    const res = await this.fetchApi.fetch(`${base}${path}`, init);
    if (!res.ok) {
      throw await ResponseError.fromResponse(res as any);
    }
    return res.json();
  }

  private send<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.req<T>(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async getAdminStatus(): Promise<{ isAdmin: boolean }> {
    try {
      return await this.req<{ isAdmin: boolean }>('/admin-status');
    } catch {
      return { isAdmin: false };
    }
  }

  async listSchedules(): Promise<SchedulesResponse> {
    return this.req<SchedulesResponse>('/schedules');
  }

  async getSchedule(id: string): Promise<ScheduleSummary> {
    return this.req<ScheduleSummary>(`/schedules/${encodeURIComponent(id)}`);
  }

  async createSchedule(input: ScheduleInput): Promise<ScheduleSummary> {
    return this.send<ScheduleSummary>('POST', '/schedules', input);
  }

  async updateSchedule(
    id: string,
    input: ScheduleInput,
  ): Promise<ScheduleSummary> {
    return this.send<ScheduleSummary>(
      'PUT',
      `/schedules/${encodeURIComponent(id)}`,
      input,
    );
  }

  async setScheduleEnabled(
    id: string,
    enabled: boolean,
  ): Promise<ScheduleSummary> {
    return this.send<ScheduleSummary>(
      'PATCH',
      `/schedules/${encodeURIComponent(id)}/enabled`,
      { enabled },
    );
  }

  async deleteSchedule(id: string): Promise<{ deleted: boolean }> {
    return this.send('DELETE', `/schedules/${encodeURIComponent(id)}`);
  }

  async triggerSchedule(
    id: string,
    dryRun = false,
  ): Promise<{ started: boolean; dryRun: boolean }> {
    return this.send('POST', `/schedules/${encodeURIComponent(id)}/trigger`, {
      dryRun,
    });
  }

  async listRuns(scheduleId: string, limit = 50): Promise<RunSummary[]> {
    return this.req<RunSummary[]>(
      `/schedules/${encodeURIComponent(scheduleId)}/runs?limit=${limit}`,
    );
  }

  async getLatestRun(scheduleId: string): Promise<RunDetail | null> {
    try {
      return await this.req<RunDetail>(
        `/schedules/${encodeURIComponent(scheduleId)}/runs/latest`,
      );
    } catch {
      // A schedule that has never finished a run answers 404, which is a state
      // the page renders rather than an error it reports.
      return null;
    }
  }

  async getRun(runId: string): Promise<RunDetail> {
    return this.req<RunDetail>(`/runs/${encodeURIComponent(runId)}`);
  }

  async notify(
    scheduleId: string,
  ): Promise<{ sent: number; skipped: number; failed: number }> {
    return this.send('POST', `/schedules/${encodeURIComponent(scheduleId)}/notify`);
  }

  async previewNotify(
    scheduleId: string,
  ): Promise<{ text: string; sample: boolean }> {
    return this.send(
      'POST',
      `/schedules/${encodeURIComponent(scheduleId)}/notify/preview`,
    );
  }

  async resetNotifications(scheduleId: string): Promise<{ cleared: boolean }> {
    return this.send(
      'POST',
      `/schedules/${encodeURIComponent(scheduleId)}/notify/reset`,
    );
  }

  async getConnection(): Promise<ConnectionResponse> {
    return this.req<ConnectionResponse>('/connection');
  }

  async probeEndpoint(apiBaseUrl: string): Promise<EndpointProbeResult> {
    return this.send('POST', '/connection/reachability', { apiBaseUrl });
  }

  async testConnection(
    apiBaseUrl: string,
    gitlabToken?: string,
  ): Promise<CredentialProbeResult> {
    return this.send('POST', '/connection/test', { apiBaseUrl, gitlabToken });
  }

  async saveConnection(
    apiBaseUrl: string,
    gitlabToken?: string,
  ): Promise<{ saved: boolean; probe: CredentialProbeResult }> {
    return this.send('PUT', '/connection', { apiBaseUrl, gitlabToken });
  }

  async previewCron(cron: string, timezone: string): Promise<CronPreview> {
    return this.send<CronPreview>('POST', '/cron/preview', { cron, timezone });
  }
}
