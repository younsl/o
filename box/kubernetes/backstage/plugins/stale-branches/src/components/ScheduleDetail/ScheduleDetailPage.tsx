import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Cell,
  Container,
  Flex,
  Link,
  PluginHeader,
  Table,
  Tag,
  TagGroup,
  Text,
} from '@backstage/ui';
import type { ColumnConfig, SortDescriptor } from '@backstage/ui';
import {
  RiArrowLeftLine,
  RiEditLine,
  RiBrush3Line,
  RiFlaskLine,
  RiPlayLine,
  RiSearchLine,
  RiSendPlaneLine,
  RiTimeLine,
  RiUserLine,
} from '@remixicon/react';
import { useApi, useRouteRef } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { staleBranchesPlugin } from '../../plugin';
import { staleBranchesApiRef } from '../../api';
import { RunDetail, RunSummary, StaleBranch } from '../../api/types';
import { rootRouteRef } from '../../routes';
import { RunStrip } from '../Overview/RunStrip';
import { CopyButton } from '../CopyButton';
import { formatRelative, formatSeconds } from '../../utils/relativeTime';
import { formatActor, formatRunTime, formatUntil } from '../../utils/format';
import '../Overview/Overview.css';
import './ScheduleDetail.css';

/** Age buckets the branch table filters on, ordered by how urgent a cleanup is. */
const AGE_FILTERS = [
  { id: 'all', label: 'All', min: 0 },
  { id: '30', label: '30d+', min: 30 },
  { id: '90', label: '90d+', min: 90 },
  { id: '180', label: '180d+', min: 180 },
] as const;

type AgeFilter = (typeof AGE_FILTERS)[number]['id'];

interface BranchRow extends StaleBranch {
  /** `<project>@<branch>`, unique across projects that share a branch name. */
  id: string;
}

/**
 * A run reduced to the three numbers that say whether it looked at what it was
 * meant to look at.
 *
 * A stale count on its own cannot be read: zero is a clean estate when the run
 * covered every project, and a silent failure when it resolved none. Projects
 * and branches are the denominators that tell those apart, so they sit on the
 * same row rather than behind a click.
 */
const RunHistory = ({
  runs,
  timezone,
  selectedId,
  onSelect,
}: {
  runs: RunSummary[];
  /** The schedule's zone, so a run's weekday matches its cron line. */
  timezone: string | undefined;
  selectedId: string | null;
  onSelect: (run: RunSummary) => void;
}) => (
  <div className="sb-runs" role="table" aria-label="Run history">
    <div className="sb-run sb-run-head" role="row">
      <span />
      <span>Started</span>
      <span>Trigger</span>
      <span className="sb-num">Duration</span>
      <span className="sb-num">Projects</span>
      <span className="sb-num">Branches</span>
      <span className="sb-num">Stale</span>
    </div>

    {runs.map(run => {
      // A run that never produced a verdict has no counts, and printing three
      // zeroes would read as one that looked and found nothing.
      const counted = run.state === 'success';
      return (
        <button
          key={run.id}
          type="button"
          role="row"
          className={`sb-run${run.id === selectedId ? ' sb-run-selected' : ''}`}
          onClick={() => onSelect(run)}
        >
          <span
            className={`sb-run-dot sb-strip-${run.state}${
              run.dryRun ? ' sb-strip-dry' : ''
            }`}
            aria-hidden
          />
          <span className="sb-run-when">
            <Text as="div" variant="body-x-small">
              {formatRunTime(run.startedAt, timezone)}
            </Text>
            <Text as="div" variant="body-x-small" color="secondary">
              {formatRelative(run.startedAt)}
              {run.dryRun ? ' · dry run' : ''}
              {run.state === 'failed' ? ' · failed' : ''}
              {run.state === 'running' ? ' · running' : ''}
            </Text>
          </span>
          {/* A clock for the cron, a person for a hand on the button. The two
              are acted on differently, and a name alone does not say which of
              them it was: a schedule that only ever fires by hand is a
              schedule nobody has noticed is broken. */}
          <span className="sb-meta">
            <span className="sb-meta-icon" aria-hidden>
              {run.triggeredBy === 'schedule' ? (
                <RiTimeLine size={11} />
              ) : (
                <RiUserLine size={11} />
              )}
            </span>
            <Text variant="body-x-small" color="secondary">
              <span className="sb-visually-hidden">
                {run.triggeredBy === 'schedule'
                  ? 'Triggered on schedule: '
                  : 'Triggered by: '}
              </span>
              {formatActor(run.triggeredBy)}
            </Text>
          </span>
          <Text variant="body-x-small" color="secondary" className="sb-num">
            {run.durationMs === null
              ? '—'
              : run.durationMs < 1000
                ? `${run.durationMs}ms`
                : formatSeconds(Math.round(run.durationMs / 1000))}
          </Text>
          <Text variant="body-x-small" color="secondary" className="sb-num">
            {counted ? run.projectCount : '—'}
          </Text>
          <Text variant="body-x-small" color="secondary" className="sb-num">
            {counted ? run.totalBranches : '—'}
          </Text>
          <Text
            variant="body-x-small"
            weight="bold"
            color={
              !counted ? 'secondary' : run.staleCount > 0 ? 'warning' : 'success'
            }
            className="sb-num"
          >
            {counted ? run.staleCount : '—'}
          </Text>
        </button>
      );
    })}

    {runs.length === 0 && (
      <div className="sb-runs-empty">
        <Text variant="body-x-small" color="secondary">
          No runs yet.
        </Text>
      </div>
    )}
  </div>
);

