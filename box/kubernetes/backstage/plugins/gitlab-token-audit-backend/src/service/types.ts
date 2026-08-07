export type GitlabTokenKind =
  | 'personal'
  | 'project'
  | 'group';

export type GitlabTokenState = 'active' | 'expired' | 'revoked' | 'inactive';

export interface GitlabToken {
  id: number;
  kind: GitlabTokenKind;
  name: string;
  description: string | null;
  userId?: number;
  userName?: string;
  ownerScope?: string;
  ownerId?: number;
  scopes: string[];
  active: boolean;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
  state: GitlabTokenState;
  webUrl?: string;
  accessLevel?: number;
  impersonation?: boolean;
}

export interface WebhookConfig {
  url: string;
  daysBefore: number[];
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface NotifiedRecord {
  tokenKey: string;
  threshold: number;
  expiresAt: string;
  notifiedAt: string;
  status: 'success' | 'failed';
  errorMessage: string | null;
}

export interface PluginStatus {
  enabled: boolean;
  fetchCron: string;
  notifyCron: string;
  webhookConfigured: boolean;
  lastFetchedAt: string | null;
  totalTokens: number;
  expiredTokens: number;
  expiringSoonTokens: number;
}
