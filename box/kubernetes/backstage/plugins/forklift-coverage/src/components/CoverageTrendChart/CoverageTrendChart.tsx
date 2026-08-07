import React, { useMemo, useState } from 'react';
import { Flex, Text } from '@backstage/ui';
import { CoverageSnapshot } from '../../api/types';

const VIEW_W = 720;
const VIEW_H = 300;
const PAD = { top: 16, right: 16, bottom: 34, left: 36 };

const APPLIED_COLOR = '#10b981';
const PARTIAL_COLOR = '#f59e0b';

const INNER_W = VIEW_W - PAD.left - PAD.right;
const INNER_H = VIEW_H - PAD.top - PAD.bottom;

const formatDay = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

const withPartialPercent = (s: CoverageSnapshot): number =>
  s.target > 0 ? Math.round(((s.applied + s.partial) / s.target) * 100) : 0;

/** One point per day, keeping the latest scan of each date. */
const dedupeByDay = (items: CoverageSnapshot[]): CoverageSnapshot[] => {
  const map = new Map<string, CoverageSnapshot>();
  for (const s of items) map.set(s.scannedAt.slice(0, 10), s);
  return Array.from(map.values()).sort(
    (a, b) =>
      new Date(a.scannedAt).getTime() - new Date(b.scannedAt).getTime(),
  );
};

interface Point {
  x: number;
  y: number;
  snapshot: CoverageSnapshot;
  applied: number;
  partial: number;
}

/**
 * Time series over the real timestamps, so a gap in scanning shows as a gap on
 * the axis rather than being collapsed into evenly spaced bars.
 */
export const CoverageTrendChart = ({
  snapshots: rawSnapshots,
}: {
  snapshots: CoverageSnapshot[];
}) => {
  const snapshots = useMemo(() => dedupeByDay(rawSnapshots), [rawSnapshots]);
  const [hover, setHover] = useState<number | null>(null);

  const { appliedPoints, partialPoints, xTicks } = useMemo(() => {
    if (snapshots.length === 0) {
      return { appliedPoints: [], partialPoints: [], xTicks: [] as Point[] };
    }

    const times = snapshots.map(s => new Date(s.scannedAt).getTime());
    const min = Math.min(...times);
    const max = Math.max(...times);
    // A single sample, or several within one day, would divide by zero.
    const span = max - min || 1;
    const xOf = (t: number) =>
      snapshots.length === 1 ? INNER_W / 2 : ((t - min) / span) * INNER_W;
    const yOf = (percent: number) => INNER_H - (percent / 100) * INNER_H;

    const applied: Point[] = snapshots.map((s, i) => ({
      x: xOf(times[i]),
      y: yOf(s.percent),
      snapshot: s,
      applied: s.percent,
      partial: withPartialPercent(s),
    }));
    const partial: Point[] = snapshots.map((s, i) => ({
      x: xOf(times[i]),
      y: yOf(withPartialPercent(s)),
      snapshot: s,
      applied: s.percent,
      partial: withPartialPercent(s),
    }));

    // Cap the label count so dense histories do not overlap on the axis.
    const step = Math.max(1, Math.ceil(applied.length / 8));
    const ticks = applied.filter((_, i) => i % step === 0 || i === applied.length - 1);

    return { appliedPoints: applied, partialPoints: partial, xTicks: ticks };
  }, [snapshots]);

  if (snapshots.length === 0) {
    return (
      <Flex align="center" justify="center" style={{ minHeight: 200 }}>
        <Text variant="body-small" color="secondary">
          No trend data yet. History builds up one point per scan.
        </Text>
      </Flex>
    );
  }

  const line = (points: Point[]) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const area = (points: Point[]) =>
    `${line(points)} L${points[points.length - 1].x},${INNER_H} L${points[0].x},${INNER_H} Z`;

  const active = hover !== null ? appliedPoints[hover] : null;

  return (
    <Flex direction="column" gap="2">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        width="100%"
        height={VIEW_H}
        style={{ display: 'block', maxWidth: '100%' }}
        role="img"
        aria-label="Coverage over time"
      >
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {[0, 25, 50, 75, 100].map(tick => {
            const y = INNER_H - (tick / 100) * INNER_H;
            return (
              <g key={tick}>
                <line
                  x1={0}
                  y1={y}
                  x2={INNER_W}
                  y2={y}
                  stroke="var(--bui-color-border-default, #333)"
                  strokeDasharray="3,3"
                />
                <text
                  x={-8}
                  y={y + 4}
                  textAnchor="end"
                  fill="var(--bui-color-text-secondary, #888)"
                  fontSize={10}
                  fontFamily="inherit"
                >
                  {tick}%
                </text>
              </g>
            );
          })}

          {appliedPoints.length > 1 && (
            <>
              <path d={area(appliedPoints)} fill={APPLIED_COLOR} opacity={0.12} />
              <path
                d={line(partialPoints)}
                fill="none"
                stroke={PARTIAL_COLOR}
                strokeWidth={1.5}
                strokeDasharray="4,3"
              />
              <path
                d={line(appliedPoints)}
                fill="none"
                stroke={APPLIED_COLOR}
                strokeWidth={2}
              />
            </>
          )}

          {appliedPoints.map((p, i) => (
            <circle
              key={`p-${p.snapshot.id}`}
              cx={p.x}
              cy={p.y}
              r={hover === i ? 4 : 2.5}
              fill={APPLIED_COLOR}
            />
          ))}

          {active && (
            <line
              x1={active.x}
              y1={0}
              x2={active.x}
              y2={INNER_H}
              stroke="var(--bui-color-border-default, #555)"
            />
          )}

          {/* Invisible hit areas, one per point, for the hover readout. */}
          {appliedPoints.map((p, i) => {
            const half =
              appliedPoints.length > 1 ? INNER_W / appliedPoints.length / 2 : INNER_W / 2;
            return (
              <rect
                key={`hit-${p.snapshot.id}`}
                x={p.x - half}
                y={0}
                width={half * 2}
                height={INNER_H}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}

          {xTicks.map(p => (
            <text
              key={`x-${p.snapshot.id}`}
              x={p.x}
              y={INNER_H + 18}
              textAnchor="middle"
              fill="var(--bui-color-text-secondary, #888)"
              fontSize={10}
              fontFamily="inherit"
            >
              {formatDay(p.snapshot.scannedAt)}
            </text>
          ))}
        </g>
      </svg>

      <Flex gap="3" justify="center" align="center" style={{ flexWrap: 'wrap' }}>
        <Flex align="center" gap="1">
          <svg width={14} height={4} aria-hidden>
            <rect width={14} height={3} rx={1.5} fill={APPLIED_COLOR} />
          </svg>
          <Text variant="body-x-small" color="secondary">
            Applied
          </Text>
        </Flex>
        <Flex align="center" gap="1">
          <svg width={14} height={4} aria-hidden>
            <rect width={5} height={3} rx={1.5} fill={PARTIAL_COLOR} />
            <rect x={8} width={6} height={3} rx={1.5} fill={PARTIAL_COLOR} />
          </svg>
          <Text variant="body-x-small" color="secondary">
            Applied plus partial
          </Text>
        </Flex>
        <Text variant="body-x-small" color="secondary">
          {active
            ? `${new Date(active.snapshot.scannedAt).toLocaleDateString()} · ${active.applied}% applied · ${active.partial}% with partial · ${active.snapshot.target} projects`
            : `${snapshots.length} scans`}
        </Text>
      </Flex>
    </Flex>
  );
};
