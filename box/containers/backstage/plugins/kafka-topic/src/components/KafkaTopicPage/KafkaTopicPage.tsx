import React, { useCallback, useMemo, useState } from 'react';
import {
  Button,
  ButtonIcon,
  Container,
  Flex,
  PluginHeader,
  Skeleton,
  Text,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import { RiAddLine, RiArrowLeftLine, RiArrowRightSLine, RiFileSearchLine, RiUserFill, RiUserLine } from '@remixicon/react';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { Routes, Route, useNavigate, useParams } from 'react-router-dom';
import { kafkaTopicApiRef } from '../../api/KafkaTopicApi';
import { TopicRequest } from '../../api/types';
import { CreateTopicContent } from './CreateTopicPage';
import { ReviewRequestContent } from './ReviewRequestContent';
import './KafkaTopicPage.css';

const PAGE_SIZE = 20;

interface DisplayRow {
  representative: TopicRequest;
  allTopicNames: string[];
  count: number;
}

export const KafkaTopicPage = () => {
  return (
    <Routes>
      <Route path="/" element={<RequestListView />} />
      <Route path="/create" element={<CreateView />} />
      <Route path="/requests/:id" element={<ReviewView />} />
    </Routes>
  );
};

const RequestListView = () => {
  const api = useApi(kafkaTopicApiRef);
  const navigate = useNavigate();

  const {
    value: requests,
    loading,
  } = useAsyncRetry(async () => api.getRequests(), [api]);

  const { value: userRole } = useAsyncRetry(async () => api.getUserRole(), [api]);
  const isAdmin = userRole?.isAdmin ?? false;

  const [currentPage, setCurrentPage] = useState(0);

  const displayRows: DisplayRow[] = useMemo(() => {
    if (!requests) return [];
    const batchMap = new Map<string, TopicRequest[]>();
    const singles: TopicRequest[] = [];

    for (const r of requests) {
      if (r.batchId) {
        const group = batchMap.get(r.batchId) ?? [];
        group.push(r);
        batchMap.set(r.batchId, group);
      } else {
        singles.push(r);
      }
    }

    const rows: DisplayRow[] = [
      ...singles.map(r => ({
        representative: r,
        allTopicNames: [r.topicName],
        count: 1,
      })),
      ...[...batchMap.values()].map(group => {
        const sorted = [...group].sort((a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
        return {
          representative: sorted[0],
          allTopicNames: sorted.map(r => r.topicName),
          count: sorted.length,
        };
      }),
    ];

    // Sort by createdAt descending
    rows.sort((a, b) =>
      new Date(b.representative.createdAt).getTime() - new Date(a.representative.createdAt).getTime(),
    );

    return rows;
  }, [requests]);

  const totalPages = Math.max(1, Math.ceil(displayRows.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages - 1);
  const pagedRows = displayRows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <>
      <PluginHeader title="Kafka Topic" />
      <Container my="4">
        <Flex justify="between" align="center" mb="4">
          <Text variant="body-small" color="secondary">
            View topic creation requests and approvals.
          </Text>
          <Button variant="primary" size="small" onPress={() => navigate('create')}>
            <Flex align="center" gap="1">
              <RiAddLine size={16} />
              Create Topic
            </Flex>
          </Button>
        </Flex>

        {loading ? (
          <Flex direction="column" gap="3">
            <Skeleton style={{ height: 40, borderRadius: 8 }} />
            <Skeleton style={{ height: 200, borderRadius: 8 }} />
          </Flex>
        ) : !requests || requests.length === 0 ? (
          <Flex direction="column" align="center" gap="3" py="9">
            <Text variant="body-medium" color="secondary">
              No topic requests yet.
            </Text>
            <Text variant="body-small" color="secondary">
              Click "Create Topic" to get started.
            </Text>
          </Flex>
        ) : (
          <>
            <div className="kafka-results-table-wrap">
              <table className="kafka-results-table">
                <thead>
                  <tr>
                    <th>Request ID</th>
                    <th>Cluster</th>
                    <th>Topic Name</th>
                    <th className="kafka-col-compact">Partitions</th>
                    <th className="kafka-col-compact">RF</th>
                    <th className="kafka-col-compact">ISR</th>
                    <th>Approval</th>
                    <th>Requested At</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map(row => {
                    const r = row.representative;
                    return (
                      <tr key={r.id}>
                        <td>
                          <span className="kafka-results-topic-name">{r.id.split('-')[0]}</span>
                        </td>
                        <td>{r.cluster}</td>
                        <td>
                          <Flex align="center" gap="1">
                            <span className="kafka-results-topic-name">{r.topicName}</span>
                            {row.count > 1 && (
                              <TooltipTrigger delay={200}>
                                <ButtonIcon
                                  size="small"
                                  variant="tertiary"
                                  className="kafka-batch-count"
                                  icon={<span>+{row.count - 1} more</span>}
                                  aria-label={`${row.count} topics in batch`}
                                />
                                <Tooltip className="kafka-batch-tooltip">
                                  {row.allTopicNames.join(', ')}
                                </Tooltip>
                              </TooltipTrigger>
                            )}
                          </Flex>
                        </td>
                        <td className="kafka-col-compact">{r.numPartitions}</td>
                        <td className="kafka-col-compact">{r.replicationFactor}</td>
                        <td className="kafka-col-compact">{r.configEntries?.['min.insync.replicas'] ?? '-'}</td>
                        <td>
                          <div className="kafka-approval-flow">
                            <TooltipTrigger delay={200}>
                              <ButtonIcon
                                size="small"
                                variant="tertiary"
                                icon={<RiUserFill size={14} color="#6ea8fe" />}
                                aria-label="Requester"
                                className="kafka-approval-btn"
                              />
                              <Tooltip className="kafka-approval-tooltip">
                                <div className="kafka-approval-tooltip-label">Requester</div>
                                <div className="kafka-approval-tooltip-name">{r.requester}</div>
                                <div className="kafka-approval-tooltip-time">{new Date(r.createdAt).toLocaleString()}</div>
                              </Tooltip>
                            </TooltipTrigger>
                            {r.status !== 'created' && (
                              <>
                                <RiArrowRightSLine size={14} color="rgba(255,255,255,0.2)" />
                                <TooltipTrigger delay={200}>
                                  <ButtonIcon
                                    size="small"
                                    variant="tertiary"
                                    icon={
                                      r.status === 'pending'
                                        ? <RiUserLine size={14} color="#ff9800" />
                                        : <RiUserFill size={14} color={r.status === 'approved' ? '#4caf50' : '#f44336'} />
                                    }
                                    aria-label="Reviewer"
                                    className="kafka-approval-btn"
                                  />
                                  <Tooltip className="kafka-approval-tooltip">
                                    {r.status === 'pending' ? (
                                      <div className="kafka-approval-tooltip-label">Pending review</div>
                                    ) : (
                                      <>
                                        <div className="kafka-approval-tooltip-label">
                                          {r.status === 'approved' ? 'Approved' : 'Rejected'}
                                        </div>
                                        <div className="kafka-approval-tooltip-name">{r.reviewer}</div>
                                        <div className="kafka-approval-tooltip-time">{new Date(r.updatedAt).toLocaleString()}</div>
                                      </>
                                    )}
                                  </Tooltip>
                                </TooltipTrigger>
                              </>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className="kafka-results-time">
                            {new Date(r.createdAt).toLocaleString()}
                          </span>
                        </td>
                        <td>
                          <TooltipTrigger delay={200}>
                            <ButtonIcon
                              size="small"
                              variant={isAdmin && r.status === 'pending' ? 'primary' : 'tertiary'}
                              icon={<RiFileSearchLine size={16} />}
                              aria-label="View details"
                              onPress={() => navigate(`requests/${r.id}`)}
                            />
                            <Tooltip>{isAdmin && r.status === 'pending' ? 'Review' : 'View Details'}</Tooltip>
                          </TooltipTrigger>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <Flex justify="center" align="center" gap="3" mt="3" className="kafka-pagination">
                <Button
                  variant="secondary"
                  size="small"
                  isDisabled={safePage === 0}
                  onPress={() => setCurrentPage(p => Math.max(0, p - 1))}
                >
                  Prev
                </Button>
                <Text variant="body-x-small" color="secondary" className="kafka-pagination-info">
                  Page {safePage + 1} of {totalPages}
                </Text>
                <Button
                  variant="secondary"
                  size="small"
                  isDisabled={safePage >= totalPages - 1}
                  onPress={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
                >
                  Next
                </Button>
              </Flex>
            )}
          </>
        )}
      </Container>
    </>
  );
};

const CreateView = () => {
  const navigate = useNavigate();

  const handleBack = useCallback(() => {
    navigate('/kafka-topic');
  }, [navigate]);

  return (
    <>
      <PluginHeader title="Kafka Topic" />
      <Container my="4">
        <Flex justify="between" align="center" mb="4">
          <Text variant="body-small" color="secondary">
            Create new topics with guided steps.
          </Text>
          <Button variant="secondary" size="small" onPress={handleBack}>
            <Flex align="center" gap="1">
              <RiArrowLeftLine size={16} />
              Back to Requests
            </Flex>
          </Button>
        </Flex>
        <CreateTopicContent onBack={handleBack} />
      </Container>
    </>
  );
};

const ReviewView = () => {
  const { id } = useParams<{ id: string }>();
  const api = useApi(kafkaTopicApiRef);
  const navigate = useNavigate();

  const {
    value: request,
    loading,
    error,
    retry,
  } = useAsyncRetry(async () => api.getRequest(id!), [api, id]);

  const { value: userRole } = useAsyncRetry(async () => api.getUserRole(), [api]);
  const isAdmin = userRole?.isAdmin ?? false;

  const handleApprove = useCallback(async (reqId: string, reason: string) => {
    await api.approveRequest(reqId, reason);
    retry();
  }, [api, retry]);

  const handleReject = useCallback(async (reqId: string, reason: string) => {
    await api.rejectRequest(reqId, reason);
    retry();
  }, [api, retry]);

  const handleBack = useCallback(() => {
    navigate('/kafka-topic');
  }, [navigate]);

  return (
    <>
      <PluginHeader title="Kafka Topic" />
      <Container my="4">
        <Flex justify="between" align="center" mb="4">
          <Text variant="body-small" color="secondary">
            {request ? `Review request for "${request.topicName}"` : 'Loading request...'}
          </Text>
          <Button variant="secondary" size="small" onPress={handleBack}>
            <Flex align="center" gap="1">
              <RiArrowLeftLine size={16} />
              Back to Requests
            </Flex>
          </Button>
        </Flex>

        {loading ? (
          <Flex direction="column" gap="3">
            <Skeleton style={{ height: 120, borderRadius: 8 }} />
            <Skeleton style={{ height: 120, borderRadius: 8 }} />
          </Flex>
        ) : error || !request ? (
          <Flex direction="column" align="center" gap="3" py="9">
            <Text variant="body-medium" color="secondary">
              Request not found.
            </Text>
            <Button variant="secondary" size="small" onPress={handleBack}>
              Back to Requests
            </Button>
          </Flex>
        ) : (
          <ReviewRequestContent
            request={request}
            isAdmin={isAdmin}
            onBack={handleBack}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        )}
      </Container>
    </>
  );
};
