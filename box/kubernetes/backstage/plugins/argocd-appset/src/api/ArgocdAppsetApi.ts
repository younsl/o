import { createApiRef } from '@backstage/core-plugin-api';
import {
  ApplicationSetResponse,
  AuditLogEntry,
  BranchListResponse,
  PluginStatus,
  ScanStatus,
  UpstreamChart,
} from './types';

export interface ArgocdAppsetApi {
  listApplicationSets(): Promise<ApplicationSetResponse[]>;
  getStatus(): Promise<PluginStatus>;
  mute(namespace: string, name: string): Promise<void>;
  unmute(namespace: string, name: string): Promise<void>;
  setTargetRevision(namespace: string, name: string, targetRevision: string): Promise<void>;
  getAdminStatus(): Promise<{ isAdmin: boolean }>;
  listBranches(repoUrl: string): Promise<BranchListResponse>;
  /** Newest version the chart's upstream repository offers */
  getUpstreamChart(repository: string, chart: string): Promise<UpstreamChart>;
  /** What the last scan recorded, whoever ran it */
  listUpstreamCharts(): Promise<UpstreamChart[]>;
  /** Progress and cooldown of the scan shared by every reader */
  getScanStatus(): Promise<ScanStatus>;
  /** Starts the shared scan, or reports why it cannot start yet */
  startScan(): Promise<{ started: boolean; status: ScanStatus | null }>;
  listAuditLogs(namespace: string, name: string): Promise<AuditLogEntry[]>;
}

export const argocdAppsetApiRef = createApiRef<ArgocdAppsetApi>({
  id: 'plugin.argocd-appset.api',
});
