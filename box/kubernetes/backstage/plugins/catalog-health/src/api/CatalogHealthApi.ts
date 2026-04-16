import { createApiRef } from '@backstage/core-plugin-api';
import { CoverageResponse, CoverageSnapshot, GitlabBranch, GroupCoverage, SubmitCatalogInfoRequest, SubmitCatalogInfoResponse } from './types';

export interface CatalogHealthApi {
  getCoverage(): Promise<CoverageResponse>;
  getGroupCoverage(): Promise<GroupCoverage[]>;
  getCoverageHistory(days?: number): Promise<CoverageSnapshot[]>;
  triggerScan(): Promise<void>;
  getAdminStatus(): Promise<{ isAdmin: boolean }>;
  getBranches(projectId: number): Promise<GitlabBranch[]>;
  toggleIgnore(projectId: number): Promise<{ ignored: boolean }>;
  submitCatalogInfo(req: SubmitCatalogInfoRequest): Promise<SubmitCatalogInfoResponse>;
}

export const catalogHealthApiRef = createApiRef<CatalogHealthApi>({
  id: 'plugin.catalog-health.api',
});
