export interface KafkaCluster {
  name: string;
  brokers: string[];
  requiresApproval: boolean;
  topicConfig: Record<string, TopicConfig>;
}

export interface TopicConfig {
  numPartitions: number;
  replicationFactor: number;
  configEntries: Record<string, string>;
}

export interface KafkaTopic {
  name: string;
  partitions: number;
  replicationFactor: number;
  minInsyncReplicas: string | null;
}

export interface CreateTopicRequest {
  appName: string;
  eventName: string;
  action?: string;
  trafficLevel?: string;
  cleanupPolicy?: string;
}

export interface CreateTopicResponse {
  topicName: string;
  partitions: number;
  replicationFactor: number;
  status: 'created' | 'pending';
  requester?: string;
}

export interface TopicRequest {
  id: string;
  cluster: string;
  topicName: string;
  numPartitions: number;
  replicationFactor: number;
  cleanupPolicy: string;
  trafficLevel: string;
  configEntries: Record<string, string>;
  requester: string;
  reviewer: string | null;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'created';
  createdAt: string;
  updatedAt: string;
}

export interface BrokerStatus {
  address: string;
  status: 'online' | 'offline';
  nodeId: number | null;
  isController: boolean;
}

export interface KafkaClusterMetadata {
  clusterId: string;
  brokerCount: number;
  controller: number | null;
  version: string | null;
  brokers: BrokerStatus[];
}
