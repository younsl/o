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
  Tag,
  TagGroup,
  Text,
  TextField,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import { RiFileSearchLine } from '@remixicon/react';
import {
  Button as AriaButton,
  Calendar,
  CalendarCell,
  CalendarGrid,
  DateInput,
  DatePicker,
  DateSegment,
  DateValue,
  Dialog,
  Group,
  Heading,
  I18nProvider,
  Label,
  Popover,
} from 'react-aria-components';
import { parseDate } from '@internationalized/date';
import { s3LogExtractPlugin } from '../../plugin';
import { useApi, identityApiRef } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { s3LogExtractApiRef } from '../../api';
import { Environment, LogExtractRequest, RequestStatus } from '../../api/types';
import { PrecheckResult, S3Config } from '../../api/S3LogExtractApi';
import {
  RiAddLine,
  RiArrowLeftLine,
  RiCalendarLine,
  RiCheckLine,
  RiCloseLine,
  RiDownloadLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFileCopyLine,
  RiInformationLine,
  RiLoader4Line,
  RiLockPasswordLine,
  RiShieldCheckLine,
  RiTimeLine,
} from '@remixicon/react';
import './S3LogExtractPage.css';

const isInvalidDate = (v: string) => v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v);
const isInvalidTime = (v: string) => v !== '' && !/^(\d{1,4}|\d{2}:\d{2})$/.test(v);

const useNow = (intervalMs: number = 30_000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
};

const CopyButton = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false);
  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may be unavailable in non-secure contexts
    }
  };
  return (
    <button
      type="button"
      className="sle-copy-btn"
      onClick={handleClick}
      aria-label="Copy to clipboard"
      title={copied ? 'Copied' : 'Copy'}
    >
      {copied ? <RiCheckLine size={12} /> : <RiFileCopyLine size={12} />}
    </button>
  );
};

const buildS3Uris = (
  request: LogExtractRequest,
  s3Config: S3Config | undefined,
): string[] => {
  if (!s3Config?.bucket || !/^\d{4}-\d{2}-\d{2}$/.test(request.date)) return [];
  const [yyyy, mm, dd] = request.date.split('-');
  const prefix = s3Config.prefix ? `${s3Config.prefix.replace(/\/+$/, '')}/` : '';
  return request.apps.map(app => {
    if (request.source === 'k8s') {
      return `s3://${s3Config.bucket}/${prefix}k8s/${request.env}.${app}/${yyyy}/${mm}/${dd}/`;
    }
    return `s3://${s3Config.bucket}/${prefix}ec2/${yyyy}/${mm}/${dd}/${request.env}.${app}/logs/java/`;
  });
};

