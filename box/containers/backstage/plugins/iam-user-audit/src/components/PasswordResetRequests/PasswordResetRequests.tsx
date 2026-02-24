import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardBody,
  Flex,
  Grid,
  Skeleton,
  Text,
} from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { iamUserAuditApiRef } from '../../api';
import { PasswordResetRequest } from '../../api/types';
import { ReviewDialog } from './ReviewDialog';
import './PasswordResetRequests.css';

interface PasswordResetRequestsProps {
  showActions?: boolean;
  filter?: 'pending';
}

export const PasswordResetRequests = ({
  showActions = true,
  filter,
}: PasswordResetRequestsProps) => {
  const api = useApi(iamUserAuditApiRef);

  const {
    value: requests,
    loading,
    error: loadError,
    retry,
  } = useAsyncRetry(async () => {
    return api.listPasswordResetRequests();
  }, []);

  const { value: adminStatus } = useAsyncRetry(async () => {
    return api.getAdminStatus();
  }, []);

  const [reviewTarget, setReviewTarget] = useState<{
    request: PasswordResetRequest;
    action: 'approve' | 'reject';
  } | null>(null);

  const isAdmin = adminStatus?.isAdmin ?? false;

  const filteredRequests = filter === 'pending'
    ? (requests ?? []).filter(r => r.status === 'pending')
    : requests;

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getStatusClassName = (status: string): string => {
    if (status === 'approved') return 'pr-status-approved';
    if (status === 'rejected') return 'pr-status-rejected';
    return 'pr-status-pending';
  };

  if (loading) {
    return (
      <Box mt="4">
        <Skeleton width="100%" height={120} />
      </Box>
    );
  }

  if (loadError) {
    return (
      <Box mt="4">
        <Alert status="danger" title="Failed to load password reset requests" />
      </Box>
    );
  }

  if (!filteredRequests || filteredRequests.length === 0) {
    return (
      <Box mt="4">
        <div className="pr-empty-state">
          <Text variant="body-medium" color="secondary">
            No password reset requests
          </Text>
        </div>
      </Box>
    );
  }

  return (
    <>
      <Grid.Root columns={{ initial: '1', sm: '2', md: '3' }} gap="3">
        {filteredRequests.map(request => (
          <Grid.Item key={request.id}>
            <Card className="pr-card">
              <CardBody className="pr-card-body">
                <Flex justify="between" align="start">
                  <Text variant="body-medium" weight="bold">
                    {request.iamUserName}
                  </Text>
                  <span className={getStatusClassName(request.status)}>
                    {request.status}
                  </span>
                </Flex>

                <div className="pr-field">
                  <Text
                    variant="body-x-small"
                    color="secondary"
                    className="pr-field-label"
                  >
                    Request ID
                  </Text>
                  <Text variant="body-small" className="pr-request-id">
                    {request.id}
                  </Text>
                </div>

                <div className="pr-field">
                  <Text
                    variant="body-x-small"
                    color="secondary"
                    className="pr-field-label"
                  >
                    Requester
                  </Text>
                  <Text variant="body-small">{request.requesterRef}</Text>
                </div>

                <div className="pr-field">
                  <Text
                    variant="body-x-small"
                    color="secondary"
                    className="pr-field-label"
                  >
                    Reason
                  </Text>
                  <Text variant="body-small">{request.reason}</Text>
                </div>

                {request.reviewerRef && (
                  <div className="pr-field">
                    <Text
                      variant="body-x-small"
                      color="secondary"
                      className="pr-field-label"
                    >
                      Reviewed by
                    </Text>
                    <Text variant="body-small">{request.reviewerRef}</Text>
                  </div>
                )}

                {request.reviewComment && (
                  <div className="pr-field">
                    <Text
                      variant="body-x-small"
                      color="secondary"
                      className="pr-field-label"
                    >
                      Comment
                    </Text>
                    <Text variant="body-small">{request.reviewComment}</Text>
                  </div>
                )}

                <Text variant="body-x-small" color="secondary">
                  {formatDate(request.createdAt)}
                </Text>

                {showActions && isAdmin && request.status === 'pending' && (
                  <Flex gap="2" mt="2" justify="end">
                    <Button
                      variant="primary"
                      size="small"
                      onPress={() =>
                        setReviewTarget({ request, action: 'approve' })
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      onPress={() =>
                        setReviewTarget({ request, action: 'reject' })
                      }
                    >
                      Reject
                    </Button>
                  </Flex>
                )}
              </CardBody>
            </Card>
          </Grid.Item>
        ))}
      </Grid.Root>

      {reviewTarget && (
        <ReviewDialog
          request={reviewTarget.request}
          action={reviewTarget.action}
          open
          onClose={() => setReviewTarget(null)}
          onReviewed={retry}
        />
      )}
    </>
  );
};
