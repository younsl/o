import React, { useState, useCallback } from 'react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  Flex,
  Text,
  TextField,
} from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { kafkaTopicApiRef } from '../../api/KafkaTopicApi';
import { TopicRequest } from '../../api/types';
import { PartitionDistribution } from './PartitionDistribution';

interface ReviewRequestContentProps {
  request: TopicRequest;
  isAdmin: boolean;
  onBack: () => void;
  onApprove: (id: string, reason: string) => Promise<void>;
  onReject: (id: string, reason: string) => Promise<void>;
}

function statusLabel(status: string) {
  if (status === 'pending') return 'Pending';
  if (status === 'approved') return 'Approved';
  if (status === 'created') return 'Created';
  return 'Rejected';
}

export const ReviewRequestContent = ({
  request,
  isAdmin,
  onBack,
  onApprove,
  onReject,
}: ReviewRequestContentProps) => {
  const api = useApi(kafkaTopicApiRef);
  const { value: metadata } = useAsyncRetry(
    async () => api.getClusterMetadata(request.cluster),
    [api, request.cluster],
  );

  // Load batch siblings if this is part of a batch
  const { value: batchRequests } = useAsyncRetry(async () => {
    if (!request.batchId) return null;
    return api.getBatchRequests(request.batchId);
  }, [api, request.batchId]);

  const isBatch = !!request.batchId && batchRequests && batchRequests.length > 1;
  const batchTopicNames = batchRequests?.map(r => r.topicName) ?? [request.topicName];

  const [actionLoading, setActionLoading] = useState(false);
  const [actionResult, setActionResult] = useState<{ status: 'success' | 'danger'; message: string } | null>(null);
  const [reason, setReason] = useState('');

  const handleAction = useCallback(async (action: 'approve' | 'reject') => {
    if (!reason.trim()) {
      setActionResult({ status: 'danger', message: 'Reason is required.' });
      return;
    }
    setActionLoading(true);
    setActionResult(null);
    try {
      if (isBatch && request.batchId) {
        // Batch approve/reject
        if (action === 'approve') {
          await api.approveBatch(request.batchId, reason.trim());
          setActionResult({ status: 'success', message: `Batch approved: ${batchTopicNames.length} topics created.` });
        } else {
          await api.rejectBatch(request.batchId, reason.trim());
          setActionResult({ status: 'danger', message: `Batch rejected: ${batchTopicNames.length} topics.` });
        }
      } else {
        // Single approve/reject
        if (action === 'approve') {
          await onApprove(request.id, reason.trim());
          setActionResult({ status: 'success', message: `Topic "${request.topicName}" approved and created.` });
        } else {
          await onReject(request.id, reason.trim());
          setActionResult({ status: 'danger', message: `Topic "${request.topicName}" rejected.` });
        }
      }
    } catch (e: any) {
      const msg = e.body?.error ?? e.message ?? `Failed to ${action}`;
      setActionResult({ status: 'danger', message: typeof msg === 'string' ? msg : String(msg.message ?? msg) });
    } finally {
      setActionLoading(false);
    }
  }, [request, reason, onApprove, onReject, api, isBatch, batchTopicNames.length]);

  const isr = request.configEntries?.['min.insync.replicas'] ?? '-';
  const retention = request.configEntries?.['retention.ms'];
  const retentionLabel = retention ? `${Math.round(Number(retention) / 86400000)}d (${Number(retention).toLocaleString()}ms)` : '-';
  const isPending = request.status === 'pending';
  const batchAllPending = batchRequests?.every(r => r.status === 'pending') ?? isPending;

  return (
    <Flex direction="column" gap="4">
      {/* Request Info */}
      <Card>
        <CardBody>
          <Flex direction="column" gap="3">
            <Flex justify="between" align="center">
              <Text variant="body-small" weight="bold">
                Request Details
                {isBatch && (
                  <span className="kafka-review-default-hint"> — Batch ({batchTopicNames.length} topics)</span>
                )}
              </Text>
              <span className={`kafka-results-badge kafka-results-badge-${request.status}`}>
                {statusLabel(request.status)}
              </span>
            </Flex>
            <div className="kafka-review-grid">
              <div className="kafka-review-item">
                <Text variant="body-x-small" color="secondary">Request ID</Text>
                <Text variant="body-small" weight="bold">{request.id}</Text>
              </div>
              <div className="kafka-review-item">
                <Text variant="body-x-small" color="secondary">Cluster</Text>
                <Text variant="body-small" weight="bold">
                  {request.cluster}
                  {metadata?.version && (
                    <span className="kafka-review-default-hint"> (v{metadata.version})</span>
                  )}
                </Text>
              </div>
              {isBatch ? (
                <div className="kafka-review-item" style={{ gridColumn: '1 / -1' }}>
                  <Text variant="body-x-small" color="secondary">Topic Names ({batchTopicNames.length} {batchTopicNames.length > 1 ? 'topics' : 'topic'})</Text>
                  <Flex direction="column" gap="1">
                    {batchTopicNames.map(name => (
                      <Text key={name} variant="body-small" weight="bold" style={{ fontFamily: 'var(--bui-font-family-mono, monospace)' }}>
                        {name}
                      </Text>
                    ))}
                  </Flex>
                </div>
              ) : (
                <div className="kafka-review-item">
                  <Text variant="body-x-small" color="secondary">Topic Name</Text>
                  <Text variant="body-small" weight="bold">{request.topicName}</Text>
                </div>
              )}
              <div className="kafka-review-item">
                <Text variant="body-x-small" color="secondary">Requester</Text>
                <Text variant="body-small" weight="bold">{request.requester}</Text>
              </div>
              <div className="kafka-review-item">
                <Text variant="body-x-small" color="secondary">Requested At</Text>
                <Text variant="body-small" weight="bold">{new Date(request.createdAt).toLocaleString()}</Text>
              </div>
              {request.reviewer && (
                <div className="kafka-review-item">
                  <Text variant="body-x-small" color="secondary">Reviewer</Text>
                  <Text variant="body-small" weight="bold">{request.reviewer}</Text>
                </div>
              )}
              {request.status !== 'pending' && (
                <div className="kafka-review-item">
                  <Text variant="body-x-small" color="secondary">Reviewed At</Text>
                  <Text variant="body-small" weight="bold">{new Date(request.updatedAt).toLocaleString()}</Text>
                </div>
              )}
            </div>
          </Flex>
        </CardBody>
      </Card>

      {/* Topic Config */}
      <Card>
        <CardBody>
          <Flex direction="column" gap="3">
            <Text variant="body-small" weight="bold">Topic Configuration</Text>
            <div className="kafka-review-grid">
              <div className="kafka-review-item">
                <Text variant="body-x-small" color="secondary">Config Preset</Text>
                <Text variant="body-small" weight="bold">{request.trafficLevel}</Text>
              </div>
              <div className="kafka-review-item">
                <Text variant="body-x-small" color="secondary">Partitions</Text>
                <Text variant="body-small" weight="bold">{request.numPartitions}</Text>
              </div>
              <div className="kafka-review-item">
                <Text variant="body-x-small" color="secondary">Replication Factor</Text>
                <Text variant="body-small" weight="bold">{request.replicationFactor}</Text>
              </div>
              <div className="kafka-review-item">
                <Text variant="body-x-small" color="secondary">Min ISR</Text>
                <Text variant="body-small" weight="bold">{isr}</Text>
              </div>
              <div className="kafka-review-item">
                <Text variant="body-x-small" color="secondary">Cleanup Policy</Text>
                <Text variant="body-small" weight="bold">
                  {request.cleanupPolicy}
                  {request.cleanupPolicy === 'delete' && (
                    <span className="kafka-review-default-hint"> (default)</span>
                  )}
                </Text>
              </div>
              <div className="kafka-review-item">
                <Text variant="body-x-small" color="secondary">Retention</Text>
                <Text variant="body-small" weight="bold">{retentionLabel}</Text>
              </div>
            </div>
          </Flex>
        </CardBody>
      </Card>

      {/* Partition Distribution */}
      <PartitionDistribution
        numPartitions={request.numPartitions}
        replicationFactor={request.replicationFactor}
        brokerCount={metadata?.brokerCount ?? 0}
      />

      {/* Reason (already decided) */}
      {!isPending && request.reason && (
        <Card>
          <CardBody>
            <Flex direction="column" gap="2">
              <Text variant="body-x-small" color="secondary">
                {request.status === 'approved' ? 'Approval' : 'Rejection'} Reason
              </Text>
              <Text variant="body-small">{request.reason}</Text>
            </Flex>
          </CardBody>
        </Card>
      )}

      {/* Actions */}
      {actionResult && (
        <Alert status={actionResult.status} title={actionResult.message} />
      )}

      {batchAllPending && isAdmin && !actionResult ? (
        <Flex direction="column" gap="3">
          <TextField
            label="Reason"
            placeholder="Enter the reason for approval or rejection..."
            size="small"
            value={reason}
            onChange={setReason}
            isRequired
          />
          <Flex gap="2">
            <Button variant="primary" size="small" loading={actionLoading} onPress={() => handleAction('approve')}>
              {isBatch ? `Approve ${batchTopicNames.length} Topics` : 'Approve'}
            </Button>
            <Button variant="secondary" size="small" loading={actionLoading} onPress={() => handleAction('reject')}>
              {isBatch ? `Reject ${batchTopicNames.length} Topics` : 'Reject'}
            </Button>
          </Flex>
        </Flex>
      ) : (
        <Button variant="secondary" size="small" onPress={onBack}>
          Back to Requests
        </Button>
      )}
    </Flex>
  );
};
