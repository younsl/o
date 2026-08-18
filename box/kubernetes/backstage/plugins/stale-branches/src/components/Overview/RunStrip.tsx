import React from 'react';
import { Focusable, Text, Tooltip, TooltipTrigger } from '@backstage/ui';
import { RunSummary } from '../../api/types';
import { formatRelative, formatSeconds } from '../../utils/relativeTime';
import { RUN_STATE_LABELS, formatActor, formatRunTime } from '../../utils/format';

/** Slots the strip always draws, so every row lines up regardless of history. */
const SLOTS = 12;

/** Long enough not to fire while the pointer crosses the strip. */
const HOVER_DELAY_MS = 200;

const Row = ({ label, value }: { label: string; value: string }) => (
  <>
    <Text variant="body-x-small" color="secondary">
      {label}
    </Text>
    <Text variant="body-x-small">{value}</Text>
  </>
);

/**
 * What one square stands for, opened on hover or focus.
 *
 * A square can only carry two facts, its colour and its position, and the run
 * behind it has half a dozen worth reading. The native `title` attribute could
 * hold them but arrives after about a second, renders as unstyled text, and
 * never appears for a keyboard user.
 */
const RunCard = ({
  run,
  timezone,
}: {
  run: RunSummary;
  timezone: string | undefined;
}) => (
  <div className="sb-runcard">
    <div className="sb-runcard-head">
      <span className={`sb-run-dot sb-strip-${run.state}`} aria-hidden />
      <Text variant="body-small" weight="bold">
        {RUN_STATE_LABELS[run.state]}
      </Text>
      {run.dryRun && (
        <span className="sb-runcard-tag">
          <Text variant="body-x-small">dry run</Text>
        </span>
      )}
      <Text variant="body-x-small" color="secondary">
        {formatRelative(run.startedAt)}
      </Text>
    </div>

    <div className="sb-runcard-grid">
      <Row label="Started" value={formatRunTime(run.startedAt, timezone)} />
      <Row label="Trigger" value={formatActor(run.triggeredBy)} />
      {run.durationMs !== null && (
        <Row
          label="Duration"
          value={
            run.durationMs < 1000
              ? `${run.durationMs}ms`
              : formatSeconds(Math.round(run.durationMs / 1000))
          }
        />
      )}
      {run.state === 'success' && (
        <>
          <Row
            label="Stale"
            value={`${run.staleCount} of ${run.totalBranches} branches`}
          />
          <Row label="Projects" value={String(run.projectCount)} />
          {/* Only worth a line when something was actually posted: a schedule
              with no webhook would otherwise always read "0 messages". The
              same number means two different things depending on the flag, so
              it never appears without its qualifier. */}
          {run.notifiedCount > 0 && (
            <Row
              label={run.dryRun ? 'Would send' : 'Slack'}
              value={`${run.notifiedCount} ${
                run.notifiedCount === 1 ? 'message' : 'messages'
              }`}
            />
          )}
        </>
      )}
      {run.state === 'running' && (
        <Row label="Progress" value="still scanning" />
      )}
    </div>

    {run.dryRun && (
      <Text variant="body-x-small" color="secondary" className="sb-runcard-note">
        Nothing was sent, and nothing was marked as reported.
      </Text>
    )}

    {run.error && (
      <Text variant="body-x-small" color="danger" className="sb-runcard-error">
        {run.error}
      </Text>
    )}
  </div>
);

/**
 * The run history as one square per run, oldest on the left.
 *
 * A column of numbers hides the pattern that matters here, which is whether a
 * schedule has been failing for a while or failed once. Fixed slot count keeps
 * the newest run at the same x position on every row, so the right hand edge
 * reads as "now" down the whole list, and every strip is the same width no
 * matter how much history it has. An empty strip needs no caption: the row
 * already says "never run" in its own column.
 */
export const RunStrip = ({
  runs,
  timezone,
  onSelect,
}: {
  runs: RunSummary[];
  /** The schedule's zone, so a run's weekday matches its cron line. */
  timezone?: string;
  onSelect?: (run: RunSummary) => void;
}) => {
  // The API returns newest first; the strip reads left to right in time order.
  const ordered = [...runs].slice(0, SLOTS).reverse();
  const padding = Math.max(0, SLOTS - ordered.length);

  return (
    <div className="sb-strip" role="list" aria-label="Recent runs">
      {Array.from({ length: padding }, (_, index) => (
        <span key={`empty-${index}`} className="sb-strip-slot sb-strip-empty" />
      ))}
      {ordered.map(run => (
        <TooltipTrigger key={run.id} delay={HOVER_DELAY_MS}>
          {/* Focusable is what gives a plain element the hover and focus props
              the tooltip listens on, without dragging in a Button's styling. */}
          <Focusable>
            <button
              type="button"
              role="listitem"
              className={`sb-strip-slot sb-strip-${run.state}${
                run.dryRun ? ' sb-strip-dry' : ''
              }`}
              aria-label={`${RUN_STATE_LABELS[run.state]}${
                run.dryRun ? ' dry' : ''
              } run, ${formatRelative(run.startedAt)}, ${
                run.staleCount
              } stale branches`}
              onClick={() => onSelect?.(run)}
            />
          </Focusable>
          {/* Centred above the square. A 10px trigger under a card this wide
              leaves the placement entirely to the overlay engine, so the
              anchor and the gap are stated rather than inherited. */}
          <Tooltip
            className="sb-runcard-tooltip"
            placement="top"
            offset={8}
            containerPadding={12}
          >
            <RunCard run={run} timezone={timezone} />
          </Tooltip>
        </TooltipTrigger>
      ))}
    </div>
  );
};
