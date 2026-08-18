import { createApiRef } from '@backstage/core-plugin-api';
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

export interface StaleBranchesApi {
  getAdminStatus(): Promise<{ isAdmin: boolean }>;

  listSchedules(): Promise<SchedulesResponse>;
  getSchedule(id: string): Promise<ScheduleSummary>;
  createSchedule(input: ScheduleInput): Promise<ScheduleSummary>;
  updateSchedule(id: string, input: ScheduleInput): Promise<ScheduleSummary>;
  setScheduleEnabled(id: string, enabled: boolean): Promise<ScheduleSummary>;
  deleteSchedule(id: string): Promise<{ deleted: boolean }>;
  triggerSchedule(
    id: string,
    dryRun?: boolean,
  ): Promise<{ started: boolean; dryRun: boolean }>;

  listRuns(scheduleId: string, limit?: number): Promise<RunSummary[]>;
  getLatestRun(scheduleId: string): Promise<RunDetail | null>;
  getRun(runId: string): Promise<RunDetail>;

  notify(
    scheduleId: string,
  ): Promise<{ sent: number; skipped: number; failed: number }>;
  previewNotify(
    scheduleId: string,
  ): Promise<{ text: string; sample: boolean }>;
  resetNotifications(scheduleId: string): Promise<{ cleared: boolean }>;

  getConnection(): Promise<ConnectionResponse>;
  /** Reachability only, so it answers before a token has been entered. */
  probeEndpoint(apiBaseUrl: string): Promise<EndpointProbeResult>;
  testConnection(
    apiBaseUrl: string,
    gitlabToken?: string,
  ): Promise<CredentialProbeResult>;
  saveConnection(
    apiBaseUrl: string,
    gitlabToken?: string,
  ): Promise<{ saved: boolean; probe: CredentialProbeResult }>;

  previewCron(cron: string, timezone: string): Promise<CronPreview>;
}

export const staleBranchesApiRef = createApiRef<StaleBranchesApi>({
  id: 'plugin.stale-branches.api',
});
