import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { OpenSearchScalingApi } from './OpenSearchScalingApi';
import {
  CreateScalingInput,
  DomainDetail,
  DomainSummary,
  ScalingConfig,
  ScalingPreview,
  ScalingRequest,
  ScalingTargetInput,
  UserRole,
} from './types';

export class OpenSearchScalingClient implements OpenSearchScalingApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('opensearch-scaling');
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

  private async postJson<T>(path: string, body?: unknown): Promise<T> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw await this.toError(response);
    return response.json();
  }

  getConfig(): Promise<ScalingConfig> {
    return this.getJson<ScalingConfig>('/config');
  }

  getUserRole(): Promise<UserRole> {
    return this.getJson<UserRole>('/user-role');
  }

  listDomains(): Promise<DomainSummary[]> {
    return this.getJson<DomainSummary[]>('/domains');
  }

  getDomain(name: string): Promise<DomainDetail> {
    return this.getJson<DomainDetail>(
      `/domains/${encodeURIComponent(name)}`,
    );
  }

  previewScaling(
    domain: string,
    target: ScalingTargetInput,
  ): Promise<ScalingPreview> {
    return this.postJson<ScalingPreview>(
      `/domains/${encodeURIComponent(domain)}/preview`,
      target,
    );
  }

  listRequests(): Promise<ScalingRequest[]> {
    return this.getJson<ScalingRequest[]>('/requests');
  }

  createRequest(input: CreateScalingInput): Promise<ScalingRequest> {
    return this.postJson<ScalingRequest>('/requests', input);
  }

  cancelRequest(id: string): Promise<ScalingRequest> {
    return this.postJson<ScalingRequest>(
      `/requests/${encodeURIComponent(id)}/cancel`,
    );
  }
}
