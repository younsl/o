import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Container,
  Flex,
  PluginHeader,
  Tag,
  TagGroup,
  Text,
} from '@backstage/ui';
import {
  RiAddLine,
  RiBrush3Line,
  RiDeleteBinLine,
  RiEditLine,
  RiGitBranchLine,
  RiPlugLine,
  RiPlayLine,
  RiTimeLine,
  RiUserLine,
} from '@remixicon/react';
import { useApi, useRouteRef } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { staleBranchesPlugin } from '../../plugin';
import { staleBranchesApiRef } from '../../api';
import { ScheduleSummary } from '../../api/types';
import { rootRouteRef } from '../../routes';
import { RunStrip } from './RunStrip';
import { StatsPanel } from './StatsPanel';
import { ConfirmDialog } from '../ConfirmDialog';
import { formatRelative } from '../../utils/relativeTime';
import { formatActor, formatUntil } from '../../utils/format';
import './Overview.css';

/** Poll cadence while any schedule has a run in flight. */
const POLL_MS = 2_000;

/**
 * An icon and its value, with the label the icon replaces kept for screen
 * readers. Two of these read faster in a narrow cell than one string joined by
 * separators, because the icon carries the field name that the separator was
 * only dividing.
 */
const Meta = ({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) => (
  <span className="sb-meta" title={`${label}: ${value}`}>
    <span className="sb-meta-icon" aria-hidden>
      {icon}
    </span>
    <Text variant="body-x-small" color="secondary">
      <span className="sb-visually-hidden">{label}: </span>
      {value}
    </Text>
  </span>
);

const ScheduleRow = ({
  schedule,
  isAdmin,
  onOpen,
  onOpenRun,
  onEdit,
  onDelete,
  onTrigger,
  busy,
}: {
  schedule: ScheduleSummary;
  isAdmin: boolean;
  onOpen: () => void;
  onOpenRun: (runId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onTrigger: () => void;
  busy: boolean;
}) => {
  const lastRun = schedule.lastRun;
  const progress = schedule.progress;

  return (
    <div
      className={`sb-row${schedule.enabled ? '' : ' sb-row-paused'}`}
      data-testid={`schedule-${schedule.id}`}
    >
      {/* State, not a control. Pausing a schedule changes what fires without
          anyone watching, so it is made where the rest of the schedule is
          changed and reviewed, not by a switch a stray click can flip. */}
      <div className="sb-row-status">
        <span
          className={`sb-status-dot${schedule.enabled ? '' : ' sb-status-off'}`}
          aria-hidden
        />
        <Text variant="body-x-small" color="secondary">
          {schedule.enabled ? 'Active' : 'Paused'}
        </Text>
      </div>

      <button type="button" className="sb-row-name" onClick={onOpen}>
        <Text as="div" variant="body-small" weight="bold">
          {schedule.name}
        </Text>
        <Text as="div" variant="body-x-small" color="secondary">
          {schedule.description ??
            `${schedule.projectNames.length} projects · ${schedule.thresholdDays}d threshold`}
        </Text>
      </button>

      {/* Who registered the scan. A schedule that fires into a channel nobody
          owns is the one that goes stale itself, so the name sits on the row
          rather than behind an edit form. */}
      <div className="sb-row-cell sb-row-owner">
        <Text variant="body-x-small" color="secondary">
          {schedule.createdBy ? formatActor(schedule.createdBy) : '—'}
        </Text>
      </div>

      <div className="sb-row-strip">
        {/* A square is the only place a past run is visible from the list, so
            clicking one opens the schedule on exactly that run rather than on
            whatever the newest one happens to be. */}
        <RunStrip
          runs={schedule.recentRuns}
          timezone={schedule.timezone}
          onSelect={run => onOpenRun(run.id)}
        />
      </div>

      <div className="sb-row-cron">
        <code className="sb-cron">{schedule.cron}</code>
        <Text variant="body-x-small" color="secondary">
          {schedule.timezone}
        </Text>
      </div>

      <div className="sb-row-cell">
        {/* A run in flight replaces the last-run cell, since that is the fact
            the reader is waiting on and it resolves on its own. */}
        {schedule.running ? (
          <Flex align="center" gap="1">
            <span className="sb-spinner" aria-hidden />
            <Text variant="body-x-small" color="secondary">
              {!progress || progress.phase === 'resolving' || progress.total === 0
                ? 'resolving projects'
                : `${progress.done}/${progress.total} projects`}
            </Text>
          </Flex>
        ) : lastRun ? (
          <Flex direction="column" gap="0.5">
            <Text
              variant="body-x-small"
              color={lastRun.state === 'failed' ? 'danger' : undefined}
            >
              {formatRelative(lastRun.startedAt)}
            </Text>
            <span className="sb-meta-row">
              {lastRun.state === 'failed' ? (
                <Text variant="body-x-small" color="danger">
                  failed
                </Text>
              ) : (
                <Meta
                  icon={<RiGitBranchLine size={11} />}
                  label="Stale branches"
                  value={String(lastRun.staleCount)}
                />
              )}
              {/* A clock for the cron, a person for a hand on the button: the
                  two are read differently, and the name alone does not say
                  which of them it was. */}
              <Meta
                icon={
                  lastRun.triggeredBy === 'schedule' ? (
                    <RiTimeLine size={11} />
                  ) : (
                    <RiUserLine size={11} />
                  )
                }
                label="Triggered by"
                value={formatActor(lastRun.triggeredBy)}
              />
            </span>
          </Flex>
        ) : (
          <Text variant="body-x-small" color="secondary">
            never run
          </Text>
        )}
      </div>

      <div className="sb-row-cell sb-col-next">
        <Text
          variant="body-x-small"
          color={schedule.enabled ? undefined : 'secondary'}
        >
          {formatUntil(schedule.nextRunAt)}
        </Text>
      </div>

      {isAdmin && (
        <div className="sb-row-actions">
          <button
            type="button"
            className="sb-icon-button"
            aria-label={`Run ${schedule.name} now`}
            title="Run now"
            disabled={busy || schedule.running}
            onClick={onTrigger}
          >
            <RiPlayLine size={15} />
          </button>
          <button
            type="button"
            className="sb-icon-button"
            aria-label={`Edit ${schedule.name}`}
            title="Edit"
            onClick={onEdit}
          >
            <RiEditLine size={15} />
          </button>
          <button
            type="button"
            className="sb-icon-button sb-icon-danger"
            aria-label={`Delete ${schedule.name}`}
            title="Delete"
            disabled={busy || schedule.running}
            onClick={onDelete}
          >
            <RiDeleteBinLine size={15} />
          </button>
        </div>
      )}
    </div>
  );
};

export const OverviewPage = () => {
  const api = useApi(staleBranchesApiRef);
  const navigate = useNavigate();
  const rootPath = useRouteRef(rootRouteRef)();

  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduleSummary | null>(
    null,
  );

  const {
    value: data,
    loading,
    error,
    retry,
  } = useAsyncRetry(async () => api.listSchedules(), []);

  const { value: adminStatus } = useAsyncRetry(
    async () => api.getAdminStatus(),
    [],
  );
  const isAdmin = adminStatus?.isAdmin ?? false;

  const anyRunning = (data?.schedules ?? []).some(schedule => schedule.running);

  // Runs are detached, so the page polls while one is in flight rather than
  // waiting on the request that started it.
  useEffect(() => {
    if (!anyRunning) return undefined;
    const id = setInterval(() => retry(), POLL_MS);
    return () => clearInterval(id);
  }, [anyRunning, retry]);

  const withBusy = useCallback(
    async (id: string, action: () => Promise<unknown>) => {
      setBusyId(id);
      setActionError(null);
      try {
        await action();
        retry();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setBusyId(null);
      }
    },
    [retry],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    await withBusy(target.id, () => api.deleteSchedule(target.id));
  }, [api, pendingDelete, withBusy]);

  const schedules = data?.schedules ?? [];

  return (
    <>
      <PluginHeader
        icon={<RiBrush3Line />}
        title="Stale Branch"
        customActions={
          <TagGroup>
            <Tag id="plugin-id" size="small">
              {staleBranchesPlugin.getId()}
            </Tag>
          </TagGroup>
        }
      />
      <Container my="4">
        <Flex justify="between" align="start" gap="3" style={{ flexWrap: 'wrap' }}>
          <Text variant="body-medium" color="secondary">
            Each schedule scans its own projects on its own cron and reports the
            branches nobody has pushed to.
          </Text>
          {isAdmin && (
            <Flex gap="2" align="center">
              <Button
                variant="secondary"
                onPress={() => navigate(`${rootPath}/connection`)}
              >
                <Flex align="center" gap="1">
                  <RiPlugLine size={15} />
                  GitLab connection
                </Flex>
              </Button>
              {/* Creating is a deliberate step, so the list never doubles as a
                  form and the button is the only way in. */}
              <Button
                variant="primary"
                onPress={() => navigate(`${rootPath}/new`)}
              >
                <Flex align="center" gap="1">
                  <RiAddLine size={16} />
                  New schedule
                </Flex>
              </Button>
            </Flex>
          )}
        </Flex>

        {data && !data.connected && (
          <Box mt="3">
            <Alert
              status="warning"
              title="GitLab connection is not set up"
              description={
                isAdmin
                  ? 'Schedules cannot run until an API URL and token are saved under GitLab connection.'
                  : 'Ask a Backstage administrator to finish the setup.'
              }
            />
          </Box>
        )}

        {(actionError || error) && (
          <Box mt="3">
            <Alert
              status="danger"
              title={actionError ?? error?.message ?? 'Something went wrong'}
            />
          </Box>
        )}

        {data && (
          <Box mt="4">
            <StatsPanel stats={data.stats} />
          </Box>
        )}

        <Box mt="4">
          <Flex justify="between" align="center" gap="2">
            <Text variant="body-small" weight="bold">
              Schedules
            </Text>
            <Text variant="body-x-small" color="secondary">
              Newest run on the right
            </Text>
          </Flex>

          <div
            className={`sb-table${isAdmin ? '' : ' sb-table-readonly'}`}
            role="table"
            aria-label="Schedules"
          >
            <div className="sb-row sb-head" role="row">
              <span className="sb-row-status">Status</span>
              <span>Name</span>
              <span>Owner</span>
              <span className="sb-row-strip">Runs</span>
              <span className="sb-row-cron">Schedule</span>
              <span>Last run</span>
              <span className="sb-col-next">Next run</span>
              {isAdmin && <span className="sb-row-actions">Actions</span>}
            </div>

            {loading && schedules.length === 0 && (
              <div className="sb-empty">
                <Text variant="body-small" color="secondary">
                  Loading…
                </Text>
              </div>
            )}

            {!loading && schedules.length === 0 && (
              <div className="sb-empty">
                <Text as="div" variant="body-small" color="secondary">
                  No schedules yet.
                </Text>
                <Text as="div" variant="body-x-small" color="secondary">
                  {isAdmin
                    ? 'Use New schedule to register the first scan.'
                    : 'A Backstage administrator can register one.'}
                </Text>
              </div>
            )}

            {schedules.map(schedule => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                isAdmin={isAdmin}
                busy={busyId === schedule.id}
                onOpen={() =>
                  navigate(`${rootPath}/schedules/${schedule.id}`)
                }
                onOpenRun={runId =>
                  navigate(`${rootPath}/schedules/${schedule.id}?run=${runId}`)
                }
                onEdit={() =>
                  navigate(`${rootPath}/schedules/${schedule.id}/edit`)
                }
                onDelete={() => setPendingDelete(schedule)}
                onTrigger={() =>
                  withBusy(schedule.id, () => api.triggerSchedule(schedule.id))
                }
              />
            ))}
          </div>
        </Box>
      </Container>

      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete ${pendingDelete?.name ?? ''}?`}
        description="The schedule, its run history, and its notification records are removed. The branches in GitLab are not touched."
        confirmLabel="Delete"
        destructive
        // Nothing here can be undone and the rows look alike, so the name has
        // to be typed rather than the dialog merely dismissed.
        requireText={pendingDelete?.name}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
};
