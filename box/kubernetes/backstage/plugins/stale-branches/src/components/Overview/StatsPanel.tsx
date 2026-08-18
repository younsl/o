import React from 'react';
import { Box, Flex, Text } from '@backstage/ui';
import { OverviewStats } from '../../api/types';
import { formatRelative } from '../../utils/relativeTime';

/** Colour per age band, darkening as a branch gets older. */
const BUCKET_TONE: Record<string, string> = {
  recent: 'sb-band-recent',
  month: 'sb-band-month',
  quarter: 'sb-band-quarter',
  stale: 'sb-band-stale',
};

const Tile = ({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'success' | 'warning' | 'danger';
}) => (
  <div className="sb-tile">
    <Text as="div" variant="body-x-small" color="secondary">
      {label}
    </Text>
    <Text
      as="div"
      variant="title-medium"
      weight="bold"
      color={tone}
      className="sb-tile-value"
    >
      {value}
    </Text>
    {hint && (
      <Text as="div" variant="body-x-small" color="secondary">
        {hint}
      </Text>
    )}
  </div>
);

/**
 * The two facts the schedule table below cannot show, and nothing else.
 *
 * Everything here is read off the newest successful run of each schedule, so a
 * schedule that has never finished contributes nothing. That is worth saying
 * rather than letting a total look like a clean estate, so it rides on the
 * stale tile instead of taking a panel of its own.
 *
 * Schedule counts, per-schedule totals and run outcomes used to sit here too.
 * Each of them is already on a row of the table underneath, in the pause
 * toggle, the last-run cell and the run strip, so repeating them cost a panel
 * and told the reader nothing new.
 */
export const StatsPanel = ({ stats }: { stats: OverviewStats }) => {
  const bandTotal = stats.ageBuckets.reduce(
    (sum, bucket) => sum + bucket.count,
    0,
  );
  const ratio =
    stats.totalBranches > 0
      ? Math.round((stats.staleCount * 100) / stats.totalBranches)
      : 0;

  return (
    <Flex direction="column" gap="3">
      <div className="sb-tiles">
        <Tile
          label="Stale branches"
          value={stats.staleCount}
          hint={
            stats.neverRunCount > 0
              ? `${ratio}% of ${stats.totalBranches} branches · ${
                  stats.neverRunCount === 1
                    ? '1 schedule has'
                    : `${stats.neverRunCount} schedules have`
                } no result yet`
              : `${ratio}% of ${stats.totalBranches} branches across ${stats.projectCount} projects`
          }
          tone={stats.staleCount === 0 ? 'success' : 'warning'}
        />
        <Tile
          label="Oldest branch"
          value={stats.oldestAgeDays > 0 ? `${stats.oldestAgeDays}d` : '—'}
          hint={
            stats.lastRunAt
              ? `last run ${formatRelative(stats.lastRunAt)}`
              : 'no run has finished'
          }
          tone={stats.oldestAgeDays >= 180 ? 'danger' : undefined}
        />
      </div>

      {bandTotal > 0 && (
        <Box className="sb-panel">
          <Text as="div" variant="body-small" weight="bold">
            Age distribution
          </Text>
          {/* One bar rather than four, so the bands are compared by width
              against each other instead of against an axis nobody reads. */}
          <div
            className="sb-band-bar"
            role="img"
            aria-label={stats.ageBuckets
              .map(bucket => `${bucket.label}: ${bucket.count}`)
              .join(', ')}
          >
            {stats.ageBuckets
              .filter(bucket => bucket.count > 0)
              .map(bucket => (
                <span
                  key={bucket.id}
                  className={`sb-band ${BUCKET_TONE[bucket.id] ?? ''}`}
                  style={{ flexGrow: bucket.count }}
                  title={`${bucket.label}: ${bucket.count}`}
                />
              ))}
          </div>
          <Flex gap="3" mt="2" style={{ flexWrap: 'wrap' }}>
            {stats.ageBuckets.map(bucket => (
              <span key={bucket.id} className="sb-legend">
                <span
                  className={`sb-legend-dot ${BUCKET_TONE[bucket.id] ?? ''}`}
                  aria-hidden
                />
                <Text variant="body-x-small" color="secondary">
                  {bucket.label}
                </Text>
                <Text variant="body-x-small" weight="bold">
                  {bucket.count}
                </Text>
              </span>
            ))}
          </Flex>
        </Box>
      )}
    </Flex>
  );
};
