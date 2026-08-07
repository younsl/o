import React, {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useApi } from '@backstage/core-plugin-api';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAsync, useAsyncRetry } from 'react-use';
import {
  OpenSearchNav,
  opensearchAccountApiRef,
} from '@internal/plugin-opensearch-account';
import {
  Alert,
  Button,
  Container,
  Flex,
  PluginHeader,
  SearchField,
  Skeleton,
  Tag,
  TagGroup,
  Text,
} from '@backstage/ui';
import {
  RiCheckLine,
  RiCloseLine,
  RiDatabase2Line,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiRefreshLine,
} from '@remixicon/react';
import { opensearchViewerPlugin } from '../../plugin';
import { opensearchViewerApiRef } from '../../api';
import {
  ConflictSeverity,
  ConflictTypeGroup,
  FieldConflict,
  OpenSearchConflictSnapshot,
} from '../../api/types';
import './opensearch-viewer.css';

type SortKey =
  | 'severity'
  | 'field'
  | 'types'
  | 'indexGroups'
  | 'indices'
  | 'docs'
  | 'cause';
type SortDir = 'asc' | 'desc';
type SeverityFilter = 'all' | ConflictSeverity;

const severityRank: Record<ConflictSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const formatNumber = (value: number | null | undefined): string =>
  typeof value === 'number' ? value.toLocaleString() : '-';

const formatCompactNumber = (value: number | null | undefined): string => {
  if (typeof value !== 'number') return '-';
  const abs = Math.abs(value);
  if (abs < 1_000) return value.toLocaleString();
  if (abs < 1_000_000) {
    const scaled = value / 1_000;
    return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)}k`;
  }
  const scaled = value / 1_000_000;
  return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)}m`;
};

const formatDate = (value: string | null): string =>
  value ? new Date(value).toLocaleString() : '-';

const parseDeepLink = (search: string) => {
  const params = new URLSearchParams(search);
  return {
    targetId: params.get('target'),
    field: params.get('field'),
  };
};

const formatDuration = (value: number | null | undefined): string => {
  if (typeof value !== 'number') return '-';
  if (value < 1_000) return `${Math.max(value, 0)} ms`;

  const seconds = value / 1_000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} sec`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes} min ${remainingSeconds} sec`
      : `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${hours} hr ${remainingMinutes} min`
    : `${hours} hr`;
};

const statusLabel = (snapshot: OpenSearchConflictSnapshot): string => {
  if (snapshot.status === 'never_scanned') return 'Never scanned';
  if (snapshot.status === 'failed') return 'Scan failed';
  return 'Current';
};

const typeClass = (type: string) => type.replace(/[^a-z0-9]/gi, '-');

const TypePill = ({ type }: { type: string }) => (
  <span className={`osv-type osv-type-${typeClass(type)}`}>
    {type}
  </span>
);

const severityDescription: Record<ConflictSeverity, string> = {
  high: 'High: 3+ mapped types, 50+ affected indices, or 1m+ affected docs.',
  medium: 'Medium: 10+ affected indices or 100k+ affected docs.',
  low: 'Low: below medium thresholds; still verify mapping drift before rollout.',
};

const SeverityBadge = ({ severity }: { severity: ConflictSeverity }) => {
  const badgeRef = useRef<HTMLSpanElement>(null);
  const [tooltipLayout, setTooltipLayout] = useState({
    left: 16,
    maxWidth: 280,
    placement: 'bottom' as 'bottom' | 'top',
    top: 0,
  });
  const [tooltipOpen, setTooltipOpen] = useState(false);

  const updateTooltipLayout = useCallback(() => {
    if (!badgeRef.current || typeof window === 'undefined') return;

    const rect = badgeRef.current.getBoundingClientRect();
    const margin = 16;
    const gap = 7;
    const tooltipWidth = Math.min(280, Math.max(180, window.innerWidth - margin * 2));
    const placeTop = rect.bottom + 96 > window.innerHeight && rect.top > 110;
    setTooltipLayout({
      left: Math.min(
        Math.max(rect.left, margin),
        window.innerWidth - tooltipWidth - margin,
      ),
      maxWidth: tooltipWidth,
      placement: placeTop ? 'top' : 'bottom',
      top: placeTop ? rect.top - gap : rect.bottom + gap,
    });
  }, []);

  const openTooltip = () => {
    updateTooltipLayout();
    setTooltipOpen(true);
  };

  const tooltip =
    tooltipOpen && typeof document !== 'undefined'
      ? createPortal(
          <span
            className={`osv-severity-tooltip osv-severity-tip-${tooltipLayout.placement}`}
            role="tooltip"
            style={
              {
                '--osv-severity-tooltip-left': `${tooltipLayout.left}px`,
                '--osv-severity-tooltip-max-width': `${tooltipLayout.maxWidth}px`,
                '--osv-severity-tooltip-top': `${tooltipLayout.top}px`,
              } as React.CSSProperties
            }
          >
            {severityDescription[severity]}
          </span>,
          document.body,
        )
      : null;

  return (
    <Fragment>
      <span
        ref={badgeRef}
        className={`osv-severity osv-severity-${severity}`}
        tabIndex={0}
        aria-label={`${severity} severity`}
        onBlur={() => setTooltipOpen(false)}
        onFocus={openTooltip}
        onMouseEnter={openTooltip}
        onMouseLeave={() => setTooltipOpen(false)}
      >
        <span className="osv-severity-dot" />
        {severity}
      </span>
      {tooltip}
    </Fragment>
  );
};

