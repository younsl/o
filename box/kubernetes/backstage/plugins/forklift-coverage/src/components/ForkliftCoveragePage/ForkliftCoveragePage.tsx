import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Cell,
  CellText,
  Container,
  Flex,
  Link,
  PluginHeader,
  Table,
  Tag,
  TagGroup,
  Text,
  ToggleButton,
  ToggleButtonGroup,
} from '@backstage/ui';
import type { ColumnConfig, SortDescriptor } from '@backstage/ui';
import {
  RiCheckboxCircleFill,
  RiSearchLine,
  RiSettings3Line,
  RiStackLine,
} from '@remixicon/react';
import { useApi, useRouteRef } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { forkliftCoveragePlugin } from '../../plugin';
import { forkliftCoverageApiRef } from '../../api';
import {
  AppliedState,
  ExcludedProject,
  ForkliftProject,
  GroupCoverage,
  ScanProgress,
} from '../../api/types';
import { CoverageTrendChart } from '../CoverageTrendChart';
import { HighlightText } from '../HighlightText';
import { ConfigurationWizard } from '../ConfigurationWizard';
import { ProjectDetailPage } from '../ProjectDetailPage';
import { rootRouteRef } from '../../routes';
import './ForkliftCoveragePage.css';

type ViewMode = 'list' | 'groups' | 'trend';
type StatusFilter = 'all' | 'yes' | 'partial' | 'no' | 'error' | 'excluded';

/**
 * Each view is its own path, so a pasted URL lands a teammate on the same view
 * rather than the default one. The list view carries its filter and query in
 * the search string for the same reason.
 */
const VIEW_LABELS: Record<ViewMode, string> = {
  list: 'List',
  groups: 'Groups',
  trend: 'Trend',
};

const STATUS_FILTERS: StatusFilter[] = [
  'all',
  'yes',
  'partial',
  'no',
  'error',
  'excluded',
];

const parseStatusFilter = (raw: string | null): StatusFilter =>
  STATUS_FILTERS.includes(raw as StatusFilter) ? (raw as StatusFilter) : 'all';


const STATUS_LABELS: Record<AppliedState, string> = {
  yes: 'Applied',
  partial: 'Partial',
  no: 'Not applied',
  error: 'Error',
};

const formatRelative = (iso: string | null): string => {
  if (!iso) return 'never';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

/** Matching files first, original order otherwise. */
const orderEvidence = (evidence: string[], query: string): string[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return evidence;
  const hits = evidence.filter(p => p.toLowerCase().includes(needle));
  if (hits.length === 0) return evidence;
  return [...hits, ...evidence.filter(p => !hits.includes(p))];
};

const formatSeconds = (seconds: number): string =>
  seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

/**
 * Excluded projects were never scanned, so they carry no verdict. They still
 * belong in the table, otherwise an opt-out is invisible and nobody notices a
 * repository that muted itself.
 */
interface ProjectRow extends ForkliftProject {
  rowKey: string;
}

const excludedToRow = (project: ExcludedProject): ProjectRow => ({
  ...project,
  applied: 'no',
  branch: null,
  onDefault: null,
  format: null,
  ciWired: false,
  registryPinned: false,
  evidence: [],
  note: null,
  skipped: false,
  rowKey: project.path,
  excludeReason: project.reason,
});

/** Filter chip carrying its own count, the only summary the page needs. */
const FilterChip = ({
  label,
  count,
  tone,
  selected,
  onSelect,
}: {
  label: string;
  count: number;
  tone?: 'success' | 'warning' | 'danger';
  selected: boolean;
  onSelect: () => void;
}) => (
  <button
    type="button"
    className={`fc-chip${selected ? ' fc-chip-selected' : ''}${
      tone ? ` fc-chip-${tone}` : ''
    }`}
    aria-pressed={selected}
    onClick={onSelect}
  >
    <span className="fc-chip-label">{label}</span>
    <span className="fc-chip-count">{count}</span>
  </button>
);

/**
 * Collapsed to a magnifier until used, so the toolbar stays quiet. Filtering
 * happens on every keystroke, so there is no submit affordance to show.
 */
const SearchToggle = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open && !value) {
    return (
      <button
        type="button"
        className="fc-search-toggle"
        aria-label="Search projects"
        onClick={() => setOpen(true)}
      >
        <RiSearchLine size={16} />
      </button>
    );
  }

  return (
    <div className="fc-search-open">
      <RiSearchLine size={16} className="fc-search-icon" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        className="fc-search-input"
        aria-label="Search projects"
        placeholder="Search project, format, or file"
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            onChange('');
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!value) setOpen(false);
        }}
      />
    </div>
  );
};

