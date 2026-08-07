import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { KafkaTopicApi } from './KafkaTopicApi';
import {
  KafkaCluster,
  KafkaClusterMetadata,
  KafkaTopic,
  CreateTopicRequest,
  CreateTopicResponse,
  BatchCreateTopicRequest,
  BatchCreateTopicResponse,
  TopicRequest,
} from './types';

export class KafkaTopicClient implements KafkaTopicApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('kafka-topic');
  }

  async getClusters(): Promise<KafkaCluster[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/clusters`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getClusterMetadata(cluster: string): Promise<KafkaClusterMetadata> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/clusters/${encodeURIComponent(cluster)}/metadata`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async listTopics(cluster: string): Promise<KafkaTopic[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/topics/${encodeURIComponent(cluster)}`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async createTopic(
    cluster: string,
    request: CreateTopicRequest,
  ): Promise<CreateTopicResponse> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/topics/${encodeURIComponent(cluster)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getRequests(): Promise<TopicRequest[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/requests`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getRequest(id: string): Promise<TopicRequest> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/requests/${encodeURIComponent(id)}`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async approveRequest(id: string, reason: string): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/requests/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }
  }

  async rejectRequest(id: string, reason: string): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/requests/${encodeURIComponent(id)}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }
  }

  async createTopicsBatch(
    cluster: string,
    request: BatchCreateTopicRequest,
  ): Promise<BatchCreateTopicResponse> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/topics/${encodeURIComponent(cluster)}/batch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async getBatchRequests(batchId: string): Promise<TopicRequest[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/requests/batch/${encodeURIComponent(batchId)}`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }

  async approveBatch(batchId: string, reason: string): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/requests/batch/${encodeURIComponent(batchId)}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }
  }

  async rejectBatch(batchId: string, reason: string): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/requests/batch/${encodeURIComponent(batchId)}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }
  }

  async getUserRole(): Promise<{ isAdmin: boolean; admins: string[] }> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/user-role`);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response as any);
    }

    return response.json();
  }
}