const Metric = ({
  action,
  detail,
  label,
  value,
  tone,
  valueTitle,
}: {
  action?: React.ReactNode;
  detail?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: 'danger' | 'warning' | 'success';
  valueTitle?: string;
}) => (
  <div
    className={`osv-metric ${tone ? `osv-metric-${tone}` : ''} ${
      action ? 'osv-metric-with-action' : ''
    }`}
  >
    <div className="osv-metric-content">
      <span className="osv-metric-label">{label}</span>
      <span className="osv-metric-value" title={valueTitle}>
        {value}
      </span>
      {detail && <span className="osv-metric-detail">{detail}</span>}
    </div>
    {action && <div className="osv-metric-action">{action}</div>}
  </div>
);

const groupByImpact = (groups: ConflictTypeGroup[]) =>
  groups
    .slice()
    .sort((a, b) => {
      const docsA = a.documentCount ?? -1;
      const docsB = b.documentCount ?? -1;
      if (docsA !== docsB) return docsB - docsA;
      return b.indexCount - a.indexCount;
    });

const indexFamily = (index: string): string =>
  index
    .replace(/[-_.]?\d{4}[-_.]\d{2}[-_.]\d{2}$/, '-*')
    .replace(/[-_.]?\d{4}[-_.]\d{2}$/, '-*')
    .replace(/[-_.]?\d{6,}$/, '-*')
    .replace(/[-_.]?\d{5,6}$/, '-*');

const groupIndicesByFamily = (indices: string[]) => {
  const families = new Map<string, string[]>();
  for (const index of indices) {
    const family = indexFamily(index);
    families.set(family, [...(families.get(family) ?? []), index]);
  }
  return Array.from(families.entries())
    .map(([family, familyIndices]) => ({
      family,
      indices: familyIndices.sort((a, b) => a.localeCompare(b)),
      count: familyIndices.length,
    }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.family.localeCompare(b.family);
    });
};

const conflictIndexGroupCount = (conflict: FieldConflict): number =>
  groupIndicesByFamily(conflict.groups.flatMap(group => group.indices)).length;

const formatQuery = (
  target: OpenSearchConflictSnapshot['target'],
  conflict: FieldConflict,
) =>
  `GET /${target.indexPattern}/_field_caps?fields=${conflict.field}&include_unmapped=false`;

const copyText = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', 'true');
    textArea.style.position = 'fixed';
    textArea.style.top = '-1000px';
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
  }
};

