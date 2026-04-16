export interface GitlabProject {
  id: number;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  defaultBranch: string | null;
  namespace: string;
  hasCatalogInfo: boolean;
  catalogInfoContent: string | null;
  owners: string[];
  topics: string[];
  lastActivityAt: string;
  archived: boolean;
}

export interface CoverageResponse {
  total: number;
  covered: number;
  uncovered: number;
  percent: number;
  projects: GitlabProject[];
  lastScannedAt: string | null;
  scanning: boolean;
  gitlabHost: string | null;
  scanCron: string;
}

export interface GroupCoverage {
  namespace: string;
  total: number;
  covered: number;
  percent: number;
}

export interface SubmitCatalogInfoRequest {
  projectId: number;
  name: string;
  description: string;
  type: string;
  lifecycle: string;
  owner: string;
  tags: string[];
  targetBranch?: string;
}

export interface GitlabBranch {
  name: string;
  default: boolean;
}

export interface SubmitCatalogInfoResponse {
  mergeRequestUrl: string;
}

