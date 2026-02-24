export interface ApplicationSetResponse {
  name: string;
  namespace: string;
  generators: string[];
  applicationCount: number;
  applications: string[];
  repoUrl: string;
  repoName: string;
  targetRevisions: string[];
  isHeadRevision: boolean;
  muted: boolean;
  createdAt: string;
}

export interface PluginStatus {
  cron: string;
  fetchCron: string;
  slackConfigured: boolean;
  lastFetchedAt: string | null;
}