const formatSize = (bytes: number | null): string => {
  if (bytes === null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatLocal = (iso: string): string => new Date(iso).toLocaleString();

const formatTimestampKst = (iso: string): string =>
  new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

const formatRemaining = (deadlineMs: number, nowMs: number): string => {
  const diff = deadlineMs - nowMs;
  if (diff <= 0) return 'Expired';
  const totalMinutes = Math.floor(diff / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 1) return `${hours}h ${minutes}m left`;
  if (minutes >= 1) return `${minutes}m left`;
  return '<1m left';
};

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

// Human-readable label for a stored encryption method value. Single source of
// truth so the label is never hardcoded at each display site.
const encryptionLabel = (method: string): string =>
  method === 'aes256' ? 'AES-256' : method.toUpperCase();

// Only AES-256 is offered: legacy ZipCrypto is trivially crackable and would
// defeat the leak-protection goal of the encrypted archive.
const encryptionOptions = [{ value: 'aes256', label: encryptionLabel('aes256') }];

interface ReviewDialogProps {
  request: LogExtractRequest;
  s3Config: S3Config | undefined;
  /** True while any request is extracting — new approvals queue behind it. */
  extractionBusy: boolean;
  open: boolean;
  onClose: () => void;
  onReviewed: () => void;
}

const ReviewDialog = ({
  request,
  s3Config,
  extractionBusy,
  open,
  onClose,
  onReviewed,
}: ReviewDialogProps) => {
  const api = useApi(s3LogExtractApiRef);
  const [action, setAction] = useState<'approve' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-check availability at review time (fresher than the request-time
  // check, since batched logs may have arrived since submission).
  const [precheck, setPrecheck] = useState<PrecheckResult | null>(null);
  const [precheckLoading, setPrecheckLoading] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setPrecheckLoading(true);
    api
      .precheck({
        source: request.source,
        env: request.env,
        date: request.date,
        apps: request.apps,
        startTime: request.startTime,
        endTime: request.endTime,
      })
      .then(result => {
        if (!cancelled) setPrecheck(result);
      })
      .catch(() => {
        if (!cancelled) setPrecheck(null);
      })
      .finally(() => {
        if (!cancelled) setPrecheckLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, open, request]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!action) {
      setError('Select an action');
      return;
    }
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
      setAction(null);
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

  const submitLabel = submitting ? 'Submitting...' : 'Submit';

  return (
    <div className="sle-overlay" onClick={onClose}>
      <div className="sle-dialog" onClick={e => e.stopPropagation()}>
        <Text as="h3" variant="body-large" weight="bold">
          Review Log Extract Request
        </Text>
        <Box mt="3">
          <Text as="p" variant="body-small" color="secondary">
            <strong>Environment:</strong> {request.env} |{' '}
            <strong>Date:</strong> {request.date}
          </Text>
          <Text as="p" variant="body-small" color="secondary">
            <strong>Time:</strong> {request.startTime} - {request.endTime} (KST)
          </Text>
          <Text as="p" variant="body-small" color="secondary">
            <strong>Apps:</strong> {request.apps.join(', ')}
          </Text>
          <Text as="p" variant="body-small" color="secondary">
            <strong>Requester:</strong> {request.requesterRef}
          </Text>
          <Text as="p" variant="body-small" color="secondary">
            <strong>Reason:</strong> {request.reason}
          </Text>
          <Text as="p" variant="body-small" color="secondary">
            <strong>Encryption:</strong>{' '}
            {encryptionLabel(request.encryption)}
          </Text>
          {buildS3Uris(request, s3Config).map(uri => (
            <Text key={uri} as="p" variant="body-small" color="secondary">
              <strong>S3 URI:</strong> {uri} <CopyButton value={uri} />
            </Text>
          ))}
          <Text as="p" variant="body-small" color="secondary">
            <strong>Log availability:</strong>{' '}
            {precheckLoading ? (
              'checking...'
            ) : precheck ? (
              precheck.candidateCount === 0 ? (
                <Text as="span" variant="body-small" color="danger">
                  No matching objects (extraction would return 0 files)
                </Text>
              ) : (
                `${precheck.candidateCount} candidate objects` +
                (request.apps.length > 1
                  ? ` (${request.apps
                      .map(app => `${app}: ${precheck.appCounts[app] ?? 0}`)
                      .join(', ')})`
                  : '')
              )
            ) : (
              'unavailable'
            )}
          </Text>
        </Box>

        {extractionBusy && (
          <Box mt="3">
            <div className="sle-busy-banner">
              <RiLoader4Line size={14} className="sle-spin" />
              Another extraction is currently running. If approved, this
              request is queued and starts automatically when the current one
              finishes.
            </div>
          </Box>
        )}

        <Box mt="3">
          <Text variant="body-small" weight="bold" style={{ display: 'block', marginBottom: 6 }}>
            Action{' '}
            <Text as="span" variant="body-small" color="danger">
              *
            </Text>
          </Text>
          <Flex gap="2">
            <button
              type="button"
              className={`sle-action-toggle ${action === 'approve' ? 'sle-action-toggle--approve' : ''}`}
              onClick={() => setAction('approve')}
              disabled={submitting}
            >
              <RiCheckLine size={14} />
              Approve
            </button>
            <button
              type="button"
              className={`sle-action-toggle ${action === 'reject' ? 'sle-action-toggle--reject' : ''}`}
              onClick={() => setAction('reject')}
              disabled={submitting}
            >
              <RiCloseLine size={14} />
              Reject
            </button>
          </Flex>
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
                action === 'reject'
                  ? 'Reason for rejection'
                  : action === 'approve'
                    ? 'Reason for approval'
                    : 'Select an action above'
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
            variant="primary"
            onPress={handleSubmit}
            isDisabled={submitting || !action || !comment.trim()}
          >
            {submitLabel}
          </Button>
        </Flex>
      </div>
    </div>
  );
};

interface DownloadModalProps {
  request: LogExtractRequest;
  fileName: string;
  onClose: () => void;
}

// Download gate + one-time archive password modal (IAM secret key style).
// Opening the modal reveals the password once (if not already revealed); the
// actual file download only happens when the user presses Download here.
const DownloadModal = ({
  request,
  fileName,
  onClose,
}: DownloadModalProps) => {
  const api = useApi(s3LogExtractApiRef);
  const [visible, setVisible] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  // Was the password already revealed before this modal opened (or lost the
  // reveal race)? Then it can never be shown again.
  const [alreadyRevealed, setAlreadyRevealed] = useState(
    !request.passwordAvailable,
  );
  const [revealing, setRevealing] = useState(request.passwordAvailable);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealStarted = useRef(false);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  // Reveal once on open. The password is destroyed server-side after this, so
  // subsequent opens (by anyone) land in the already-revealed branch. Deps are
  // kept stable so a list refresh can't unmount this modal and re-fire reveal.
  useEffect(() => {
    if (!request.passwordAvailable || revealStarted.current) return;
    revealStarted.current = true;
    let cancelled = false;
    api
      .revealPassword(request.id)
      .then(({ password: pw }) => {
        if (cancelled) return;
        setPassword(pw);
      })
      .catch(err => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already revealed')) {
          setAlreadyRevealed(true);
        } else {
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setRevealing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, request.id, request.passwordAvailable]);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const blobUrl = await api.downloadUrl(request.id);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="sle-overlay" onClick={onClose}>
      <div className="sle-dialog" onClick={e => e.stopPropagation()}>
        <Flex align="center" gap="2">
          <RiLockPasswordLine size={18} />
          <Text as="h3" variant="body-large" weight="bold">
            Download Encrypted Archive
          </Text>
        </Flex>

        <Box mt="3">
          <Text
            variant="body-medium"
            weight="bold"
            style={{ display: 'block', marginBottom: 4 }}
          >
            File
          </Text>
          <Text variant="body-small" className="sle-request-id">
            {fileName}
          </Text>
        </Box>

        <Box mt="3">
          <Text
            variant="body-medium"
            weight="bold"
            style={{ display: 'block', marginBottom: 6 }}
          >
            Log metadata
          </Text>
          <div className="sle-meta-grid">
            <Text variant="body-x-small" color="secondary">
              Files
            </Text>
            <Text variant="body-small">{request.fileCount ?? 0}</Text>

            <Text variant="body-x-small" color="secondary">
              Size
            </Text>
            <Text variant="body-small">{formatSize(request.archiveSize)}</Text>

            <Text variant="body-x-small" color="secondary">
              Encryption
            </Text>
            <Flex align="center" gap="1">
              <span
                className="sle-encrypted-badge"
                title={`${encryptionLabel(request.encryption)} encrypted`}
              >
                <RiShieldCheckLine size={14} />
              </span>
              <Text variant="body-small">
                {encryptionLabel(request.encryption)}
              </Text>
            </Flex>

            {request.firstTimestamp && request.lastTimestamp && (
              <>
                <Text variant="body-x-small" color="secondary">
                  Log period
                </Text>
                <Text variant="body-small">
                  {formatTimestampKst(request.firstTimestamp)} ~{' '}
                  {formatTimestampKst(request.lastTimestamp)} (KST)
                </Text>
              </>
            )}
          </div>
        </Box>

        <Box mt="3">
          <Text
            variant="body-medium"
            weight="bold"
            style={{ display: 'block', marginBottom: 4 }}
          >
            Password
          </Text>
          {revealing ? (
            <Flex align="center" gap="1">
              <RiLoader4Line size={14} className="sle-spin" />
              <Text variant="body-small" color="secondary">
                Revealing password...
              </Text>
            </Flex>
          ) : password ? (
            <>
              <Box mb="2">
                <Alert
                  status="warning"
                  title="This password is shown only once. It cannot be recovered after you close this dialog, so copy it now."
                />
              </Box>
              <Flex align="center" gap="2">
                <code className="sle-password-field">
                  {visible ? password : '•'.repeat(password.length)}
                </code>
                <button
                  type="button"
                  className="sle-password-toggle"
                  onClick={() => setVisible(v => !v)}
                  aria-label={visible ? 'Hide password' : 'Show password'}
                  title={visible ? 'Hide' : 'Show'}
                >
                  {visible ? (
                    <RiEyeOffLine size={14} />
                  ) : (
                    <RiEyeLine size={14} />
                  )}
                  {visible ? 'Hide' : 'Show'}
                </button>
                <CopyButton value={password} />
              </Flex>
            </>
          ) : (
            <Alert
              status="warning"
              className="sle-alert-compact"
              title={
                request.passwordRevealedTo
                  ? `Password was already revealed to ${request.passwordRevealedTo}${
                      request.passwordRevealedAt
                        ? ` at ${formatLocal(request.passwordRevealedAt)}`
                        : ''
                    }. It cannot be shown again, so ask them for it, or submit a new request to get a fresh one.`
                  : 'Password was already revealed and cannot be shown again, so ask whoever downloaded it first, or submit a new request to get a fresh one.'
              }
            />
          )}
        </Box>

        <Box mt="3">
          <Text
            variant="body-medium"
            weight="bold"
            style={{ display: 'block', marginBottom: 4 }}
          >
            How to extract
          </Text>
          <Text
            variant="body-x-small"
            color="secondary"
            style={{ display: 'block', marginBottom: 4, opacity: 0.8 }}
          >
            The logs are encrypted with{' '}
            {encryptionLabel(request.encryption)},
            so you must decompress the archive separately to read them. Use an
            AES-capable tool such as 7-Zip, Keka, or p7zip (7z recommended);
            macOS Finder cannot open it.
          </Text>
          <div className="sle-codecard">
            <div className="sle-codecard-header">
              <span className="sle-codecard-tab">macOS</span>
              <CopyButton value={`brew install p7zip\n7z x ${fileName}`} />
            </div>
            <pre className="sle-codecard-body">
              {`brew install p7zip\n7z x ${fileName}`}
            </pre>
          </div>
        </Box>

        {error && (
          <Box mt="2">
            <Text variant="body-small" color="danger">
              {error}
            </Text>
          </Box>
        )}

        <Flex gap="2" justify="end" mt="4">
          <Button variant="secondary" onPress={onClose} isDisabled={downloading}>
            Close
          </Button>
          <Button
            variant="primary"
            onPress={handleDownload}
            isDisabled={revealing || downloading}
          >
            <Flex align="center" gap="1">
              <RiDownloadLine size={14} />
              {downloading ? 'Downloading...' : 'Download'}
            </Flex>
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
  const [encryption, setEncryption] = useState('aes256');
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

  // Syntax-highlight the dots in app names (e.g. env.app separators) so the
  // segments read like tokens.
  const styleDots = (text: string) =>
    text.split('.').flatMap((part, i) =>
      i === 0
        ? [part]
        : [
            <span key={`dot-${i}`} className="sle-app-dot">
              .
            </span>,
            part,
          ],
    );

  const highlightMatch = (text: string, query: string) => {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return styleDots(text);
    return (
      <>
        {styleDots(text.slice(0, idx))}
        <mark className="sle-highlight">
          {styleDots(text.slice(idx, idx + query.length))}
        </mark>
        {styleDots(text.slice(idx + query.length))}
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
        encryption,
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

  // Advisory availability pre-check (List-only on the backend). Runs once all
  // fields are filled; zero candidates warns but does not block submission,
  // since logs can still arrive later due to batch upload delays.
  const [precheckResult, setPrecheckResult] = useState<PrecheckResult | null>(
    null,
  );
  const [precheckLoading, setPrecheckLoading] = useState(false);
  const precheckDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (precheckDebounceRef.current) clearTimeout(precheckDebounceRef.current);
    setPrecheckResult(null);

    const timeOk = (t: string) => /^\d{2}:\d{2}$/.test(t);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      selectedApps.length === 0 ||
      !timeOk(startTime) ||
      !timeOk(endTime) ||
      timeRangeError
    ) {
      setPrecheckLoading(false);
      return undefined;
    }

    setPrecheckLoading(true);
    precheckDebounceRef.current = setTimeout(async () => {
      try {
        const result = await api.precheck({
          source,
          env,
          date,
          apps: selectedApps,
          startTime,
          endTime,
        });
        setPrecheckResult(result);
      } catch {
        // Advisory only; stay silent when the check itself fails
        setPrecheckResult(null);
      } finally {
        setPrecheckLoading(false);
      }
    }, 800);
    return () => {
      if (precheckDebounceRef.current) {
        clearTimeout(precheckDebounceRef.current);
      }
    };
  }, [api, source, env, date, selectedApps, startTime, endTime, timeRangeError]);

  // Apps with zero candidate objects in the window (per-app breakdown).
  const emptyApps = useMemo(() => {
    if (!precheckResult) return [];
    return selectedApps.filter(app => (precheckResult.appCounts[app] ?? 0) === 0);
  }, [precheckResult, selectedApps]);

  const isValid =
    env &&
    encryption &&
    date &&
    selectedApps.length > 0 &&
    startTime &&
    endTime &&
    reason.trim() &&
    !timeRangeError &&
    // Hard block: no logs in the window means the extraction would be empty.
    // Fail open when the pre-check itself errored (precheckResult null).
    !precheckLoading &&
    (precheckResult === null || precheckResult.candidateCount > 0);

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
            <I18nProvider locale="ko-KR">
              <DatePicker
                className="sle-datepicker"
                value={
                  /^\d{4}-\d{2}-\d{2}$/.test(date)
                    ? (parseDate(date) as unknown as DateValue)
                    : null
                }
                onChange={(v: DateValue | null) =>
                  setDate(v ? v.toString() : '')
                }
                isInvalid={isInvalidDate(date)}
              >
                <Label className="sle-datepicker-label">Date (KST)</Label>
                <Group className="sle-datepicker-group">
                  <DateInput className="sle-datepicker-input">
                    {segment =>
                      segment.type === 'literal' ? (
                        <span
                          aria-hidden
                          className="sle-datepicker-separator"
                        >
                          -
                        </span>
                      ) : (
                        <DateSegment
                          segment={segment}
                          className="sle-datepicker-segment"
                        >
                          {({ text, isPlaceholder, value }) => {
                            if (isPlaceholder) {
                              if (segment.type === 'year') return 'YYYY';
                              if (segment.type === 'month') return 'MM';
                              if (segment.type === 'day') return 'DD';
                              return text;
                            }
                            if (
                              (segment.type === 'month' ||
                                segment.type === 'day') &&
                              typeof value === 'number'
                            ) {
                              return String(value).padStart(2, '0');
                            }
                            return text;
                          }}
                        </DateSegment>
                      )
                    }
                  </DateInput>
                  <AriaButton
                    className="sle-datepicker-trigger"
                    aria-label="Open calendar"
                  >
                    <RiCalendarLine size={16} />
                  </AriaButton>
                </Group>
                <Popover className="sle-datepicker-popover">
                  <Dialog className="sle-datepicker-dialog">
                    <Calendar className="sle-calendar">
                      <header className="sle-calendar-header">
                        <AriaButton
                          slot="previous"
                          className="sle-calendar-nav"
                        >
                          ‹
                        </AriaButton>
                        <Heading className="sle-calendar-heading" />
                        <AriaButton slot="next" className="sle-calendar-nav">
                          ›
                        </AriaButton>
                      </header>
                      <CalendarGrid className="sle-calendar-grid">
                        {d => {
                          const dow = new Date(
                            d.year,
                            d.month - 1,
                            d.day,
                          ).getDay();
                          const extra =
                            dow === 0
                              ? ' sle-calendar-cell--sunday'
                              : dow === 6
                                ? ' sle-calendar-cell--saturday'
                                : '';
                          return (
                            <CalendarCell
                              date={d}
                              className={`sle-calendar-cell${extra}`}
                            />
                          );
                        }}
                      </CalendarGrid>
                    </Calendar>
                  </Dialog>
                </Popover>
              </DatePicker>
            </I18nProvider>
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
                          : styleDots(app)}
                      </span>
                    </button>
                  ))}
              </div>
            </>
          )}
        </Box>

        <Box>
          <div className="sle-required-field" style={{ maxWidth: 240 }}>
            <Select
              label="Encryption"
              options={encryptionOptions}
              selectedKey={encryption}
              onSelectionChange={key => setEncryption(key as string)}
            />
          </div>
          <Text
            variant="body-x-small"
            color="secondary"
            style={{ display: 'block', marginTop: 4 }}
          >
            AES-256: the archive is a password-protected zip. Extraction
            requires an AES-capable tool such as 7-Zip, Keka, or p7zip (7z x);
            macOS Finder cannot open it.
          </Text>
        </Box>

        {precheckLoading ? (
          <Text variant="body-x-small" color="secondary">
            Checking log availability...
          </Text>
        ) : precheckResult ? (
          precheckResult.candidateCount === 0 ? (
            <Alert
              status="danger"
              title="No logs found for this range. Adjust the date, time range, or apps. Logs may arrive later due to batch upload delays."
            />
          ) : emptyApps.length > 0 ? (
            <Alert
              status="warning"
              title={`No logs in this range for: ${emptyApps.join(', ')}. These apps would contribute nothing to the archive.`}
            />
          ) : (
            <Text variant="body-x-small" color="secondary">
              ~{precheckResult.candidateCount} log objects found in this range
            </Text>
          )
        ) : null}

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
  s3Config,
}: {
  refreshKey: number;
  s3Config: S3Config | undefined;
}) => {
  const api = useApi(s3LogExtractApiRef);
  const identityApi = useApi(identityApiRef);
  const now = useNow(30_000);

  const {
    value: requests,
    loading,
    error: loadError,
    retry,
  } = useAsyncRetry(async () => {
    return api.listRequests();
  }, [refreshKey]);

  const hasExtracting = (requests ?? []).some(r => r.status === 'extracting');
  // 'approved' means queued: waiting for the extraction worker to pick it up.
  const hasQueued = (requests ?? []).some(r => r.status === 'approved');

  useEffect(() => {
    // Poll faster while an extraction is running or queued so the progress
    // counter, elapsed time, and queue transitions stay current.
    const id = setInterval(
      () => retry(),
      hasExtracting || hasQueued ? 3_000 : 30_000,
    );
    return () => clearInterval(id);
  }, [retry, hasExtracting, hasQueued]);

  const { value: adminStatus } = useAsyncRetry(async () => {
    return api.getAdminStatus();
  }, []);

  const { value: currentUserRef } = useAsyncRetry(async () => {
    const identity = await identityApi.getBackstageIdentity();
    return identity.userEntityRef;
  }, []);

  const [reviewTarget, setReviewTarget] = useState<LogExtractRequest | null>(
    null,
  );

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

  const [downloadModal, setDownloadModal] = useState<{
    request: LogExtractRequest;
    fileName: string;
  } | null>(null);

  // Clicking Download always opens the modal; the password reveal and the
  // actual file download both happen inside it.
  const openDownload = (request: LogExtractRequest) => {
    setDownloadModal({
      request,
      fileName: `backstage-s3logs-${request.env}-${request.date}.zip`,
    });
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

  const formatDuration = (ms: number | null) => {
    if (ms === null || ms < 0) return '-';
    const totalSeconds = Math.round(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const parts: string[] = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  };

  // Skeleton only on initial load; background refetches keep the tree (and any
  // open modal) mounted since useAsyncRetry retains the previous value.
  if (loading && !requests) {
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
                      <span
                        className={
                          !request.downloadable || request.fileCount === 0
                            ? 'sle-btn-expired'
                            : ''
                        }
                      >
                        <Button
                          variant="secondary"
                          size="small"
                          isDisabled={
                            !request.downloadable || request.fileCount === 0
                          }
                          onPress={() => openDownload(request)}
                        >
                          <Flex align="center" gap="1">
                            <span
                              className="sle-encrypted-badge"
                              title={`${encryptionLabel(request.encryption)} encrypted`}
                            >
                              <RiShieldCheckLine size={14} />
                            </span>
                            {request.fileCount === 0
                              ? 'No logs'
                              : request.downloadable
                                ? 'Download'
                                : 'Expired'}
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
                        {request.extractionDurationMs !== null && (
                          <Text variant="body-small" color="secondary">
                            &middot; took {formatDuration(request.extractionDurationMs)}
                          </Text>
                        )}
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
                              {request.extractionDurationMs !== null && (
                                <div>
                                  <span style={{ fontWeight: 700 }}>Duration: </span>
                                  {formatDuration(request.extractionDurationMs)}
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
                      {request.fileCount === 0 ? (
                        <Text
                          variant="body-x-small"
                          color="danger"
                          style={{ display: 'block', marginTop: 4 }}
                        >
                          No logs matched the requested time range
                        </Text>
                      ) : request.passwordAvailable ? (
                        <Text
                          variant="body-x-small"
                          color="secondary"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            marginTop: 4,
                          }}
                        >
                          <RiLockPasswordLine size={12} style={{ flexShrink: 0 }} />
                          Encrypted zip, password shown once on first download
                        </Text>
                      ) : null}
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
                      {request.status === 'pending' && request.approvalDeadline && (
                        <Text variant="body-x-small" color="secondary" style={{ display: 'block', marginTop: 2 }}>
                          Auto-reject {formatDate(request.approvalDeadline)}
                        </Text>
                      )}
                    </div>
                    <span className={getStatusClassName(request.status)}>
                      {request.status}
                      {request.status === 'approved' && ' (queued)'}
                      {request.status === 'extracting' &&
                        request.progressTotal != null &&
                        request.progressTotal > 0 &&
                        ` (${request.progressCurrent ?? 0}/${request.progressTotal})`}
                      {getStatusIcon(request.status)}
                    </span>
                  </div>

                  {isAdmin && request.status === 'pending' && (
                    <Flex gap="2" mt="2" className="sle-card-actions">
                      <Button
                        variant="primary"
                        size="small"
                        onPress={() => setReviewTarget(request)}
                      >
                        <Flex align="center" gap="1">
                          Review
                          {request.approvalDeadline && (
                            <span className="sle-review-btn-remaining">
                              ·{' '}
                              {formatRemaining(
                                new Date(request.approvalDeadline).getTime(),
                                now,
                              )}
                            </span>
                          )}
                        </Flex>
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

      {downloadModal && (
        <DownloadModal
          request={downloadModal.request}
          fileName={downloadModal.fileName}
          onClose={() => {
            setDownloadModal(null);
            // Refresh on close so the row reflects the consumed one-time password.
            retry();
          }}
        />
      )}

      {reviewTarget && (
        <ReviewDialog
          request={reviewTarget}
          s3Config={s3Config}
          extractionBusy={hasExtracting}
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
      <PluginHeader
        icon={<RiFileSearchLine />}
        title="S3 Log Extract"
        customActions={
          <TagGroup>
            <Tag id="plugin-id" size="small">{s3LogExtractPlugin.getId()}</Tag>
          </TagGroup>
        }
      />
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
          <RequestList refreshKey={refreshKey} s3Config={s3Config} />
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
