export interface AccessKeyInfo {
  accessKeyId: string;
  status: string;
  lastUsedDate: string | null;
  lastUsedService: string | null;
}

export interface IamUserResponse {
  userName: string;
  userId: string;
  arn: string;
  createDate: string;
  passwordLastUsed: string | null;
  lastActivity: string | null;
  inactiveDays: number;
  accessKeyCount: number;
  hasConsoleAccess: boolean;
  accessKeys: AccessKeyInfo[];
}

export interface PluginStatus {
  enabled: boolean;
  inactiveDays: number;
  warningDays: number;
  cron: string;
  fetchCron: string;
  slackConfigured: boolean;
  botConfigured: boolean;
  lastFetchedAt: string | null;
  totalUsers: number;
  inactiveUsers: number;
}

export type PasswordResetStatus = 'pending' | 'approved' | 'rejected';

export interface PasswordResetRequest {
  id: string;
  iamUserName: string;
  iamUserArn: string;
  requesterRef: string;
  requesterEmail: string | null;
  reason: string;
  status: PasswordResetStatus;
  reviewerRef: string | null;
  reviewComment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlackHealth {
  webhook: { configured: boolean };
  bot: { configured: boolean; valid: boolean; botName?: string; teamName?: string };
  checkedAt: string;
}

export interface WarningDmLog {
  platform: string;
  status: 'success' | 'failed';
  errorMessage: string | null;
  createdAt: string;
}
