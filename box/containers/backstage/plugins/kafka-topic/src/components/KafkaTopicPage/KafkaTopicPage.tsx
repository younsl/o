import React, { useCallback } from 'react';
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
import { CreateTopicContent } from './CreateTopicPage';
import { ReviewRequestContent } from './ReviewRequestContent';
import './KafkaTopicPage.css';

export const KafkaTopicPage = () => {
  return (
    <Routes>
      <Route path="/" element={<RequestListView />} />
      <Route path="/create" element={<CreateView />} />
      <Route path="/requests/:id" element={<ReviewView />} />
    </Routes>
  );
};

/* ---------- List View ---------- */

const RequestListView = () => {
  const api = useApi(kafkaTopicApiRef);
  const navigate = useNavigate();

  const {
    value: requests,
    loading,
  } = useAsyncRetry(async () => api.getRequests(), [api]);

  const { value: userRole } = useAsyncRetry(async () => api.getUserRole(), [api]);
  const isAdmin = userRole?.isAdmin ?? false;

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
          <div className="kafka-results-table-wrap">
            <table className="kafka-results-table">
              <thead>
                <tr>
                  <th>Request ID</th>
                  <th>Cluster</th>
                  <th>Topic Name</th>
                  <th>Partitions</th>
                  <th>RF</th>
                  <th>ISR</th>
                  <th>Approval</th>
                  <th>Requested At</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {requests.map(r => (
                  <tr key={r.id}>
                    <td>
                      <span className="kafka-results-topic-name">{r.id.split('-')[0]}</span>
                    </td>
                    <td>{r.cluster}</td>
                    <td>
                      <span className="kafka-results-topic-name">{r.topicName}</span>
                    </td>
                    <td>{r.numPartitions}</td>
                    <td>{r.replicationFactor}</td>
                    <td>{r.configEntries?.['min.insync.replicas'] ?? '-'}</td>
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Container>
    </>
  );
};

/* ---------- Create View ---------- */

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
            Create a new topic with guided steps.
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

/* ---------- Review View ---------- */

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