const TypeDistributionBar = ({
  groups,
  dense = false,
  active = false,
  onToggle,
}: {
  groups: ConflictTypeGroup[];
  dense?: boolean;
  active?: boolean;
  onToggle?: () => void;
}) => {
  const sorted = groupByImpact(groups);
  const total = sorted.reduce((sum, group) => sum + group.indexCount, 0);
  const content = (
    <>
      <div className="osv-dist-bar" aria-label="Type distribution by index count">
        {sorted.map(group => (
          <span
            key={group.type}
            className={`osv-dist-seg osv-dist-${typeClass(group.type)}`}
            style={{ flexGrow: Math.max(group.indexCount, 1) }}
            title={`${group.type}: ${group.indexCount} indices`}
          />
        ))}
      </div>
      <div className="osv-dist-legend">
        {sorted.map(group => (
          <span key={group.type}>
            <span className={`osv-dist-dot osv-dist-${typeClass(group.type)}`} />
            {group.type}{' '}
            <span title={`${formatNumber(group.indexCount)} indices`}>
              {formatCompactNumber(group.indexCount)}
            </span>
            {total > 0 && (
              <span className="osv-dist-pct">
                {' '}
                {Math.round((group.indexCount / total) * 100)}%
              </span>
            )}
          </span>
        ))}
      </div>
    </>
  );

  if (onToggle) {
    return (
      <button
        type="button"
        className={`osv-dist osv-dist-button ${dense ? 'osv-dist-dense' : ''} ${
          active ? 'osv-dist-active' : ''
        }`}
        aria-expanded={active}
        onClick={event => {
          event.stopPropagation();
          onToggle();
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={`osv-dist ${dense ? 'osv-dist-dense' : ''}`}>
      {content}
    </div>
  );
};

const FamilyList = ({
  indices,
  isAdmin,
  onDeleteIndex,
}: {
  indices: string[];
  isAdmin?: boolean;
  onDeleteIndex?: (index: string) => void;
}) => {
  const families = groupIndicesByFamily(indices);
  const [copiedIndex, setCopiedIndex] = useState<string | null>(null);

  const handleCopyIndex = async (index: string) => {
    await copyText(index);
    setCopiedIndex(index);
    window.setTimeout(() => {
      setCopiedIndex(current => (current === index ? null : current));
    }, 1600);
  };

  return (
    <div className="osv-family-list">
      <div className="osv-family-summary">
        <span>Index groups</span>
        <strong title={`${formatNumber(families.length)} grouped index families`}>
          {formatCompactNumber(families.length)} groups
        </strong>
      </div>
      {families.map(family => (
        <details className="osv-family" key={family.family}>
          <summary className="osv-family-head">
            <span className="osv-family-name">{family.family}</span>
            <span
              className="osv-family-count"
              title={`${formatNumber(family.count)} indices`}
            >
              {formatCompactNumber(family.count)} indices
            </span>
          </summary>
          <div className="osv-index-samples">
            {family.indices.map(index => (
              <span className="osv-index-chip" key={index}>
                <span className="osv-index-name">{index}</span>
                <button
                  type="button"
                  className="osv-index-copy"
                  aria-label={`Copy ${index}`}
                  title="Copy index name"
                  onClick={() => handleCopyIndex(index)}
                >
                  {copiedIndex === index ? (
                    <RiCheckLine size={13} />
                  ) : (
                    <RiFileCopyLine size={13} />
                  )}
                </button>
                {isAdmin && onDeleteIndex && (
                  <button
                    type="button"
                    className="osv-index-delete"
                    aria-label={`Delete ${index}`}
                    title="Delete index"
                    onClick={() => onDeleteIndex(index)}
                  >
                    <RiDeleteBinLine size={13} />
                  </button>
                )}
              </span>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
};

const GroupSummary = ({
  group,
  field,
  isAdmin,
  onDeleteIndex,
}: {
  group: ConflictTypeGroup;
  field?: string;
  isAdmin?: boolean;
  onDeleteIndex?: (
    index: string,
    context: { field: string; type: string },
  ) => void;
}) => (
  <div className="osv-group">
    <div className="osv-group-main">
      <TypePill type={group.type} />
      <span title={`${formatNumber(group.indexCount)} indices`}>
        {formatCompactNumber(group.indexCount)} indices
      </span>
      <span title={`${formatNumber(group.documentCount)} docs`}>
        {formatCompactNumber(group.documentCount)} docs
      </span>
      <span>{group.searchable ? 'searchable' : 'not searchable'}</span>
      <span>{group.aggregatable ? 'aggregatable' : 'not aggregatable'}</span>
    </div>
    <FamilyList
      indices={group.indices}
      isAdmin={isAdmin}
      onDeleteIndex={
        onDeleteIndex && field
          ? index => onDeleteIndex(index, { field, type: group.type })
          : undefined
      }
    />
  </div>
);

const ConflictDetails = ({
  conflict,
  snapshot,
  onClose,
  deepLink,
  isAdmin,
  onDeleteIndex,
}: {
  conflict: FieldConflict | null;
  snapshot: OpenSearchConflictSnapshot | undefined;
  onClose: () => void;
  deepLink: string | null;
  isAdmin: boolean;
  onDeleteIndex: (
    index: string,
    context: { field: string; type: string },
  ) => void;
}) => {
  const [copied, setCopied] = useState(false);
  const [copiedDeepLink, setCopiedDeepLink] = useState(false);

  if (!conflict || !snapshot) {
    return (
      <div className="osv-detail-empty">
        <Text variant="body-small" color="secondary">
          Select a conflict field.
        </Text>
      </div>
    );
  }

  const groups = groupByImpact(conflict.groups);
  const dominant = groups[0];
  const divergent = groups.slice(1);
  const verifyQuery = formatQuery(snapshot.target, conflict);

  const handleCopy = async () => {
    await copyText(verifyQuery);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const handleCopyDeepLink = async () => {
    if (!deepLink) return;
    await copyText(deepLink);
    setCopiedDeepLink(true);
    window.setTimeout(() => setCopiedDeepLink(false), 1600);
  };

  return (
    <aside className="osv-detail" aria-label="Field conflict analysis">
      <div className="osv-detail-head">
        <div>
          <div className="osv-kicker">Selected field</div>
          <h2 className="osv-detail-title">{conflict.field}</h2>
          <div className="osv-muted">
            {conflict.typeCount} types across{' '}
            <span title={`${formatNumber(conflict.indexCount)} indices`}>
              {formatCompactNumber(conflict.indexCount)}
            </span>{' '}
            indices
          </div>
        </div>
        <div className="osv-detail-actions">
          <button
            type="button"
            className="osv-detail-icon"
            aria-label="Copy deep link"
            title={copiedDeepLink ? 'Copied' : 'Copy deep link'}
            onClick={handleCopyDeepLink}
          >
            {copiedDeepLink ? (
              <RiCheckLine size={16} />
            ) : (
              <RiFileCopyLine size={16} />
            )}
          </button>
          <button
            type="button"
            className="osv-detail-icon"
            aria-label="Close analysis panel"
            title="Close"
            onClick={onClose}
          >
            <RiCloseLine size={16} />
          </button>
        </div>
      </div>

      <section className="osv-detail-severity">
        <div>
          <div className="osv-block-title">Severity</div>
          <SeverityBadge severity={conflict.analysis.severity} />
        </div>
      </section>

      <section className="osv-analysis-block">
        <div className="osv-block-title">Likely cause</div>
        <p className="osv-analysis-text">{conflict.analysis.primaryCause}</p>
      </section>

      <section className="osv-analysis-block">
        <div className="osv-block-title">Impact</div>
        <div className="osv-impact-line">
          <span title={`${formatNumber(conflict.indexCount)} affected indices`}>
            {formatCompactNumber(conflict.indexCount)} affected indices
          </span>
          <span title={`${formatNumber(conflict.documentCount)} affected documents`}>
            {formatCompactNumber(conflict.documentCount)} affected documents
          </span>
        </div>
      </section>

      {dominant && (
        <section className="osv-analysis-block">
          <div className="osv-block-title">Mapped types</div>
          <TypeDistributionBar groups={groups} />
          <GroupSummary
            group={dominant}
            field={conflict.field}
            isAdmin={isAdmin}
            onDeleteIndex={onDeleteIndex}
          />
          {divergent.map(group => (
            <GroupSummary
              key={group.type}
              group={group}
              field={conflict.field}
              isAdmin={isAdmin}
              onDeleteIndex={onDeleteIndex}
            />
          ))}
        </section>
      )}

      <section className="osv-analysis-block">
        <div className="osv-block-title">Evidence</div>
        <ul className="osv-list">
          {conflict.analysis.evidence.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="osv-analysis-block">
        <div className="osv-block-title">Recommended checks</div>
        <ul className="osv-list">
          {conflict.analysis.recommendedActions.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="osv-analysis-block">
        <div className="osv-block-head">
          <div className="osv-block-title">Verify in OpenSearch</div>
          <Button
            size="small"
            variant="secondary"
            iconStart={copied ? <RiCheckLine /> : <RiFileCopyLine />}
            onClick={handleCopy}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <code className="osv-command">{verifyQuery}</code>
      </section>
    </aside>
  );
};

const DeleteIndexModal = ({
  index,
  field,
  type,
  confirmText,
  onConfirmTextChange,
  onConfirm,
  onCancel,
  busy,
  error,
}: {
  index: string;
  field: string;
  type: string;
  confirmText: string;
  onConfirmTextChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) => {
  const matches = confirmText.trim() === index;

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="osv-modal-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="osv-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Delete index ${index}`}
        onClick={event => event.stopPropagation()}
      >
        <h2 className="osv-modal-title">Delete index</h2>
        <div className="osv-modal-context">
          <span className="osv-modal-context-label">Resolving conflict on</span>
          <div className="osv-modal-context-row">
            <span className="osv-modal-context-field">{field}</span>
            <span className="osv-modal-context-as">mapped as</span>
            <TypePill type={type} />
          </div>
        </div>
        <p className="osv-modal-text">
          This permanently deletes the OpenSearch index{' '}
          <span className="osv-modal-index">{index}</span> and every document it
          contains, removing its <span className="osv-modal-strong">{type}</span>{' '}
          mapping for field <span className="osv-modal-strong">{field}</span>.
          This action cannot be undone. To confirm, type the index name below.
        </p>
        <input
          className="osv-modal-input"
          value={confirmText}
          onChange={event => onConfirmTextChange(event.target.value)}
          placeholder={index}
          aria-label="Type the index name to confirm deletion"
          autoFocus
          spellCheck={false}
          disabled={busy}
          onKeyDown={event => {
            if (event.key === 'Enter' && matches && !busy) {
              event.preventDefault();
              onConfirm();
            }
          }}
        />
        {error && <div className="osv-modal-error">{error}</div>}
        <div className="osv-modal-actions">
          <button
            type="button"
            className="osv-modal-btn"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="osv-modal-btn osv-modal-btn-danger"
            onClick={onConfirm}
            disabled={busy || !matches}
          >
            {busy ? 'Deleting' : 'Delete index'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export const OpenSearchViewerPage = () => {
  const api = useApi(opensearchViewerApiRef);
  const accountApi = useApi(opensearchAccountApiRef);
  const location = useLocation();
  const navigate = useNavigate();
  const deepLink = useMemo(() => parseDeepLink(location.search), [location.search]);
  const config = useAsync(() => api.getConfig(), [api]);
  const userRole = useAsync(() => accountApi.getUserRole(), [accountApi]);
  const snapshots = useAsyncRetry(() => api.listSnapshots(), [api]);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(
    deepLink.targetId,
  );
  const [selectedField, setSelectedField] = useState<string | null>(
    deepLink.field,
  );
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('docs');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [detailOpen, setDetailOpen] = useState(Boolean(deepLink.field));
  const [deleteTarget, setDeleteTarget] = useState<{
    index: string;
    field: string;
    type: string;
  } | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const isAdmin = userRole.value?.isAdmin ?? false;

  const updateDeepLink = useCallback(
    (
      targetId: string | null,
      field: string | null,
      options?: { replace?: boolean },
    ) => {
      const params = new URLSearchParams(location.search);
      if (targetId) {
        params.set('target', targetId);
      } else {
        params.delete('target');
      }
      if (field) {
        params.set('field', field);
      } else {
        params.delete('field');
      }

      const searchString = params.toString();
      navigate(
        {
          pathname: location.pathname,
          search: searchString ? `?${searchString}` : '',
        },
        { replace: options?.replace ?? false },
      );
    },
    [location.pathname, location.search, navigate],
  );

  useEffect(() => {
    if (deepLink.targetId && deepLink.targetId !== selectedTargetId) {
      setSelectedTargetId(deepLink.targetId);
    }

    if (deepLink.field) {
      if (deepLink.field !== selectedField) {
        setSelectedField(deepLink.field);
      }
      if (!detailOpen) {
        setDetailOpen(true);
      }
      return;
    }

    if (detailOpen) {
      setDetailOpen(false);
    }
    if (selectedField) {
      setSelectedField(null);
    }
  }, [
    deepLink.field,
    deepLink.targetId,
    detailOpen,
    selectedField,
    selectedTargetId,
  ]);

  useEffect(() => {
    const id = setInterval(() => snapshots.retry(), 60_000);
    return () => clearInterval(id);
  }, [snapshots]);

  const snapshotList = snapshots.value ?? [];
  const selectedSnapshot = useMemo(() => {
    if (snapshotList.length === 0) return undefined;
    return (
      snapshotList.find(snapshot => snapshot.target.id === selectedTargetId) ??
      snapshotList[0]
    );
  }, [selectedTargetId, snapshotList]);

  useEffect(() => {
    if (snapshotList.length === 0) return;

    const hasSelectedTarget =
      selectedTargetId &&
      snapshotList.some(snapshot => snapshot.target.id === selectedTargetId);
    const hasDeepLinkTarget =
      deepLink.targetId &&
      snapshotList.some(snapshot => snapshot.target.id === deepLink.targetId);

    if (hasDeepLinkTarget && selectedTargetId !== deepLink.targetId) {
      setSelectedTargetId(deepLink.targetId);
      return;
    }

    if (!hasSelectedTarget) {
      setSelectedTargetId(snapshotList[0].target.id);
    }
  }, [deepLink.targetId, selectedTargetId, snapshotList]);

  const filteredConflicts = useMemo(() => {
    const query = search.trim().toLowerCase();
    const items = selectedSnapshot?.conflicts ?? [];
    const filtered = items.filter(conflict => {
      const matchesSearch =
        !query ||
        conflict.field.toLowerCase().includes(query) ||
        conflict.groups.some(group => group.type.toLowerCase().includes(query)) ||
        conflict.groups.some(group =>
          group.indices.some(index => index.toLowerCase().includes(query)),
        );
      const matchesSeverity =
        severity === 'all' || conflict.analysis.severity === severity;
      return matchesSearch && matchesSeverity;
    });

    const sorted = filtered.sort((a, b) => {
      if (sortKey === 'field') return a.field.localeCompare(b.field);
      if (sortKey === 'severity') {
        return (
          severityRank[a.analysis.severity] - severityRank[b.analysis.severity]
        );
      }
      if (sortKey === 'types') return a.typeCount - b.typeCount;
      if (sortKey === 'indexGroups') {
        return conflictIndexGroupCount(a) - conflictIndexGroupCount(b);
      }
      if (sortKey === 'indices') return a.indexCount - b.indexCount;
      if (sortKey === 'docs') {
        const docsDelta = (a.documentCount ?? -1) - (b.documentCount ?? -1);
        if (docsDelta !== 0) return docsDelta;
        return a.indexCount - b.indexCount;
      }
      if (sortKey === 'cause') {
        return a.analysis.primaryCause.localeCompare(b.analysis.primaryCause);
      }
      return a.field.localeCompare(b.field);
    });
    return sortDir === 'desc' ? sorted.reverse() : sorted;
  }, [search, selectedSnapshot, severity, sortDir, sortKey]);

  const selectedConflict = selectedField
    ? selectedSnapshot?.conflicts.find(conflict => conflict.field === selectedField) ??
      null
    : filteredConflicts[0] ?? null;

  useEffect(() => {
    if (!selectedSnapshot || !selectedField || selectedConflict) return;

    setSelectedField(null);
    if (detailOpen) setDetailOpen(false);
    updateDeepLink(selectedSnapshot.target.id, null, { replace: true });
  }, [
    detailOpen,
    selectedConflict,
    selectedField,
    selectedSnapshot,
    updateDeepLink,
  ]);

  const openDetails = useCallback(
    (field: string) => {
      if (!selectedSnapshot) return;
      setSelectedField(field);
      setDetailOpen(true);
      updateDeepLink(selectedSnapshot.target.id, field);
    },
    [selectedSnapshot, updateDeepLink],
  );

  const closeDetails = useCallback(() => {
    setDetailOpen(false);
    updateDeepLink(selectedSnapshot?.target.id ?? selectedTargetId, null);
  }, [selectedSnapshot, selectedTargetId, updateDeepLink]);

  const selectedDeepLink = useMemo(() => {
    if (!selectedSnapshot || !selectedConflict) return null;

    const params = new URLSearchParams(location.search);
    params.set('target', selectedSnapshot.target.id);
    params.set('field', selectedConflict.field);
    const searchString = params.toString();
    const path = `${location.pathname}${searchString ? `?${searchString}` : ''}`;

    if (typeof window === 'undefined') return path;
    return `${window.location.origin}${path}`;
  }, [location.pathname, location.search, selectedConflict, selectedSnapshot]);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey(current => {
      if (current === key) {
        setSortDir(dir => (dir === 'asc' ? 'desc' : 'asc'));
        return current;
      }
      setSortDir(key === 'field' || key === 'cause' ? 'asc' : 'desc');
      return key;
    });
  }, []);

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return '↕';
    return sortDir === 'asc' ? '↑' : '↓';
  };

  const HeaderButton = ({
    column,
    children,
  }: {
    column: SortKey;
    children: React.ReactNode;
  }) => (
    <button
      type="button"
      className="osv-sort-button"
      onClick={() => toggleSort(column)}
      aria-sort={
        sortKey === column
          ? sortDir === 'asc'
            ? 'ascending'
            : 'descending'
          : 'none'
      }
    >
      <span>{children}</span>
      <span className="osv-sort-ind">{sortIndicator(column)}</span>
    </button>
  );

  const runScan = useCallback(async () => {
    if (!selectedSnapshot) return;
    setScanning(true);
    setScanError(null);
    try {
      await api.scanTarget(selectedSnapshot.target.id);
      await snapshots.retry();
    } catch (error: any) {
      setScanError(error?.message ?? 'Failed to scan OpenSearch field conflicts');
    } finally {
      setScanning(false);
    }
  }, [api, selectedSnapshot, snapshots]);

  const requestDeleteIndex = useCallback(
    (index: string, context: { field: string; type: string }) => {
      setDeleteError(null);
      setDeleteConfirmText('');
      setDeleteTarget({ index, field: context.field, type: context.type });
    },
    [],
  );

  const cancelDeleteIndex = useCallback(() => {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteConfirmText('');
    setDeleteError(null);
  }, [deleting]);

  const confirmDeleteIndex = useCallback(async () => {
    if (!deleteTarget || deleteConfirmText.trim() !== deleteTarget.index) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteIndex(deleteTarget.index);
      setDeleteTarget(null);
      setDeleteConfirmText('');
      setDeleting(false);
      // Re-run the same Refresh flow so the page re-renders with the latest
      // scan: the deleted index drops out and summary metrics update.
      await runScan();
    } catch (error: any) {
      setDeleteError(error?.message ?? 'Failed to delete index');
      setDeleting(false);
    }
  }, [api, deleteConfirmText, deleteTarget, runScan]);

  const highCount =
    selectedSnapshot?.conflicts.filter(
      conflict => conflict.analysis.severity === 'high',
    ).length ?? 0;

  return (
    <>
      <PluginHeader
        icon={<RiDatabase2Line />}
        title="OpenSearch"
        customActions={
          <TagGroup>
            <Tag id="plugin-id" size="small">
              {opensearchViewerPlugin.getId()}
            </Tag>
            <Tag id="mode" size="small">
              field conflicts
            </Tag>
          </TagGroup>
        }
      />
      <Container>
        <Flex direction="column" gap="3" p="3">
          <OpenSearchNav current="conflicts" isAdmin={isAdmin} />

          {config.value && !config.value.configured && (
            <Alert
              status="warning"
              title="OpenSearch endpoint is not configured"
            />
          )}
          {snapshots.error && (
            <Alert status="danger" title={snapshots.error.message} />
          )}
          {scanError && <Alert status="danger" title={scanError} />}

          {snapshots.loading && !snapshots.value ? (
            <Skeleton style={{ height: 220 }} />
          ) : (
            <div className="osv-shell">
              <div className="osv-control-bar">
                <div className="osv-control-group">
                  <label className="osv-label" htmlFor="osv-target">
                    Target
                  </label>
                  <select
                    id="osv-target"
                    className="osv-select osv-target-select"
                    value={selectedSnapshot?.target.id ?? ''}
                    onChange={event => {
                      const targetId = event.target.value;
                      setSelectedTargetId(targetId);
                      setSelectedField(null);
                      setDetailOpen(false);
                      updateDeepLink(targetId, null);
                    }}
                  >
                    {snapshotList.map(snapshot => (
                      <option
                        key={snapshot.target.id}
                        value={snapshot.target.id}
                      >
                        {snapshot.target.name} ({snapshot.target.indexPattern})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="osv-scan-meta">
                  <span className={`osv-status osv-status-${selectedSnapshot?.status ?? 'never_scanned'}`}>
                    {selectedSnapshot ? statusLabel(selectedSnapshot) : 'No target'}
                  </span>
                  <span>Schedule {config.value?.scanCron ?? '-'}</span>
                </div>

              </div>

              {selectedSnapshot?.errorMessage && (
                <Alert
                  status="warning"
                  title={selectedSnapshot.errorMessage}
                />
              )}

              {selectedSnapshot && (
                <>
                  <div className="osv-metrics">
                    <Metric
                      label="Conflict fields"
                      value={selectedSnapshot.summary.conflictFields}
                      tone={
                        selectedSnapshot.summary.conflictFields > 0
                          ? 'danger'
                          : 'success'
                      }
                    />
                    <Metric label="High severity" value={highCount} tone="warning" />
                    <Metric
                      label="Affected indices"
                      value={formatCompactNumber(
                        selectedSnapshot.summary.affectedIndices,
                      )}
                    />
                    <Metric
                      label="Affected docs"
                      value={formatCompactNumber(
                        selectedSnapshot.summary.affectedDocuments,
                      )}
                    />
                    <Metric
                      label="Scanned fields"
                      value={selectedSnapshot.summary.totalFields}
                    />
                    <Metric
                      label="Last Scan"
                      value={formatDate(selectedSnapshot.scannedAt ?? null)}
                      valueTitle={formatDate(selectedSnapshot.scannedAt ?? null)}
                      detail={`Duration ${formatDuration(
                        selectedSnapshot.scanDurationMs,
                      )}`}
                      action={
                        <Button
                          size="small"
                          variant="secondary"
                          iconStart={<RiRefreshLine />}
                          onClick={runScan}
                          isDisabled={scanning || !selectedSnapshot}
                        >
                          {scanning ? 'Scanning' : 'Refresh'}
                        </Button>
                      }
                    />
                  </div>

                  <div className="osv-workspace">
                    <main className="osv-list-pane">
                      <div className="osv-filter-bar">
                        <div className="osv-search">
                          <SearchField
                            placeholder="Search field, type, or index"
                            value={search}
                            onChange={setSearch}
                          />
                        </div>
                        <select
                          className="osv-select"
                          value={severity}
                          onChange={event =>
                            setSeverity(event.target.value as SeverityFilter)
                          }
                        >
                          <option value="all">All severities</option>
                          <option value="high">High</option>
                          <option value="medium">Medium</option>
                          <option value="low">Low</option>
                        </select>
                      </div>

                      {filteredConflicts.length === 0 ? (
                        <div className="osv-empty">
                          <Text variant="body-small" color="secondary">
                            No field conflicts match the current filters.
                          </Text>
                        </div>
                      ) : (
                        <div className="osv-table-wrap">
                          <table className="osv-table">
                            <thead>
                              <tr>
                                <th>
                                  <HeaderButton column="severity">
                                    Severity
                                  </HeaderButton>
                                </th>
                                <th>
                                  <HeaderButton column="field">Field</HeaderButton>
                                </th>
                                <th>
                                  <HeaderButton column="types">Types</HeaderButton>
                                </th>
                                <th>
                                  <HeaderButton column="indexGroups">
                                    Index Groups
                                  </HeaderButton>
                                </th>
                                <th>
                                  <HeaderButton column="indices">Indices</HeaderButton>
                                </th>
                                <th>
                                  <HeaderButton column="docs">Docs</HeaderButton>
                                </th>
                                <th>
                                  <HeaderButton column="cause">Cause</HeaderButton>
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {filteredConflicts.map(conflict => {
                                const indexGroupCount =
                                  conflictIndexGroupCount(conflict);
                                return (
                                  <tr
                                    key={conflict.field}
                                    className={
                                      detailOpen &&
                                      conflict.field === selectedConflict?.field
                                        ? 'osv-row-selected'
                                        : ''
                                    }
                                    tabIndex={0}
                                    aria-selected={
                                      detailOpen &&
                                      conflict.field === selectedConflict?.field
                                    }
                                    onClick={() => openDetails(conflict.field)}
                                    onKeyDown={event => {
                                      if (
                                        event.key === 'Enter' ||
                                        event.key === ' '
                                      ) {
                                        event.preventDefault();
                                        openDetails(conflict.field);
                                      }
                                    }}
                                  >
                                    <td>
                                      <SeverityBadge
                                        severity={conflict.analysis.severity}
                                      />
                                    </td>
                                    <td>
                                      <div className="osv-field-cell">
                                        <span className="osv-field">
                                          {conflict.field}
                                        </span>
                                      </div>
                                    </td>
                                    <td>
                                      <TypeDistributionBar
                                        groups={conflict.groups}
                                        dense
                                      />
                                    </td>
                                    <td className="osv-count-cell">
                                      <span
                                        title={`${formatNumber(
                                          indexGroupCount,
                                        )} grouped index families`}
                                      >
                                        {formatCompactNumber(indexGroupCount)}
                                      </span>
                                    </td>
                                    <td className="osv-count-cell">
                                      <span
                                        title={`${formatNumber(conflict.indexCount)} indices`}
                                      >
                                        {formatCompactNumber(conflict.indexCount)}
                                      </span>
                                    </td>
                                    <td className="osv-count-cell">
                                      <span
                                        title={`${formatNumber(conflict.documentCount)} docs`}
                                      >
                                        {formatCompactNumber(
                                          conflict.documentCount,
                                        )}
                                      </span>
                                    </td>
                                    <td className="osv-cause-cell">
                                      {conflict.analysis.primaryCause}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </main>

                    {detailOpen && (
                      <button
                        type="button"
                        className="osv-sidebar-backdrop"
                        aria-label="Close analysis panel"
                        onClick={closeDetails}
                      />
                    )}
                    <div
                      className={`osv-sidebar-slide ${
                        detailOpen ? 'osv-sidebar-open' : ''
                      }`}
                      aria-hidden={!detailOpen}
                    >
                      <ConflictDetails
                        conflict={selectedConflict}
                        snapshot={selectedSnapshot}
                        onClose={closeDetails}
                        deepLink={selectedDeepLink}
                        isAdmin={isAdmin}
                        onDeleteIndex={requestDeleteIndex}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </Flex>
      </Container>
      {deleteTarget && (
        <DeleteIndexModal
          index={deleteTarget.index}
          field={deleteTarget.field}
          type={deleteTarget.type}
          confirmText={deleteConfirmText}
          onConfirmTextChange={setDeleteConfirmText}
          onConfirm={confirmDeleteIndex}
          onCancel={cancelDeleteIndex}
          busy={deleting}
          error={deleteError}
        />
      )}
    </>
  );
};
