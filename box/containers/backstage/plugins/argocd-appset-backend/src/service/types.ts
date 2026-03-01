export const MUTE_ANNOTATION = 'backstage.io/muted';

export interface ApplicationSetResponse {
  name: string;
  namespace: string;
  generators: string[];
  applicationCount: number;
  syncedCount: number;
  applications: string[];
  syncedApplications: string[];
  repoUrl: string;
  repoName: string;
  targetRevisions: string[];
  isHeadRevision: boolean;
  muted: boolean;
  createdAt: string;
}
