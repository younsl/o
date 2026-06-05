import { createApiRef } from '@backstage/core-plugin-api';
import {
  AccountConfig,
  AccountRequest,
  AccountRequestResult,
  CreateRequestInput,
  InternalUser,
  UserRole,
} from './types';

export interface OpenSearchAccountApi {
  getConfig(): Promise<AccountConfig>;
  getUserRole(): Promise<UserRole>;
  listAccounts(): Promise<InternalUser[]>;
  listRoles(): Promise<string[]>;
  listBackendRoles(): Promise<string[]>;
  listRequests(): Promise<AccountRequest[]>;
  createRequest(input: CreateRequestInput): Promise<AccountRequestResult>;
  approveRequest(id: string, reason: string): Promise<AccountRequestResult>;
  rejectRequest(id: string, reason: string): Promise<AccountRequest>;
}

export const opensearchAccountApiRef = createApiRef<OpenSearchAccountApi>({
  id: 'plugin.opensearch-account.api',
});
