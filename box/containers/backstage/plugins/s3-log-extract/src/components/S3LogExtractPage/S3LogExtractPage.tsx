import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardBody,
  Container,
  Flex,
  HeaderPage,
  Select,
  Skeleton,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  TextField,
} from '@backstage/ui';
import { useApi, identityApiRef } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { s3LogExtractApiRef } from '../../api';
import { LogExtractRequest } from '../../api/types';
import {
  RiCheckLine,
  RiCloseLine,
  RiDownloadLine,
  RiLoader4Line,
  RiTimeLine,
} from '@remixicon/react';
import './S3LogExtractPage.css';

const sourceOptions = [
  { value: 'k8s', label: 'k8s' },
  { value: 'ec2', label: 'ec2' },
];

const envOptions = [
  { value: 'dev', label: 'dev' },
  { value: 'stg', label: 'stg' },
  { value: 'sb', label: 'sb' },
  { value: 'prd', label: 'prd' },
];

// --- Review Dialog ---

interface ReviewDialogProps {
  request: LogExtractRequest;
  action: 'approve' | 'reject';
  open: boolean;
  onClose: () => void;
  onReviewed: () => void;
}

const ReviewDialog = ({
  request,
  action,
  open,
  onClose,
  onReviewed,
}: ReviewDialogProps) => {
  const api = useApi(s3LogExtractApiRef);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [open]);

  if (!open) return null;

  const isApprove = action === 'approve';

  const handleSubmit = async () => {
    if (!comment.trim()) {
      setError('Comment is required');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await api.reviewRequest(request.id, {
        action,
        comment: comment.trim(),
      });
      setComment('');
      onReviewed();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to submit review',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sle-overlay" onClick={onClose}>
      <div className="sle-dialog" onClick={e => e.stopPropagation()}>
        <Text as="h3" variant="body-large" weight="bold">
          {isApprove ? 'Approve' : 'Reject'} Log Extract Request
        </Text>
        <Box mt="3">
          <Text as="p" variant="body-small" color="secondary">
            Environment: <strong>{request.env}</strong> | Date:{' '}
            <strong>{request.date}</strong>
          </Text>
          <Text as="p" variant="body-small" color="secondary">
            Time: {request.startTime} - {request.endTime} (KST)
          </Text>
          <Text as="p" variant="body-small" color="secondary">
            Apps: {request.apps.join(', ')}
          </Text>
          <Text as="p" variant="body-small" color="secondary">
            Requester: {request.requesterRef}
          </Text>
          <Text as="p" variant="body-small" color="secondary">
            Reason: {request.reason}
          </Text>
        </Box>

        <Box mt="3">
          <label className="sle-label">
            <Text variant="body-small" weight="bold">
              Comment{' '}
              <Text as="span" variant="body-small" color="danger">
                *
              </Text>
            </Text>
            <textarea
              className="sle-textarea"
              rows={2}
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={
                isApprove ? 'Reason for approval' : 'Reason for rejection'
              }
            />
          </label>
        </Box>

        {error && (
          <Box mt="2">
            <Text variant="body-small" color="danger">
              {error}
            </Text>
          </Box>
        )}

        <Flex gap="2" justify="end" mt="4">
          <Button
            variant="secondary"
            onPress={onClose}
            isDisabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant={isApprove ? 'primary' : 'secondary'}
            destructive={!isApprove}
            onPress={handleSubmit}
            isDisabled={submitting || !comment.trim()}
          >
            {submitting
              ? 'Submitting...'
              : isApprove
                ? 'Approve'
                : 'Reject'}
          </Button>
        </Flex>
      </div>
    </div>
  );
};

// --- Request Form ---

