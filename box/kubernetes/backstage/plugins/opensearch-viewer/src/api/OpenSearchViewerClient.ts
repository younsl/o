import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { OpenSearchViewerApi } from './OpenSearchViewerApi';
import {
  OpenSearchConflictSnapshot,
  OpenSearchViewerConfig,
} from './types';

export class OpenSearchViewerClient implements OpenSearchViewerApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('opensearch-viewer');
  }

  private async getJson<T>(path: string): Promise<T> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}${path}`);
    if (!response.ok) throw await ResponseError.fromResponse(response as any);
    return response.json();
  }

  private async postJson<T>(path: string, body?: unknown): Promise<T> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenSearch-Viewer-Action': 'manual-refresh',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw await ResponseError.fromResponse(response as any);
    return response.json();
  }

  getConfig(): Promise<OpenSearchViewerConfig> {
    return this.getJson<OpenSearchViewerConfig>('/config');
  }

  listSnapshots(): Promise<OpenSearchConflictSnapshot[]> {
    return this.getJson<OpenSearchConflictSnapshot[]>('/snapshots');
  }

  getSnapshot(targetId: string): Promise<OpenSearchConflictSnapshot> {
    return this.getJson<OpenSearchConflictSnapshot>(
      `/snapshots/${encodeURIComponent(targetId)}`,
    );
  }

  scanTarget(targetId: string): Promise<OpenSearchConflictSnapshot> {
    return this.postJson<OpenSearchConflictSnapshot>(
      `/scan/${encodeURIComponent(targetId)}`,
      { manualRefresh: true },
    );
  }

  scanAll(): Promise<OpenSearchConflictSnapshot[]> {
    return this.postJson<OpenSearchConflictSnapshot[]>('/scan', {
      manualRefresh: true,
    });
  }

  deleteIndex(index: string): Promise<{ deleted: boolean; index: string }> {
    return this.postJson<{ deleted: boolean; index: string }>(
      '/indices/delete',
      { index, confirm: index },
    );
  }
}