export const ScheduleDetailPage = () => {
  const api = useApi(staleBranchesApiRef);
  const navigate = useNavigate();
  const rootPath = useRouteRef(rootRouteRef)();
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>({
    column: 'ageDays',
    direction: 'descending',
  });

  const ageFilter = (searchParams.get('age') ?? 'all') as AgeFilter;
  const runParam = searchParams.get('run');

  const { value: adminStatus } = useAsyncRetry(
    async () => api.getAdminStatus(),
    [],
  );
  const isAdmin = adminStatus?.isAdmin ?? false;

  const {
    value: schedule,
    loading: scheduleLoading,
    error: scheduleError,
    retry: retrySchedule,
  } = useAsyncRetry(async () => {
    if (!id) return undefined;
    return api.getSchedule(id);
  }, [id]);

  // A specific run when one is named in the URL, otherwise the newest finished
  // one, so a pasted link opens exactly what its author was looking at.
  const {
    value: run,
    loading: runLoading,
    retry: retryRun,
  } = useAsyncRetry(async (): Promise<RunDetail | null> => {
    if (!id) return null;
    if (runParam) return api.getRun(runParam);
    return api.getLatestRun(id);
  }, [id, runParam, schedule?.lastRun?.id]);

  const running = schedule?.running ?? false;

  // Runs are detached, so the page polls while one is in flight rather than
  // waiting on the request that started it.
  //
  // Only the schedule is polled. The run being displayed is a finished one, so
  // it cannot change until this one lands, and refetching it every two seconds
  // handed the branch table a new array each tick. That re-render made the
  // table re-measure its columns through react-aria's ResizeObserver while the
  // rest of the page was also reflowing, which is how a benign resize turns
  // into "ResizeObserver loop completed with undelivered notifications". The
  // run query already depends on `lastRun.id`, so it refetches by itself the
  // moment the new run becomes the latest.
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => retrySchedule(), 2_000);
    return () => clearInterval(timer);
  }, [running, retrySchedule]);

  const selectRun = useCallback(
    (next: RunSummary | null) => {
      const params = new URLSearchParams(searchParams);
      if (!next) params.delete('run');
      else params.set('run', next.id);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const selectAge = useCallback(
    (next: AgeFilter) => {
      const params = new URLSearchParams(searchParams);
      if (next === 'all') params.delete('age');
      else params.set('age', next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const act = useCallback(
    async (action: () => Promise<unknown>, success?: string) => {
      setBusy(true);
      setActionError(null);
      setNotice(null);
      try {
        await action();
        if (success) setNotice(success);
        retrySchedule();
        retryRun();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    },
    [retrySchedule, retryRun],
  );

  const rows: BranchRow[] = useMemo(() => {
    const all = (run?.branches ?? []).map(branch => ({
      ...branch,
      id: `${branch.projectPath}@${branch.name}`,
    }));
    const minAge = AGE_FILTERS.find(item => item.id === ageFilter)?.min ?? 0;
    const query = search.trim().toLowerCase();
    return all.filter(row => {
      if (row.ageDays < minAge) return false;
      if (!query) return true;
      return (
        row.name.toLowerCase().includes(query) ||
        row.projectPath.toLowerCase().includes(query) ||
        row.authorName.toLowerCase().includes(query) ||
        row.authorEmail.toLowerCase().includes(query)
      );
    });
  }, [run?.branches, ageFilter, search]);

  const sorted = useMemo(() => {
    const column = String(sortDescriptor.column ?? 'ageDays');
    const factor = sortDescriptor.direction === 'ascending' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = (a as unknown as Record<string, unknown>)[column];
      const right = (b as unknown as Record<string, unknown>)[column];
      if (typeof left === 'number' && typeof right === 'number') {
        return (left - right) * factor;
      }
      return String(left ?? '').localeCompare(String(right ?? '')) * factor;
    });
  }, [rows, sortDescriptor]);

  const ageCounts = useMemo(() => {
    const branches = run?.branches ?? [];
    return AGE_FILTERS.reduce<Record<string, number>>((acc, item) => {
      acc[item.id] = branches.filter(row => row.ageDays >= item.min).length;
      return acc;
    }, {});
  }, [run?.branches]);

  const columns: ColumnConfig<BranchRow>[] = useMemo(
    () => [
      {
        id: 'projectPath',
        label: 'Project',
        isSortable: true,
        defaultWidth: '1fr',
        minWidth: 160,
        cell: row => (
          <Cell>
            <Link
              href={row.projectBranchesUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={row.projectPath}
            >
              <Text variant="body-small">{row.projectPath}</Text>
            </Link>
          </Cell>
        ),
      },
      {
        id: 'name',
        label: 'Branch',
        isSortable: true,
        // react-aria names each row after its header column, and refuses to
        // build the collection without exactly one. The branch is what the row
        // is about, so it is the one that identifies it.
        isRowHeader: true,
        defaultWidth: '1.4fr',
        minWidth: 180,
        cell: row => (
          <Cell>
            <Flex align="center" gap="1" style={{ minWidth: 0 }}>
              <Link
                href={row.webUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={row.name}
              >
                <Text variant="body-small">{row.name}</Text>
              </Link>
              {/* A merged branch is the safest thing on the list to delete, so
                  it is called out rather than left to the reader to check.

                  Tag is a collection item, so it only renders inside the group
                  that owns it. The group is conditional as a whole rather than
                  per tag, since an empty one would still draw its own box. */}
              {(row.merged || row.isProtected) && (
                <TagGroup>
                  {row.merged && (
                    <Tag id={`${row.id}-merged`} size="small">
                      merged
                    </Tag>
                  )}
                    </TagGroup>
              )}
              {/* A branch name is what gets pasted into a `git push --delete`,
                  and these are long enough that selecting one by hand catches
                  the tags beside it. The link stays the way to look, this is
                  the way to take it with you. */}
              <CopyButton
                value={row.name}
                subject="branch name"
                className="sb-copy"
              />
            </Flex>
          </Cell>
        ),
      },
      {
        id: 'lastCommitAt',
        label: 'Last Commit',
        isSortable: true,
        defaultWidth: 150,
        minWidth: 130,
        cell: row => (
          <Cell>
            <Text
              variant="body-small"
              title={new Date(row.lastCommitAt).toLocaleString()}
            >
              {formatRelative(row.lastCommitAt)}
            </Text>
          </Cell>
        ),
      },
      {
        id: 'ageDays',
        label: 'Age',
        isSortable: true,
        defaultWidth: 90,
        minWidth: 80,
        cell: row => (
          <Cell>
            {/* Sits beside the timestamp it is derived from, so the reader can
                see the date and what it adds up to without crossing the row.
                The age carries the severity colour, since it is the verdict
                and the date is only its evidence. */}
            <Text
              variant="body-small"
              weight="bold"
              color={
                row.ageDays >= 180
                  ? 'danger'
                  : row.ageDays >= 90
                    ? 'warning'
                    : undefined
              }
              title={new Date(row.lastCommitAt).toLocaleString()}
            >
              {row.ageDays}d
            </Text>
          </Cell>
        ),
      },
      {
        id: 'authorName',
        label: 'Last Author',
        isSortable: true,
        defaultWidth: '1fr',
        minWidth: 160,
        cell: row => (
          <Cell>
            <Flex direction="column" gap="0.5" style={{ minWidth: 0 }}>
              <Text variant="body-small" title={row.authorName}>
                {row.authorName}
              </Text>
              {row.authorEmail && (
                <Text
                  variant="body-x-small"
                  color="secondary"
                  title={row.authorEmail}
                >
                  {row.authorEmail}
                </Text>
              )}
            </Flex>
          </Cell>
        ),
      },
    ],
    [],
  );

  const header = (
    <PluginHeader
      icon={<RiBrush3Line />}
      title={schedule?.name ?? 'Schedule'}
      customActions={
        <TagGroup>
          <Tag id="plugin-id" size="small">
            {staleBranchesPlugin.getId()}
          </Tag>
        </TagGroup>
      }
    />
  );

  if (scheduleError) {
    return (
      <>
        {header}
        <Container my="4">
          <Alert status="danger" title={scheduleError.message} />
        </Container>
      </>
    );
  }

  if (scheduleLoading && !schedule) {
    return (
      <>
        {header}
        <Container my="4">
          <Text>Loading…</Text>
        </Container>
      </>
    );
  }

  const isLatest = !runParam;

  return (
    <>
      {header}
      <Container my="4">
        <Flex justify="between" align="start" gap="3" style={{ flexWrap: 'wrap' }}>
          <Flex direction="column" gap="1">
            <button
              type="button"
              className="sb-back"
              onClick={() => navigate(rootPath)}
            >
              <RiArrowLeftLine size={13} aria-hidden />
              All schedules
            </button>
            <Flex align="center" gap="2" style={{ flexWrap: 'wrap' }}>
              <code className="sb-cron">{schedule?.cron}</code>
              <Text variant="body-x-small" color="secondary">
                {schedule?.timezone}
              </Text>
              <Text variant="body-x-small" color="secondary">
                ·{' '}
                {schedule?.enabled
                  ? `next ${formatUntil(schedule?.nextRunAt ?? null)}`
                  : 'paused'}
              </Text>
              <Text variant="body-x-small" color="secondary">
                · {schedule?.projectNames.length} projects ·{' '}
                {schedule?.thresholdDays}d threshold
              </Text>
              {/* The URL is only ever masked, so the label is what tells a
                  reader where Send report is about to post. */}
              {schedule?.webhookEnabled && (
                <Text variant="body-x-small" color="secondary">
                  · reports to{' '}
                  {schedule.webhookDescription ??
                    schedule.webhookUrlMasked ??
                    'Slack'}
                </Text>
              )}
            </Flex>
            {schedule?.description && (
              <Text variant="body-x-small" color="secondary">
                {schedule.description}
              </Text>
            )}
          </Flex>

          {isAdmin && (
            <Flex gap="2" align="center">
              <Button
                variant="secondary"
                isDisabled={busy || running}
                onPress={() => act(() => api.triggerSchedule(id!))}
              >
                <Flex align="center" gap="1">
                  <RiPlayLine size={15} />
                  {running ? 'Running…' : 'Run now'}
                </Flex>
              </Button>
              {/* Scans and records like a real run, but sends nothing and
                  leaves the dedupe log alone, so a new schedule can be checked
                  without putting anything in front of a team. */}
              <Button
                variant="secondary"
                isDisabled={busy || running}
                onPress={() =>
                  act(
                    () => api.triggerSchedule(id!, true),
                    'Dry run started. It will not send anything.',
                  )
                }
              >
                <Flex align="center" gap="1">
                  <RiFlaskLine size={15} />
                  Dry run
                </Flex>
              </Button>
              <Button
                variant="secondary"
                isDisabled={busy || !schedule?.webhookEnabled}
                onPress={() =>
                  act(async () => {
                    const result = await api.notify(id!);
                    // One message per branch, so the count is messages sent,
                    // not one report covering that many branches.
                    setNotice(
                      result.sent === 0
                        ? `Nothing new to report, ${result.skipped} already notified.`
                        : `Sent ${result.sent} messages, skipping ${result.skipped} already notified${
                            result.failed > 0 ? `, ${result.failed} failed` : ''
                          }.`,
                    );
                  })
                }
              >
                <Flex align="center" gap="1">
                  <RiSendPlaneLine size={15} />
                  Send report
                </Flex>
              </Button>
              <button
                type="button"
                className="sb-icon-button"
                aria-label="Edit schedule"
                title="Edit"
                onClick={() => navigate(`${rootPath}/schedules/${id}/edit`)}
              >
                <RiEditLine size={15} />
              </button>
            </Flex>
          )}
        </Flex>

        {(actionError || notice) && (
          <Box mt="3">
            <Alert
              status={actionError ? 'danger' : 'success'}
              title={actionError ?? notice ?? ''}
            />
          </Box>
        )}

        <Box mt="3">
          <RunStrip
            runs={schedule?.recentRuns ?? []}
            timezone={schedule?.timezone}
            onSelect={selectRun}
          />
        </Box>

        <Box className="sb-panel" mt="3">
          <Text as="div" variant="body-small" weight="bold">
            {isLatest ? 'Latest result' : 'Selected run'}
          </Text>
          {run ? (
            <Flex direction="column" gap="1" mt="2">
              <Flex align="baseline" gap="2">
                <Text
                  variant="title-medium"
                  weight="bold"
                  color={
                    run.state === 'failed'
                      ? 'danger'
                      : run.staleCount === 0
                        ? 'success'
                        : 'warning'
                  }
                >
                  {run.state === 'failed' ? 'Failed' : run.staleCount}
                </Text>
                {run.state !== 'failed' && (
                  <Text variant="body-x-small" color="secondary">
                    stale of {run.totalBranches} branches across{' '}
                    {run.projectCount} projects
                  </Text>
                )}
              </Flex>
              <Text variant="body-x-small" color="secondary">
                {/* Same zone as the cron shown in the header, so a run and the
                    schedule that produced it are read on one clock. */}
                {formatRunTime(run.startedAt, schedule?.timezone)} ·{' '}
                {formatActor(run.triggeredBy)}
                {run.durationMs !== null
                  ? ` · ${formatSeconds(Math.round(run.durationMs / 1000))}`
                  : ''}
                {/* The same number means two different things depending on the
                    flag, so it never appears without its qualifier. */}
                {run.notifiedCount > 0
                  ? run.dryRun
                    ? ` · ${run.notifiedCount} would have been sent`
                    : ` · ${run.notifiedCount} posted to Slack`
                  : ''}
              </Text>
              {run.dryRun && (
                <Text variant="body-x-small" color="secondary">
                  Dry run. Nothing was sent, and nothing was marked as reported.
                </Text>
              )}
              {run.error && (
                <Text variant="body-x-small" color="danger">
                  {run.error}
                </Text>
              )}
              {/* A name that matched nothing is a settings typo, and would
                  otherwise look like a project with no stale branches. */}
              {run.unresolvedProjects.length > 0 && (
                <Text variant="body-x-small" color="warning">
                  {run.unresolvedProjects.length} configured projects matched
                  nothing: {run.unresolvedProjects.join(', ')}
                </Text>
              )}
              {run.projects.some(project => project.error) && (
                <Text variant="body-x-small" color="warning">
                  {run.projects
                    .filter(project => project.error)
                    .map(project => `${project.path}: ${project.error}`)
                    .join(' · ')}
                </Text>
              )}
            </Flex>
          ) : (
            <Text variant="body-x-small" color="secondary">
              {runLoading ? 'Loading…' : 'This schedule has not finished a run.'}
            </Text>
          )}
        </Box>

        {/* Full width rather than beside the result: seven columns of counts
            need the room, and the history is what a reader scans down. */}
        <Box className="sb-panel" mt="3">
          <Flex justify="between" align="center">
            <Text variant="body-small" weight="bold">
              Run history
            </Text>
            {!isLatest && (
              <button
                type="button"
                className="sb-link-button"
                onClick={() => selectRun(null)}
              >
                Show latest
              </button>
            )}
          </Flex>
          <RunHistory
            runs={schedule?.recentRuns ?? []}
            timezone={schedule?.timezone}
            selectedId={run?.id ?? null}
            onSelect={selectRun}
          />
        </Box>

        <Box mt="4">
          <Flex justify="between" align="center" gap="2" style={{ flexWrap: 'wrap' }}>
            <Flex gap="1" align="center" style={{ flexWrap: 'wrap' }}>
              {AGE_FILTERS.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`sb-chip${ageFilter === item.id ? ' sb-chip-selected' : ''}`}
                  onClick={() => selectAge(item.id)}
                >
                  {item.label}
                  <span className="sb-chip-count">{ageCounts[item.id] ?? 0}</span>
                </button>
              ))}
            </Flex>
            {!searchOpen && !search ? (
              <button
                type="button"
                className="sb-icon-button"
                aria-label="Search branches"
                onClick={() => setSearchOpen(true)}
              >
                <RiSearchLine size={16} />
              </button>
            ) : (
              <span className="sb-search-open">
                <RiSearchLine size={14} className="sb-search-icon" aria-hidden />
                <input
                  className="sb-search-input"
                  aria-label="Search branches"
                  placeholder="Branch, project or author"
                  value={search}
                  autoFocus
                  onChange={event => setSearch(event.target.value)}
                  onBlur={() => {
                    if (!search) setSearchOpen(false);
                  }}
                />
              </span>
            )}
          </Flex>
        </Box>

        <Box mt="3">
          <Box style={{ overflowX: 'auto', width: '100%' }} className="sb-branch-table">
            <Table<BranchRow>
              data={sorted}
              loading={runLoading}
              columnConfig={columns}
              // The age chips and the search already narrow the list, and a
              // cleanup is worked top down, so the table scrolls rather than
              // hiding the tail behind a page control.
              pagination={{ type: 'none' }}
              sort={{
                descriptor: sortDescriptor,
                onSortChange: setSortDescriptor,
              }}
              emptyState={
                <Text variant="body-small" color="secondary">
                  {run
                    ? 'No branch matches the current filter.'
                    : 'No run to show yet.'}
                </Text>
              }
            />
          </Box>
        </Box>
      </Container>
    </>
  );
};