const RequestForm = ({ onSubmitted }: { onSubmitted: () => void }) => {
  const api = useApi(s3LogExtractApiRef);
  const [source, setSource] = useState('k8s');
  const [env, setEnv] = useState('dev');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [reason, setReason] = useState('');
  const [selectedApps, setSelectedApps] = useState<string[]>([]);
  const [appSearch, setAppSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [apps, setApps] = useState<string[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState<Error | undefined>();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const fetchApps = useCallback(
    (e: string, d: string, s: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (!e || !d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        setApps([]);
        return;
      }

      setAppsLoading(true);
      debounceRef.current = setTimeout(async () => {
        try {
          const result = await api.listApps(e, d, s);
          setApps(result);
          setAppsError(undefined);
        } catch (err) {
          setAppsError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          setAppsLoading(false);
        }
      }, 1000);
    },
    [api],
  );

  useEffect(() => {
    fetchApps(env, date, source);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [env, date, source, fetchApps]);

  // Reset selected apps when source/env/date changes
  useEffect(() => {
    setSelectedApps([]);
  }, [source, env, date]);

  // Auto-format time input: "1100" → "11:00", "930" → "09:30", "9" → "09:00"
  const formatTime = (raw: string): string => {
    const digits = raw.replace(/\D/g, '');
    if (!digits) return raw;
    if (digits.length <= 2) {
      const h = digits.padStart(2, '0');
      return `${h}:00`;
    }
    if (digits.length === 3) {
      const h = `0${digits[0]}`;
      const m = digits.slice(1);
      return `${h}:${m}`;
    }
    // 4+ digits: first 2 = hours, next 2 = minutes
    const h = digits.slice(0, 2);
    const m = digits.slice(2, 4);
    return `${h}:${m}`;
  };

  const handleTimeBlur = (
    value: string,
    setter: React.Dispatch<React.SetStateAction<string>>,
  ) => {
    if (value && !value.includes(':')) {
      setter(formatTime(value));
    }
  };

  const highlightMatch = (text: string, query: string) => {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="sle-highlight">{text.slice(idx, idx + query.length)}</mark>
        {text.slice(idx + query.length)}
      </>
    );
  };

  const toggleApp = (app: string) => {
    setSelectedApps(prev =>
      prev.includes(app) ? prev.filter(a => a !== app) : [...prev, app],
    );
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);

    try {
      await api.createRequest({
        source,
        env,
        date,
        apps: selectedApps,
        startTime,
        endTime,
        reason,
      });
      setSuccess(true);
      setSelectedApps([]);
      setReason('');
      setStartTime('');
      setEndTime('');
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  const isValid =
    env && date && selectedApps.length > 0 && startTime && endTime && reason.trim();

  return (
    <Box mt="4">
      <Flex direction="column" gap="3">
        <Flex gap="3">
          <div className="sle-required-field" style={{ flex: 1 }}>
            <Select
              label="Source"
              options={sourceOptions}
              selectedKey={source}
              onSelectionChange={key => setSource(key as string)}
            />
          </div>
          <div className="sle-required-field" style={{ flex: 1 }}>
            <Select
              label="Environment"
              options={envOptions}
              selectedKey={env}
              onSelectionChange={key => setEnv(key as string)}
            />
          </div>
        </Flex>

        <div className="sle-required-field">
          <TextField
            label="Date (KST)"
            value={date}
            onChange={setDate}
            placeholder="YYYY-MM-DD"
          />
        </div>

        <Flex gap="3">
          <div className="sle-required-field" style={{ flex: 1 }}>
            <TextField
              label="Start Time (KST)"
              value={startTime}
              onChange={setStartTime}
              onBlur={() => handleTimeBlur(startTime, setStartTime)}
              placeholder="HH:MM (e.g. 1100)"
            />
          </div>
          <div className="sle-required-field" style={{ flex: 1 }}>
            <TextField
              label="End Time (KST)"
              value={endTime}
              onChange={setEndTime}
              onBlur={() => handleTimeBlur(endTime, setEndTime)}
              placeholder="HH:MM (e.g. 1430)"
            />
          </div>
        </Flex>

        <Box>
          <Text
            variant="body-small"
            weight="bold"
            style={{ display: 'block', marginBottom: 8 }}
          >
            Applications{' '}
            <Text as="span" variant="body-small" color="danger">
              *
            </Text>{' '}
            <Text
              as="span"
              variant="body-small"
              color="secondary"
              weight="regular"
            >
              {apps && apps.length > 0
                ? `(${apps.length} apps)`
                : '(select one or more)'}
            </Text>
          </Text>
          {!date ? (
            <Text variant="body-small" color="secondary">
              Select environment and date to load apps
            </Text>
          ) : appsLoading ? (
            <Skeleton width="100%" height={40} />
          ) : appsError ? (
            <Alert status="danger" title="Failed to load apps" />
          ) : !apps || apps.length === 0 ? (
            <Text variant="body-small" color="secondary">
              No apps found for {env} on {date}
            </Text>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>
                <input
                  type="text"
                  className="sle-app-search"
                  placeholder="Search apps..."
                  value={appSearch}
                  onChange={e => setAppSearch(e.target.value)}
                />
              </div>
              <div className="sle-app-grid">
                {apps
                  .filter(app =>
                    app.toLowerCase().includes(appSearch.toLowerCase()),
                  )
                  .map(app => (
                    <button
                      key={app}
                      type="button"
                      className={`sle-app-toggle ${selectedApps.includes(app) ? 'sle-app-toggle--active' : ''}`}
                      onClick={() => toggleApp(app)}
                    >
                      <span className="sle-app-name">
                        {appSearch
                          ? highlightMatch(app, appSearch)
                          : app}
                      </span>
                    </button>
                  ))}
              </div>
            </>
          )}
        </Box>

        <div className="sle-required-field">
          <TextField
            label="Reason"
            value={reason}
            onChange={setReason}
            placeholder="Why do you need these logs?"
          />
        </div>

        {error && <Alert status="danger" title={error} />}

        {success && (
          <Alert
            status="success"
            title="Request submitted. Waiting for admin approval."
          />
        )}

        <Flex justify="end">
          <Button
            variant="primary"
            onPress={handleSubmit}
            isDisabled={submitting || !isValid}
          >
            {submitting ? 'Submitting...' : 'Submit Request'}
          </Button>
        </Flex>
      </Flex>
    </Box>
  );
};

// --- Request List ---

const RequestList = ({
  refreshKey,
}: {
  refreshKey: number;
}) => {
  const api = useApi(s3LogExtractApiRef);
  const identityApi = useApi(identityApiRef);

  const {
    value: requests,
    loading,
    error: loadError,
    retry,
  } = useAsyncRetry(async () => {
    return api.listRequests();
  }, [refreshKey]);

  const { value: adminStatus } = useAsyncRetry(async () => {
    return api.getAdminStatus();
  }, []);

  const { value: currentUserRef } = useAsyncRetry(async () => {
    const identity = await identityApi.getBackstageIdentity();
    return identity.userEntityRef;
  }, []);

  const [reviewTarget, setReviewTarget] = useState<{
    request: LogExtractRequest;
    action: 'approve' | 'reject';
  } | null>(null);

  const isAdmin = adminStatus?.isAdmin ?? false;

  const handleDownload = async (id: string) => {
    const url = await api.downloadUrl(id);
    window.open(url, '_blank');
  };

  const getStatusClassName = (status: string): string => {
    switch (status) {
      case 'approved':
      case 'completed':
        return 'sle-status-success';
      case 'rejected':
      case 'failed':
        return 'sle-status-danger';
      case 'extracting':
        return 'sle-status-info';
      default:
        return 'sle-status-warning';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'approved':
      case 'completed':
        return <RiCheckLine size={14} />;
      case 'rejected':
      case 'failed':
        return <RiCloseLine size={14} />;
      case 'extracting':
        return <RiLoader4Line size={14} className="sle-spin" />;
      default:
        return <RiTimeLine size={14} />;
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const formatTimestamp = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  };

  const formatSize = (bytes: number | null) => {
    if (bytes === null) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
        <Alert status="danger" title="Failed to load requests" />
      </Box>
    );
  }

  if (!requests || requests.length === 0) {
    return (
      <Box mt="4">
        <div className="sle-empty-state">
          <Text variant="body-medium" color="secondary">
            No requests yet
          </Text>
        </div>
      </Box>
    );
  }

  return (
    <>
      <Box mt="4">
        <Flex justify="between" align="center" mb="3">
          <Text variant="body-medium" weight="bold">
            Requests
          </Text>
          <Flex align="center" gap="2">
            <span className="sle-count-badge">{requests.length}</span>
            <Text variant="body-small" color="secondary">
              total
            </Text>
          </Flex>
        </Flex>

        <div className="sle-grid">
          {requests.map(request => (
            <div key={request.id} className="sle-card-wrapper">
              <Card>
                <CardBody className="sle-card-body">
                  <div>
                    <Text variant="body-medium" weight="bold">
                      {request.source} &middot;{' '}
                      {request.env.toUpperCase()} &middot; {request.date}
                    </Text>
                    <Text
                      variant="body-x-small"
                      color="secondary"
                      style={{ display: 'block', marginTop: 4 }}
                    >
                      {request.startTime} - {request.endTime} (KST)
                    </Text>
                  </div>

                  <div className="sle-field">
                    <Text
                      variant="body-x-small"
                      color="secondary"
                      className="sle-field-label"
                    >
                      Apps
                    </Text>
                    <Flex gap="1" style={{ flexWrap: 'wrap' }}>
                      {request.apps.map(app => (
                        <span key={app} className="sle-app-tag">
                          {app}
                        </span>
                      ))}
                    </Flex>
                  </div>

                  <div className="sle-field">
                    <Text
                      variant="body-x-small"
                      color="secondary"
                      className="sle-field-label"
                    >
                      Request ID
                    </Text>
                    <Text variant="body-small" className="sle-request-id">
                      {request.id}
                    </Text>
                  </div>

                  <div className="sle-field">
                    <Text
                      variant="body-x-small"
                      color="secondary"
                      className="sle-field-label"
                    >
                      Requester
                    </Text>
                    <Text variant="body-small">{request.requesterRef}</Text>
                  </div>

                  <div className="sle-field">
                    <Text
                      variant="body-x-small"
                      color="secondary"
                      className="sle-field-label"
                    >
                      Reason
                    </Text>
                    <Text variant="body-small">{request.reason}</Text>
                  </div>

                  {request.reviewerRef && (
                    <div className="sle-field">
                      <Text
                        variant="body-x-small"
                        color="secondary"
                        className="sle-field-label"
                      >
                        Reviewed by
                      </Text>
                      <Text variant="body-small">
                        {request.reviewerRef}
                      </Text>
                    </div>
                  )}

                  {request.reviewComment && (
                    <div className="sle-field">
                      <Text
                        variant="body-x-small"
                        color="secondary"
                        className="sle-field-label"
                      >
                        Comment
                      </Text>
                      <Text variant="body-small">
                        {request.reviewComment}
                      </Text>
                    </div>
                  )}

                  {request.status === 'completed' && (
                    <div className="sle-field">
                      <Text
                        variant="body-x-small"
                        color="secondary"
                        className="sle-field-label"
                      >
                        Result
                      </Text>
                      <Text variant="body-small">
                        {request.fileCount} files &middot;{' '}
                        {formatSize(request.archiveSize)}
                      </Text>
                      {request.firstTimestamp && request.lastTimestamp && (
                        <Text
                          variant="body-x-small"
                          color="secondary"
                          style={{ marginTop: '2px' }}
                        >
                          {formatTimestamp(request.firstTimestamp)} ~{' '}
                          {formatTimestamp(request.lastTimestamp)}
                        </Text>
                      )}
                    </div>
                  )}

                  {request.errorMessage && (
                    <div className="sle-field">
                      <Text
                        variant="body-x-small"
                        color="secondary"
                        className="sle-field-label"
                      >
                        Error
                      </Text>
                      <Text variant="body-small" color="danger">
                        {request.errorMessage}
                      </Text>
                    </div>
                  )}

                  <div className="sle-card-footer">
                    <Text variant="body-x-small" color="secondary">
                      {formatDate(request.createdAt)}
                    </Text>
                    <span className={getStatusClassName(request.status)}>
                      {request.status}
                      {getStatusIcon(request.status)}
                    </span>
                  </div>

                  {/* Admin actions for pending requests */}
                  {isAdmin && request.status === 'pending' && (
                    <Flex gap="2" mt="2" className="sle-card-actions">
                      <Button
                        variant="primary"
                        size="small"
                        onPress={() =>
                          setReviewTarget({
                            request,
                            action: 'approve',
                          })
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        variant="primary"
                        size="small"
                        destructive
                        onPress={() =>
                          setReviewTarget({
                            request,
                            action: 'reject',
                          })
                        }
                      >
                        Reject
                      </Button>
                    </Flex>
                  )}

                  {/* Download for completed requests - only the requester can download */}
                  {request.status === 'completed' &&
                    currentUserRef === request.requesterRef && (
                    <Flex mt="2">
                      <Button
                        variant="secondary"
                        size="small"
                        onPress={() => handleDownload(request.id)}
                      >
                        <Flex align="center" gap="1">
                          <RiDownloadLine size={14} />
                          Download
                        </Flex>
                      </Button>
                    </Flex>
                  )}
                </CardBody>
              </Card>
            </div>
          ))}
        </div>
      </Box>

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

// --- Main Page ---

export const S3LogExtractPage = () => {
  const api = useApi(s3LogExtractApiRef);
  const [refreshKey, setRefreshKey] = useState(0);

  const { value: s3Config } = useAsyncRetry(async () => {
    return api.getConfig();
  }, []);

  return (
    <>
      <HeaderPage title="S3 Log Extract" />
      <Container my="4">
        {s3Config && s3Config.bucket && (
          <Box mb="3">
            <Text variant="body-small" color="secondary">
              Bucket: <strong>{s3Config.bucket}</strong> &middot; Region:{' '}
              <strong>{s3Config.region}</strong>
              {s3Config.prefix ? (
                <>
                  {' '}
                  &middot; Prefix: <strong>{s3Config.prefix}</strong>
                </>
              ) : null}
            </Text>
          </Box>
        )}
        <Tabs defaultSelectedKey="request">
          <TabList>
            <Tab id="request">Request</Tab>
            <Tab id="requests">Requests</Tab>
          </TabList>
          <TabPanel id="request">
            <RequestForm
              onSubmitted={() => setRefreshKey(k => k + 1)}
            />
          </TabPanel>
          <TabPanel id="requests">
            <RequestList refreshKey={refreshKey} />
          </TabPanel>
        </Tabs>
      </Container>
    </>
  );
};
