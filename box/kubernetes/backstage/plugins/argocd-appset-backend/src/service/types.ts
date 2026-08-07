export const MUTE_ANNOTATION = 'backstage.io/muted';

export interface ApplicationSetResponse {
  name: string;
  namespace: string;
  generators: string[];
  applicationCount: number;
  syncedCount: number;
  applications: string[];
  syncedApplications: string[];
  applicationStatuses: Record<string, string>;
  repoUrl: string;
  repoName: string;
  targetRevisions: string[];
  isHeadRevision: boolean;
  muted: boolean;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  seq: number;
  action: 'mute' | 'unmute' | 'set_target_revision';
  appsetNamespace: string;
  appsetName: string;
  userRef: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}
