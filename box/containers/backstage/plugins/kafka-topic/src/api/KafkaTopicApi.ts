import { createApiRef } from '@backstage/core-plugin-api';
import {
  KafkaCluster,
  KafkaClusterMetadata,
  KafkaTopic,
  CreateTopicRequest,
  CreateTopicResponse,
  TopicRequest,
} from './types';

export interface KafkaTopicApi {
  getClusters(): Promise<KafkaCluster[]>;
  getClusterMetadata(cluster: string): Promise<KafkaClusterMetadata>;
  listTopics(cluster: string): Promise<KafkaTopic[]>;
  createTopic(
    cluster: string,
    request: CreateTopicRequest,
  ): Promise<CreateTopicResponse>;
  getRequests(): Promise<TopicRequest[]>;
  getRequest(id: string): Promise<TopicRequest>;
  approveRequest(id: string, reason: string): Promise<void>;
  rejectRequest(id: string, reason: string): Promise<void>;
  getUserRole(): Promise<{ isAdmin: boolean; admins: string[] }>;
}

export const kafkaTopicApiRef = createApiRef<KafkaTopicApi>({
  id: 'plugin.kafka-topic.api',
});
