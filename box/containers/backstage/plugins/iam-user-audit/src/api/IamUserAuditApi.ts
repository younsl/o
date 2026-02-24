import { createApiRef } from '@backstage/core-plugin-api';
import { IamUserResponse, PluginStatus, PasswordResetRequest } from './types';

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
}

export const iamUserAuditApiRef = createApiRef<IamUserAuditApi>({
  id: 'plugin.iam-user-audit.api',
});
