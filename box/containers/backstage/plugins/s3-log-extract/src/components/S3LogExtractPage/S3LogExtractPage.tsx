import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardBody,
  Container,
  Flex,
  PluginHeader,
  Select,
  Skeleton,
  Text,
  TextField,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import { useApi, identityApiRef } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { s3LogExtractApiRef } from '../../api';
import { Environment, LogExtractRequest, RequestStatus } from '../../api/types';
import {
  RiAddLine,
  RiArrowLeftLine,
  RiCheckLine,
  RiCloseLine,
  RiDownloadLine,
  RiInformationLine,
  RiLoader4Line,
  RiTimeLine,
} from '@remixicon/react';
import './S3LogExtractPage.css';

const isInvalidDate = (v: string) => v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v);
const isInvalidTime = (v: string) => v !== '' && !/^(\d{1,4}|\d{2}:\d{2})$/.test(v);

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

const RequestForm = ({
  onSubmitted,
  maxTimeRangeMinutes,
}: {
  onSubmitted: () => void;
  maxTimeRangeMinutes: number;
}) => {
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

  useEffect(() => {
    setSelectedApps([]);
  }, [source, env, date]);

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

  const timeRangeMinutes = useMemo(() => {
    const parseMinutes = (t: string) => {
      const m = t.match(/^(\d{2}):(\d{2})$/);
      return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
    };
    const s = parseMinutes(startTime);
    const e = parseMinutes(endTime);
    if (s === null || e === null) return null;
    return e >= s ? e - s : 24 * 60 - s + e;
  }, [startTime, endTime]);

  const formatMinutes = (m: number) => {
    if (m >= 60 && m % 60 === 0) return `${m / 60}h`;
    if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${m}m`;
  };

  const timeRangeError =
    timeRangeMinutes !== null && timeRangeMinutes > maxTimeRangeMinutes
      ? `Maximum ${formatMinutes(maxTimeRangeMinutes)} allowed, but ${formatMinutes(timeRangeMinutes)} selected`
      : null;

  const isValid =
    env &&
    date &&
    selectedApps.length > 0 &&
    startTime &&
    endTime &&
    reason.trim() &&
    !timeRangeError;

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

        <Flex gap="3">
          <div className="sle-required-field" style={{ flex: 1 }}>
            <TextField
              label="Date (KST)"
              value={date}
              onChange={setDate}
              placeholder="YYYY-MM-DD"
              isInvalid={isInvalidDate(date)}
            />
          </div>
          <div className="sle-required-field" style={{ flex: 1 }}>
            <TextField
              label="Start Time (KST)"
              value={startTime}
              onChange={setStartTime}
              onBlur={() => handleTimeBlur(startTime, setStartTime)}
              placeholder="HH:MM (e.g. 1100)"
              isInvalid={isInvalidTime(startTime) || !!timeRangeError}
            />
          </div>
          <div className="sle-required-field" style={{ flex: 1 }}>
            <TextField
              label="End Time (KST)"
              value={endTime}
              onChange={setEndTime}
              onBlur={() => handleTimeBlur(endTime, setEndTime)}
              placeholder="HH:MM (e.g. 1430)"
              isInvalid={isInvalidTime(endTime) || !!timeRangeError}
            />
          </div>
        </Flex>
        <Text variant="body-x-small" color={timeRangeError ? 'danger' : 'secondary'}>
          {timeRangeMinutes !== null
            ? `Extractable up to ${formatMinutes(maxTimeRangeMinutes)} per request (current: ${formatMinutes(timeRangeMinutes)})`
            : `Extractable up to ${formatMinutes(maxTimeRangeMinutes)} per request`}
        </Text>
        {timeRangeError && (
          <Alert status="danger" title={timeRangeError} />
        )}

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

  const statusFilters: Array<{ value: RequestStatus | 'all'; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Approved' },
    { value: 'extracting', label: 'Extracting' },
    { value: 'completed', label: 'Completed' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'failed', label: 'Failed' },
  ];

  const [statusFilter, setStatusFilter] = useState<RequestStatus | 'all'>('all');

  const envFilters: Array<{ value: Environment | 'all'; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'dev', label: 'DEV' },
    { value: 'stg', label: 'STG' },
    { value: 'sb', label: 'SB' },
    { value: 'prd', label: 'PRD' },
  ];

  const [envFilter, setEnvFilter] = useState<Environment | 'all'>('all');

  const filteredRequests = useMemo(() => {
    if (!requests) return [];
    return requests.filter(r => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (envFilter !== 'all' && r.env !== envFilter) return false;
      return true;
    });
  }, [requests, statusFilter, envFilter]);

  const isAdmin = adminStatus?.isAdmin ?? false;

  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = async (id: string) => {
    try {
      setDownloadError(null);
      const blobUrl = await api.downloadUrl(id);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `logs-${id}.tar.gz`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : 'Download failed',
      );
    }
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
      <Box mt="3" p="3" className="sle-section-box">
        <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
          Filters
        </Text>
        <Flex gap="3" style={{ flexWrap: 'wrap' }}>
          <div style={{ minWidth: 160 }}>
            <Select
              label="Status"
              value={statusFilter}
              onChange={val => setStatusFilter(val as RequestStatus | 'all')}
              options={statusFilters.map(f => {
                if (f.value === 'all') return { value: f.value, label: f.label };
                const count = requests?.filter(r => r.status === f.value).length ?? 0;
                return { value: f.value, label: `${f.label} (${count})` };
              })}
            />
          </div>
          <div style={{ minWidth: 160 }}>
            <Select
              label="Environment"
              value={envFilter}
              onChange={val => setEnvFilter(val as Environment | 'all')}
              options={envFilters.map(f => {
                if (f.value === 'all') return { value: f.value, label: f.label };
                const count = requests?.filter(r => r.env === f.value).length ?? 0;
                return { value: f.value, label: `${f.label} (${count})` };
              })}
            />
          </div>
        </Flex>
      </Box>

      <Box mt="3" p="3" className="sle-section-box">
        <Flex justify="between" align="center" style={{ marginBottom: 12 }}>
          <Text variant="body-medium" weight="bold">
            Requests
          </Text>
          <Flex align="center" gap="2">
            <span className="sle-count-badge">{filteredRequests.length}</span>
            <Text variant="body-small" color="secondary">
              {statusFilter === 'all' ? 'total' : statusFilter}
            </Text>
          </Flex>
        </Flex>

        {downloadError && (
          <Alert
            status="danger"
            title={downloadError}
            style={{ marginBottom: 12 }}
          />
        )}

        {filteredRequests.length === 0 ? (
          <div className="sle-empty-state">
            <Text variant="body-medium" color="secondary">
              No {statusFilter} requests
            </Text>
          </div>
        ) : (
        <div className="sle-grid">
          {filteredRequests.map(request => (
            <div key={request.id} className="sle-card-wrapper">
              <Card>
                <CardBody className="sle-card-body">
                  <Flex justify="between" align="start">
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
                    {request.status === 'completed' &&
                      (currentUserRef === request.requesterRef || isAdmin) && (
                      <span className={!request.downloadable ? 'sle-btn-expired' : ''}>
                        <Button
                          variant="secondary"
                          size="small"
                          isDisabled={!request.downloadable}
                          onPress={() => handleDownload(request.id)}
                        >
                          <Flex align="center" gap="1">
                            <RiDownloadLine size={14} />
                            {request.downloadable ? 'Download' : 'Expired'}
                          </Flex>
                        </Button>
                      </span>
                    )}
                  </Flex>

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
                      <Flex align="center" gap="1">
                        <Text variant="body-small">
                          {request.fileCount} files ({formatSize(request.archiveSize)})
                        </Text>
                        <TooltipTrigger closeDelay={100}>
                          <Button
                            variant="tertiary"
                            size="small"
                            style={{ padding: 0, minHeight: 'unset', minWidth: 'unset', color: 'var(--bui-color-text-secondary)' }}
                          >
                            <RiInformationLine size={14} />
                          </Button>
                          <Tooltip style={{ maxWidth: 400 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.5 }}>
                              {request.firstTimestamp && request.lastTimestamp && (
                                <div>
                                  <span style={{ fontWeight: 700 }}>Log period: </span>
                                  {formatTimestamp(request.firstTimestamp)} ~ {formatTimestamp(request.lastTimestamp)}
                                </div>
                              )}
                              {request.archivePath && (
                                <div>
                                  <span style={{ fontWeight: 700 }}>Archive location: </span>
                                  <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                                    {request.archivePath}
                                  </span>
                                </div>
                              )}
                            </div>
                          </Tooltip>
                        </TooltipTrigger>
                      </Flex>
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
                    <div>
                      <Text variant="body-x-small" color="secondary" style={{ display: 'block' }}>
                        Created {formatDate(request.createdAt)}
                      </Text>
                      {request.reviewerRef && (
                        <Text variant="body-x-small" color="secondary" style={{ display: 'block', marginTop: 2 }}>
                          Reviewed {formatDate(request.updatedAt)}
                        </Text>
                      )}
                    </div>
                    <span className={getStatusClassName(request.status)}>
                      {request.status}
                      {getStatusIcon(request.status)}
                    </span>
                  </div>

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

                </CardBody>
              </Card>
            </div>
          ))}
        </div>
        )}
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

export const S3LogExtractPage = () => {
  const api = useApi(s3LogExtractApiRef);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<'list' | 'create'>('list');

  const { value: s3Config } = useAsyncRetry(async () => {
    return api.getConfig();
  }, []);

  const { value: s3Health } = useAsyncRetry(async () => {
    return api.getS3Health();
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const health = await api.getS3Health();
        setS3HealthState(health);
      } catch {
        // ignore
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [api]);

  const [s3HealthState, setS3HealthState] = useState<{
    connected: boolean;
    checkedAt: string;
    error?: string;
  } | null>(null);

  const currentHealth = s3HealthState ?? s3Health ?? null;
  const isConnected = currentHealth?.connected ?? false;

  const handleSubmitted = () => {
    setRefreshKey(k => k + 1);
    setView('list');
  };

  return (
    <>
      <PluginHeader title="S3 Log Extract" />
      <Container my="4">
        <Flex justify="between" align="center" mb="4">
          <Text variant="body-small" color="secondary">
            No more digging through S3 buckets at 3 AM. Request, approve, download.
          </Text>
          <Flex align="center" gap="3" style={{ flexShrink: 0 }}>
            <TooltipTrigger delay={200}>
              <Button
                variant="tertiary"
                size="small"
                className={`sle-integration-badge ${isConnected ? 'sle-integration-connected' : 'sle-integration-disconnected'}`}
              >
                S3 API {isConnected ? 'Connected' : 'Disconnected'}
              </Button>
              <Tooltip style={{ maxWidth: 280 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 700 }}>Amazon S3 Integration</div>
                  <div>Status: {isConnected ? 'Connected' : 'Disconnected'}</div>
                  <div>Usage: Extracts Java application logs from S3 buckets</div>
                  {currentHealth && (
                    <div style={{ opacity: 0.7 }}>
                      Last checked: {new Date(currentHealth.checkedAt).toLocaleString()}
                    </div>
                  )}
                  {currentHealth?.error && (
                    <div style={{ opacity: 0.7 }}>
                      Error: {currentHealth.error}
                    </div>
                  )}
                </div>
              </Tooltip>
            </TooltipTrigger>
            {view === 'list' ? (
              <Button variant="primary" isDisabled={!isConnected} onPress={() => setView('create')}>
                <Flex align="center" gap="1">
                  <RiAddLine size={16} />
                  New Request
                </Flex>
              </Button>
            ) : (
              <Button variant="secondary" onPress={() => setView('list')}>
                <Flex align="center" gap="1">
                  <RiArrowLeftLine size={16} />
                  Back to Requests
                </Flex>
              </Button>
            )}
          </Flex>
        </Flex>

        {view === 'list' ? (
          <RequestList refreshKey={refreshKey} />
        ) : (
          <Card>
            <CardBody>
              <Text as="h3" variant="body-large" weight="bold">
                New Log Extract Request
              </Text>
              {s3Config && s3Config.bucket && (
                <Text
                  variant="body-x-small"
                  color="secondary"
                  style={{ marginTop: 8, display: 'block' }}
                >
                  Bucket: <strong>{s3Config.bucket}</strong> &middot; Region:{' '}
                  <strong>{s3Config.region}</strong>
                  {s3Config.prefix ? (
                    <>
                      {' '}
                      &middot; Prefix: <strong>{s3Config.prefix}</strong>
                    </>
                  ) : null}
                </Text>
              )}
              <RequestForm
                onSubmitted={handleSubmitted}
                maxTimeRangeMinutes={s3Config?.maxTimeRangeMinutes ?? 60}
              />
            </CardBody>
          </Card>
        )}
      </Container>
    </>
  );
};