const ScanProgressPanel = ({ progress }: { progress: ScanProgress }) => {
  // Re-render once a second so the elapsed clock ticks between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - new Date(progress.startedAt).getTime()) / 1000),
  );
  const listing = progress.phase === 'listing' || progress.total === 0;
  const percent = listing
    ? 0
    : Math.min(100, Math.round((progress.done / progress.total) * 100));
  const rate = elapsedSeconds > 0 ? progress.done / elapsedSeconds : 0;
  const remaining =
    !listing && rate > 0 && progress.done < progress.total
      ? Math.round((progress.total - progress.done) / rate)
      : null;

  return (
    <Box mt="3">
      <Flex justify="between" align="center" gap="2" style={{ flexWrap: 'wrap' }}>
        <Text variant="body-small" weight="bold">
          {listing
            ? 'Listing projects…'
            : `Scanning ${progress.done} of ${progress.total}`}
        </Text>
        <Text variant="body-x-small" color="secondary">
          {listing ? '' : `${percent}% · `}
          {formatSeconds(elapsedSeconds)} elapsed
          {remaining !== null ? ` · about ${formatSeconds(remaining)} left` : ''}
        </Text>
      </Flex>
      <Box mt="1">
        <div
          className={`fc-progress${listing ? ' fc-progress-indeterminate' : ''}`}
          role="progressbar"
          aria-valuenow={listing ? undefined : percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Scan progress"
        >
          <div className="fc-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      </Box>
    </Box>
  );
};

