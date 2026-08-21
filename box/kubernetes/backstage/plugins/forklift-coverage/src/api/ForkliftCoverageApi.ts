import { createApiRef } from '@backstage/core-plugin-api';
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

export interface SaveSettingsInput {
  forkliftHost: string;
  /** Empty keeps the stored URL, which the UI only ever sees masked. */
  webhookUrl?: string;
  webhookEnabled?: boolean;
  webhookSkipWhenFullCoverage?: boolean;
  scanCron?: string;
  timezone?: string;
  autoScanEnabled?: boolean;
}

export interface ForkliftCoverageApi {
  getAdminStatus(): Promise<{ isAdmin: boolean }>;
  getCoverage(): Promise<CoverageResponse>;
  getGroupCoverage(): Promise<GroupCoverage[]>;
  getHistory(days?: number): Promise<CoverageSnapshot[]>;
  getProject(projectPath: string): Promise<ProjectDetail>;
  getPipeline(projectPath: string, ref?: string): Promise<PipelineResponse>;
  getLastCommit(projectPath: string): Promise<LastCommit | null>;
  getSettings(): Promise<SettingsResponse>;
  testHost(forkliftHost: string): Promise<HostProbeResult>;
  saveSettings(
    input: SaveSettingsInput,
  ): Promise<{ saved: boolean; probe: HostProbeResult }>;
  setExclusion(
    projectPath: string,
    excluded: boolean,
  ): Promise<{ projectPath: string; excluded: boolean }>;
  startScan(): Promise<{ started: boolean }>;
  previewNotify(): Promise<{ text: string; sample: boolean }>;
  notify(): Promise<{ sent: boolean; notApplied: number }>;
}

export const forkliftCoverageApiRef = createApiRef<ForkliftCoverageApi>({
  id: 'plugin.forklift-coverage.api',
});
