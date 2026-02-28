import React, { useState, useMemo } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardBody,
  Flex,
  SearchField,
  Select,
  Skeleton,
  Text,
} from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { iamUserAuditApiRef } from '../../api';
import { PasswordResetRequest } from '../../api/types';
import {
  RiCheckLine,
  RiCloseLine,
  RiTimeLine,
} from '@remixicon/react';
import { ReviewDialog } from './ReviewDialog';
import { HighlightText } from '../HighlightText';
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

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const isAdmin = adminStatus?.isAdmin ?? false;

  const filteredRequests = useMemo(() => {
    let list = requests ?? [];
    if (filter === 'pending') {
      list = list.filter(r => r.status === 'pending');
    }
    return list.filter(r => {
      const matchesSearch =
        searchQuery === '' ||
        r.iamUserName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        r.requesterRef.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStatus =
        statusFilter === 'all' || r.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [requests, filter, searchQuery, statusFilter]);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getStatusClassName = (status: string): string => {
    if (status === 'approved') return 'pr-status-approved';
    if (status === 'rejected') return 'pr-status-rejected';
    return 'pr-status-pending';
  };

  const getStatusIcon = (status: string) => {
    if (status === 'approved') return <RiCheckLine size={14} />;
    if (status === 'rejected') return <RiCloseLine size={14} />;
    return <RiTimeLine size={14} />;
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

  if (!requests || requests.length === 0) {
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

  const statusOptions = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
  ];

  return (
    <>
      {!filter && (
        <div className="pr-filter-bar">
          <SearchField
            label="Search"
            placeholder="Search by username or requester..."
            size="small"
            value={searchQuery}
            onChange={setSearchQuery}
          />
          <Select
            label="Status"
            size="small"
            options={statusOptions}
            selectedKey={statusFilter}
            onSelectionChange={key => setStatusFilter(key as string)}
          />
        </div>
      )}

      {filteredRequests.length === 0 ? (
        <div className="pr-empty-state">
          <Text variant="body-medium" color="secondary">
            No requests match the current filters
          </Text>
        </div>
      ) : (
      <div className="pr-grid">
        {filteredRequests.map(request => (
          <div key={request.id} className="pr-card-wrapper">
            <Card>
              <CardBody className="pr-card-body">
                <div>
                  <Text variant="body-medium" weight="bold">
                    <HighlightText text={request.iamUserName} query={searchQuery} />
                  </Text>
                  <Text variant="body-x-small" color="secondary" className="pr-arn">
                    {request.iamUserArn}
                  </Text>
                </div>

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
                  <Text variant="body-small">
                    <HighlightText text={request.requesterRef} query={searchQuery} />
                  </Text>
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

                <div className="pr-card-footer">
                  <Text variant="body-x-small" color="secondary">
                    {formatDate(request.createdAt)}
                  </Text>
                  <span className={getStatusClassName(request.status)}>
                    {request.status}
                    {getStatusIcon(request.status)}
                  </span>
                </div>

                {showActions && isAdmin && request.status === 'pending' && (
                  <Flex gap="2" mt="2" className="pr-card-actions">
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
                      variant="primary"
                      size="small"
                      destructive
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
          </div>
        ))}
      </div>
      )}

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