const GroupBreakdown = ({
  groups,
  gitlabWebUrl,
}: {
  groups: GroupCoverage[];
  gitlabWebUrl: string | null;
}) => {
  if (groups.length === 0) {
    return (
      <Text variant="body-small" color="secondary">
        No group data yet. Run a scan first.
      </Text>
    );
  }
  return (
    <Flex direction="column" gap="3">
      {groups.map(group => {
        // Projects outside any group are bucketed under (root), which has no
        // group page to link to.
        const href =
          gitlabWebUrl && group.group !== '(root)'
            ? `${gitlabWebUrl}/groups/${group.group}`
            : null;
        return (
          <div key={group.group} className="fc-group-row">
            <span className="fc-group-label">
              {href ? (
                <Link
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="fc-group-link"
                >
                  {group.group}
                </Link>
              ) : (
                <Text as="span" variant="body-small" weight="bold">
                  {group.group}
                </Text>
              )}
              <Text as="span" variant="body-x-small" color="secondary">
                {group.applied} / {group.target} ({group.percent}%)
              </Text>
              {/* Full coverage is the goal state, so it gets a mark rather
                  than another number to read. */}
              {group.percent === 100 && (
                <RiCheckboxCircleFill
                  size={14}
                  className="fc-group-done"
                  aria-label="Fully covered"
                />
              )}
            </span>
            <div
              className="fc-coverage-bar"
              role="progressbar"
              aria-label={`${group.group} coverage`}
              aria-valuenow={group.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="fc-coverage-bar-fill"
                style={{ width: `${group.percent}%` }}
              />
            </div>
          </div>
        );
      })}
    </Flex>
  );
};

const CoverageListPage = ({ view }: { view: ViewMode }) => {
  const api = useApi(forkliftCoverageApiRef);
  const navigate = useNavigate();
  const rootPath = useRouteRef(rootRouteRef)();

  // Everyone signed in can read coverage. Admin only gates the write actions
  // and the pipeline viewer on the detail page.
  const { value: adminStatus } = useAsyncRetry(
    async () => api.getAdminStatus(),
    [],
  );
  const isAdmin = adminStatus?.isAdmin ?? false;

  const {
    value: coverage,
    loading: coverageLoading,
    error: coverageError,
    retry: refetchCoverage,
  } = useAsyncRetry(async () => api.getCoverage(), []);

  const { value: groups, retry: refetchGroups } = useAsyncRetry(
    async () => api.getGroupCoverage(),
    [],
  );

  const { value: history, retry: refetchHistory } = useAsyncRetry(
    async () => api.getHistory(90),
    [],
  );

  // Filter and query live in the URL, so both are part of a shared link and
  // survive a reload.
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('q') ?? '';
  const statusFilter = parseStatusFilter(searchParams.get('status'));

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        // Typing filters on every keystroke, so each change replaces the entry
        // instead of stacking one history step per character.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setSearch = useCallback(
    (next: string) => setParam('q', next || null),
    [setParam],
  );

  // Re-selecting the active chip clears it, which is the 'all' filter and needs
  // no parameter of its own.
  const selectStatus = useCallback(
    (next: StatusFilter) =>
      setParam('status', next === statusFilter || next === 'all' ? null : next),
    [setParam, statusFilter],
  );

  const selectView = useCallback(
    (next: ViewMode) => {
      // Only the list view reads status and q, so they are dropped on the way
      // out rather than lingering in a Groups or Trend link.
      const query = next === 'list' ? searchParams.toString() : '';
      navigate(`${rootPath}/${next}${query ? `?${query}` : ''}`);
    },
    [navigate, rootPath, searchParams],
  );

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>({
    column: 'status',
    direction: 'ascending',
  });

  const scanning = coverage?.scanning ?? false;

  // While a scan runs the counts change under the user, so poll until it ends.
  useEffect(() => {
    if (!scanning) return undefined;
    const id = setInterval(() => refetchCoverage(), 2_000);
    return () => clearInterval(id);
  }, [scanning, refetchCoverage]);

  const wasScanning = React.useRef(false);
  useEffect(() => {
    if (wasScanning.current && !scanning) {
      refetchGroups();
      refetchHistory();
    }
    wasScanning.current = scanning;
  }, [scanning, refetchGroups, refetchHistory]);

  const handleScan = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await api.startScan();
      refetchCoverage();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setBusy(false);
    }
  }, [api, refetchCoverage]);

  const handleWizardSaved = useCallback(() => {
    setShowWizard(false);
    refetchCoverage();
  }, [refetchCoverage]);

  const rows: ProjectRow[] = useMemo(() => {
    const lower = search.toLowerCase();
    const scanned: ProjectRow[] = (coverage?.projects ?? [])
      // Projects without CI were never integration candidates, so they stay
      // out of the table and live in the footnote instead.
      .filter(p => !p.skipped)
      .filter(p => {
        // A scanned project can still be excluded, and then its verdict is
        // not what it should be filed under.
        if (statusFilter === 'all') return true;
        if (statusFilter === 'excluded') return !!p.excludeReason;
        return !p.excludeReason && p.applied === statusFilter;
      })
      .map(p => ({ ...p, rowKey: p.path }));

    // Projects excluded before they were ever scanned carry no verdict.
    const excluded: ProjectRow[] =
      statusFilter === 'all' || statusFilter === 'excluded'
        ? (coverage?.excludedProjects ?? []).map(excludedToRow)
        : [];

    return [...scanned, ...excluded].filter(
      p =>
        !lower ||
        p.path.toLowerCase().includes(lower) ||
        (p.format ?? '').toLowerCase().includes(lower) ||
        (p.excludeReason ?? '').toLowerCase().includes(lower) ||
        p.evidence.some(e => e.toLowerCase().includes(lower)),
    );
  }, [coverage, search, statusFilter]);

  const sorted: ProjectRow[] = useMemo(() => {
    const dir = sortDescriptor.direction === 'descending' ? -1 : 1;
    const col = String(sortDescriptor.column ?? 'status');
    // Worst first, so the projects that still need work sit at the top.
    const rank: Record<AppliedState, number> = {
      no: 0,
      partial: 1,
      error: 2,
      yes: 3,
    };
    // Excluded rows carry no verdict, so they sort below everything else.
    const statusRank = (row: ProjectRow) =>
      row.excludeReason ? 4 : rank[row.applied];
    const compare = (a: ProjectRow, b: ProjectRow): number => {
      switch (col) {
        case 'project':
          return a.path.localeCompare(b.path);
        case 'branch':
          return (a.branch ?? '').localeCompare(b.branch ?? '');
        case 'format':
          return (a.format ?? '').localeCompare(b.format ?? '');
        case 'status':
        default:
          return (
            statusRank(a) - statusRank(b) || a.path.localeCompare(b.path)
          );
      }
    };
    return [...rows].sort((a, b) => compare(a, b) * dir);
  }, [rows, sortDescriptor]);

  const columns: ColumnConfig<ProjectRow>[] = useMemo(
    () => [
      {
        id: 'project',
        label: 'Project',
        isRowHeader: true,
        isSortable: true,
        defaultWidth: '2fr',
        minWidth: 200,
        // CellText takes plain strings, so a highlighted path is rendered as
        // its own cell body.
        cell: row => (
          <Cell>
            <Flex direction="column" gap="0.5">
              <Text variant="body-small" weight="bold" truncate>
                <HighlightText text={row.path} query={search} />
              </Text>
              {(row.excludeReason ?? row.note) && (
                <Text variant="body-x-small" color="secondary">
                  <HighlightText
                    text={row.excludeReason ?? row.note ?? ''}
                    query={search}
                  />
                </Text>
              )}
            </Flex>
          </Cell>
        ),
      },
      {
        id: 'status',
        label: 'Status',
        isSortable: true,
        defaultWidth: 120,
        minWidth: 100,
        cell: row => {
          const state = row.excludeReason ? 'excluded' : row.applied;
          return (
            <Cell>
              <span className="fc-status">
                <span
                  className={`fc-led fc-led-${state}`}
                  aria-hidden
                />
                <Text variant="body-small">
                  {row.excludeReason ? 'Excluded' : STATUS_LABELS[row.applied]}
                </Text>
              </span>
            </Cell>
          );
        },
      },
      {
        id: 'branch',
        label: 'Branch',
        isSortable: true,
        defaultWidth: '1fr',
        minWidth: 130,
        cell: row => (
          <CellText
            title={row.branch ?? '—'}
            description={
              row.onDefault === false ? 'not on default branch' : undefined
            }
          />
        ),
      },
      {
        id: 'format',
        label: 'Format',
        isSortable: true,
        defaultWidth: 110,
        minWidth: 90,
        cell: row => (
          <Cell>
            <Text variant="body-small">
              <HighlightText text={row.format ?? '—'} query={search} />
            </Text>
          </Cell>
        ),
      },
      {
        id: 'evidence',
        label: 'Evidence',
        defaultWidth: '2fr',
        minWidth: 160,
        cell: row => (
          <Cell>
            {row.evidence.length === 0 ? (
              <Text variant="body-small" color="secondary">
                —
              </Text>
            ) : (
              <TagGroup>
                {/* A search hit can sit past the second file, so matching
                    files are shown first rather than being cut off. */}
                {orderEvidence(row.evidence, search)
                  .slice(0, 2)
                  .map(path => (
                    <Tag key={path} textValue={path}>
                      <HighlightText text={path} query={search} />
                    </Tag>
                  ))}
                {row.evidence.length > 2 && (
                  <Tag key="more" textValue={`${row.evidence.length - 2} more`}>
                    +{row.evidence.length - 2}
                  </Tag>
                )}
              </TagGroup>
            )}
          </Cell>
        ),
      },
    ],
    // Cells highlight the current query, so the columns rebuild as it changes.
    [search],
  );

  const percent = coverage?.percent ?? 0;
  const percentTone =
    percent >= 80 ? 'success' : percent >= 50 ? 'warning' : 'danger';

  // Until a Forklift host exists there is nothing to show. The wizard itself
  // decides what a non-admin sees, which is a wait for an administrator.
  if (showWizard || (coverage && !coverage.configured)) {
    return <ConfigurationWizard onSaved={handleWizardSaved} />;
  }

  return (
    <>
      <PluginHeader
        icon={<RiStackLine />}
        title="Forklift Coverage"
        customActions={
          <TagGroup>
            <Tag id="plugin-id" size="small">
              {forkliftCoveragePlugin.getId()}
            </Tag>
          </TagGroup>
        }
      />
      <Container my="4">
        <Flex
          justify="between"
          align="end"
          gap="4"
          style={{ flexWrap: 'wrap' }}
        >
          <Flex align="end" gap="3">
            <Text as="div" variant="title-large" weight="bold" color={percentTone}>
              {percent}%
            </Text>
            <Flex direction="column" gap="0.5" style={{ paddingBottom: 4 }}>
              <Text as="div" variant="body-small">
                {coverage?.applied ?? 0} of {coverage?.target ?? 0} projects wired
                to{' '}
                <Link
                  href={`https://${coverage?.forkliftHost ?? ''}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {coverage?.forkliftHost ?? 'Forklift'}
                </Link>
              </Text>
              <Text as="div" variant="body-x-small" color="secondary">
                Last scan {formatRelative(coverage?.lastScannedAt ?? null)}
                {coverage?.lastScanDurationMs
                  ? ` · took ${formatSeconds(Math.round(coverage.lastScanDurationMs / 1000))}`
                  : ''}
              </Text>
            </Flex>
          </Flex>

          {isAdmin && (
            <Flex gap="2" align="center">
              <Button
                variant="secondary"
                onPress={handleScan}
                isDisabled={busy || scanning}
              >
                {scanning ? 'Scanning…' : 'Scan now'}
              </Button>
              <button
                type="button"
                className="fc-search-toggle"
                aria-label="Open settings"
                onClick={() => setShowWizard(true)}
              >
                <RiSettings3Line size={16} />
              </button>
            </Flex>
          )}
        </Flex>

        {scanning && coverage?.scanProgress && (
          <ScanProgressPanel progress={coverage.scanProgress} />
        )}

        {/* The scan runs detached, so its failure only reaches the page here. */}
        {(actionError || (!scanning && coverage?.lastScanError)) && (
          <Box mt="3">
            <Alert
              status="danger"
              title={actionError ?? `Scan failed. ${coverage?.lastScanError}`}
            />
          </Box>
        )}

        <Box mt="4">
          <Flex justify="between" align="center" gap="2" style={{ flexWrap: 'wrap' }}>
            {/* Status filters act on the table, so they only exist in the list
                view. Groups and Trend have nothing to filter. A spacer keeps
                the view toggle pinned right when they are gone. */}
            {view !== 'list' && <span />}
            {view === 'list' && (
            <Flex gap="1" align="center" style={{ flexWrap: 'wrap' }}>
              <FilterChip
                label="All"
                count={coverage?.target ?? 0}
                selected={statusFilter === 'all'}
                onSelect={() => selectStatus('all')}
              />
              <FilterChip
                label="Applied"
                count={coverage?.applied ?? 0}
                tone="success"
                selected={statusFilter === 'yes'}
                onSelect={() => selectStatus('yes')}
              />
              <FilterChip
                label="Partial"
                count={coverage?.partial ?? 0}
                tone="warning"
                selected={statusFilter === 'partial'}
                onSelect={() => selectStatus('partial')}
              />
              <FilterChip
                label="Not applied"
                count={coverage?.notApplied ?? 0}
                tone="danger"
                selected={statusFilter === 'no'}
                onSelect={() => selectStatus('no')}
              />
              {(coverage?.errored ?? 0) > 0 && (
                <FilterChip
                  label="Errors"
                  count={coverage?.errored ?? 0}
                  selected={statusFilter === 'error'}
                  onSelect={() => selectStatus('error')}
                />
              )}
              <FilterChip
                label="Excluded"
                count={coverage?.excluded ?? 0}
                selected={statusFilter === 'excluded'}
                onSelect={() => selectStatus('excluded')}
              />
            </Flex>
            )}

            <Flex gap="2" align="center">
              {view === 'list' && (
                <SearchToggle value={search} onChange={setSearch} />
              )}
              <ToggleButtonGroup
                aria-label="View mode"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={new Set([view])}
                onSelectionChange={keys => {
                  const first = Array.from(keys as Set<string>)[0];
                  if (first === 'list' || first === 'groups' || first === 'trend') {
                    selectView(first);
                  }
                }}
              >
                <ToggleButton id="list" size="small" className="fc-view-toggle-btn">
                  {VIEW_LABELS.list}
                </ToggleButton>
                <ToggleButton id="groups" size="small" className="fc-view-toggle-btn">
                  {VIEW_LABELS.groups}
                </ToggleButton>
                <ToggleButton id="trend" size="small" className="fc-view-toggle-btn">
                  {VIEW_LABELS.trend}
                </ToggleButton>
              </ToggleButtonGroup>
            </Flex>
          </Flex>
        </Box>

        <Box mt="3">
          {view === 'list' && (
            <Box
              style={{ overflowX: 'auto', width: '100%' }}
              className="fc-table-wrapper"
            >
              <Table<ProjectRow>
                data={sorted}
                loading={coverageLoading}
                error={coverageError ?? undefined}
                columnConfig={columns}
                sort={{
                  descriptor: sortDescriptor,
                  onSortChange: setSortDescriptor,
                }}
                rowConfig={{
                  onClick: row =>
                    navigate(
                      `${rootPath}/projects/${encodeURIComponent(row.rowKey)}`,
                    ),
                }}
                pagination={{ type: 'none' }}
                emptyState={
                  <Box p="4">
                    <Text color="secondary">No projects match this filter.</Text>
                  </Box>
                }
              />
            </Box>
          )}

          {view === 'groups' && (
            <GroupBreakdown
              groups={groups ?? []}
              gitlabWebUrl={coverage?.gitlabWebUrl ?? null}
            />
          )}

          {view === 'trend' && (
            <CoverageTrendChart snapshots={history ?? []} />
          )}
        </Box>

        <Box mt="3">
          <Text variant="body-x-small" color="secondary">
            {coverage?.skipped ?? 0} projects have no CI and are out of scope ·
            excluded projects opted out with a topic or the exclude list · a
            project counts as applied when its pipeline and a registry file both
            point at Forklift
          </Text>
        </Box>
      </Container>
    </>
  );
};

/** Absolute so it lands on the list view from any depth, splat matches included. */
const RedirectToList = () => {
  const rootPath = useRouteRef(rootRouteRef)();
  return <Navigate to={`${rootPath}/list`} replace />;
};

export const ForkliftCoveragePage = () => (
  <Routes>
    {/* The bare plugin path is what the sidebar and older bookmarks point at.
        It redirects so every view on screen has one canonical URL to copy. */}
    <Route path="/" element={<RedirectToList />} />
    <Route path="/list" element={<CoverageListPage view="list" />} />
    <Route path="/groups" element={<CoverageListPage view="groups" />} />
    <Route path="/trend" element={<CoverageListPage view="trend" />} />
    <Route path="/projects/:projectPath" element={<ProjectDetailPage />} />
    {/* An unknown suffix is a stale link, not a dead end. */}
    <Route path="*" element={<RedirectToList />} />
  </Routes>
);
