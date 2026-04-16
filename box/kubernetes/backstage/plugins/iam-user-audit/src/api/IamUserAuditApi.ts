import { createApiRef } from '@backstage/core-plugin-api';
import { IamUserResponse, PluginStatus, PasswordResetRequest, WarningDmLog, SlackHealth } from './types';

export interface IamUserAuditApi {
  listUsers(): Promise<IamUserResponse[]>;
  getStatus(): Promise<PluginStatus>;
  createPasswordResetRequest(input: {
    iamUserName: string;
    iamUserArn: string;
    reason: string;
    requesterEmail?: string;
  }): Promise<PasswordResetRequest>;
  listPasswordResetRequests(): Promise<PasswordResetRequest[]>;
  reviewPasswordResetRequest(
    id: string,
    input: {
      action: 'approve' | 'reject';
      comment?: string;
      newPassword?: string;
    },
  ): Promise<PasswordResetRequest>;
  getAdminStatus(): Promise<{ isAdmin: boolean }>;
  checkSlackUsers(userNames: string[]): Promise<Record<string, boolean>>;
  getSlackUserInfo(userName: string): Promise<{
    id: string;
    realName: string;
    displayName: string;
    title: string;
    image48: string;
    email: string;
  }>;
  sendStatusDm(userName: string, message: string): Promise<{ success: boolean }>;
  getWarningDmLogs(userNames: string[]): Promise<Record<string, WarningDmLog | null>>;
  getSlackHealth(): Promise<SlackHealth>;
}

export const iamUserAuditApiRef = createApiRef<IamUserAuditApi>({
  id: 'plugin.iam-user-audit.api',
});
