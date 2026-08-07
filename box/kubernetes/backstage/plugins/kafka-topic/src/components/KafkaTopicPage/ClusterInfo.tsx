import React from 'react';
import { Card, CardBody, Flex, Grid, Skeleton, Text } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { kafkaTopicApiRef } from '../../api/KafkaTopicApi';
import './ClusterInfo.css';

export const ClusterInfo = ({ clusterName }: { clusterName: string }) => {
  const api = useApi(kafkaTopicApiRef);

  const { value: metadata, loading } = useAsyncRetry(
    async () => api.getClusterMetadata(clusterName),
    [api, clusterName],
  );

  if (loading) {
    return <Skeleton style={{ height: 120, borderRadius: 8 }} />;
  }

  if (!metadata) {
    return null;
  }

  const onlineCount = metadata.brokers.filter(b => b.status === 'online').length;

  return (
    <Card>
      <CardBody>
        <Flex direction="column" gap="3">
          <Flex direction="column" gap="1">
            <Text variant="body-small" weight="bold">Cluster Architecture</Text>
            <Text variant="body-x-small" color="secondary">
              {onlineCount}/{metadata.brokers.length} brokers online
              {metadata.version && ` · Kafka ${metadata.version}`}
              {metadata.clusterId && ` · ${metadata.clusterId}`}
            </Text>
          </Flex>

          <Grid.Root
            columns={{ initial: '1', sm: '2', md: '3' }}
            gap="3"
          >
            {metadata.brokers.map(broker => {
              const isOnline = broker.status === 'online';

              return (
                <Grid.Item key={broker.address}>
                  <div className={`kafka-cluster-broker ${!isOnline ? 'kafka-cluster-broker-offline' : ''}`}>
                    <Flex justify="between" align="center">
                      <Flex align="center" gap="2">
                        <span className={`kafka-cluster-status-dot ${isOnline ? 'kafka-cluster-status-online' : 'kafka-cluster-status-offline'}`} />
                        <Text variant="body-x-small" weight="bold">
                          {broker.nodeId != null ? `Broker ${broker.nodeId}` : 'Broker'}
                        </Text>
                      </Flex>
                      <Flex gap="1">
                        {broker.isController && (
                          <span className="kafka-cluster-badge kafka-cluster-badge-controller">CONTROLLER</span>
                        )}
                        {!isOnline && (
                          <span className="kafka-cluster-badge kafka-cluster-badge-offline">OFFLINE</span>
                        )}
                      </Flex>
                    </Flex>
                    <span className="kafka-cluster-address">{broker.address}</span>
                  </div>
                </Grid.Item>
              );
            })}
          </Grid.Root>
        </Flex>
      </CardBody>
    </Card>
  );
};
