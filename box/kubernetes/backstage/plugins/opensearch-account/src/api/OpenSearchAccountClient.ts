import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { OpenSearchAccountApi } from './OpenSearchAccountApi';
import {
  AccountConfig,
  AccountRequest,
  AccountRequestResult,
  CreateRequestInput,
  InternalUser,
  UserRole,
} from './types';

export class OpenSearchAccountClient implements OpenSearchAccountApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('opensearch-account');
  }

  /** Surface the backend's `{ error }` body message instead of a generic status. */
  private async toError(response: Response): Promise<Error> {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error) detail = body.error;
    } catch {
      /* non-JSON body */
    }
    return new Error(detail);
  }

  private async getJson<T>(path: string): Promise<T> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}${path}`);
    if (!response.ok) throw await this.toError(response);
    return response.json();
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await this.toError(response);
    return response.json();
  }

  getConfig(): Promise<AccountConfig> {
    return this.getJson<AccountConfig>('/config');
  }

  getUserRole(): Promise<UserRole> {
    return this.getJson<UserRole>('/user-role');
  }

  listAccounts(): Promise<InternalUser[]> {
    return this.getJson<InternalUser[]>('/accounts');
  }

  listRoles(): Promise<string[]> {
    return this.getJson<string[]>('/roles');
  }

  listBackendRoles(): Promise<string[]> {
    return this.getJson<string[]>('/backend-roles');
  }

  listRequests(): Promise<AccountRequest[]> {
    return this.getJson<AccountRequest[]>('/requests');
  }

  createRequest(input: CreateRequestInput): Promise<AccountRequestResult> {
    return this.postJson<AccountRequestResult>('/requests', input);
  }

  approveRequest(id: string, reason: string): Promise<AccountRequestResult> {
    return this.postJson<AccountRequestResult>(
      `/requests/${encodeURIComponent(id)}/approve`,
      { reason },
    );
  }

  rejectRequest(id: string, reason: string): Promise<AccountRequest> {
    return this.postJson<AccountRequest>(
      `/requests/${encodeURIComponent(id)}/reject`,
      { reason },
    );
  }
}
