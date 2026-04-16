import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { S3LogExtractApi, S3Config, S3HealthStatus } from './S3LogExtractApi';
import { LogExtractRequest } from './types';

export class S3LogExtractClient implements S3LogExtractApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('s3-log-extract');
  }

  async getConfig(): Promise<S3Config> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/config`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getS3Health(): Promise<S3HealthStatus> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/s3-health`);

    if (!response.ok) {
      return { connected: false, checkedAt: new Date().toISOString(), error: 'Failed to fetch health' };
    }

    return response.json();
  }

  async listApps(env: string, date: string, source: string): Promise<string[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/apps?env=${encodeURIComponent(env)}&date=${encodeURIComponent(date)}&source=${encodeURIComponent(source)}`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async createRequest(input: {
    source: string;
    env: string;
    date: string;
    apps: string[];
    startTime: string;
    endTime: string;
    reason: string;
  }): Promise<LogExtractRequest> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async listRequests(): Promise<LogExtractRequest[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/requests`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getRequest(id: string): Promise<LogExtractRequest> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/requests/${id}`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async reviewRequest(
    id: string,
    input: { action: 'approve' | 'reject'; comment: string },
  ): Promise<LogExtractRequest> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/requests/${id}/review`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async downloadUrl(id: string): Promise<string> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/requests/${id}/download`,
    );

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        (body as any).error ?? `Download failed: ${response.statusText}`,
      );
    }

    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  async getAdminStatus(): Promise<{ isAdmin: boolean }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/admin-status`);

    if (!response.ok) {
      return { isAdmin: false };
    }

    return response.json();
  }
}
