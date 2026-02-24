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
  cron: string;
  fetchCron: string;
  slackConfigured: boolean;
  lastFetchedAt: string | null;
  totalUsers: number;
  inactiveUsers: number;
}

// Password Reset types

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

export interface CreatePasswordResetInput {
  iamUserName: string;
  iamUserArn: string;
  reason: string;
  requesterEmail?: string;
}

export interface ReviewPasswordResetInput {
  action: 'approve' | 'reject';
  comment?: string;
  newPassword?: string; // required for approve, discarded after AWS API call
}
