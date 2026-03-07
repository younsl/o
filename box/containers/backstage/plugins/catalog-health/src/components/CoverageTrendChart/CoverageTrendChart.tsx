import React, { useMemo } from 'react';
import { Flex, Text } from '@backstage/ui';
import { CoverageSnapshot } from '../../api/types';

const CHART_HEIGHT = 320;
const CHART_PADDING = { top: 24, right: 16, bottom: 48, left: 40 };
const BAR_GAP = 2;

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/** Compute percent including ignored: (registered + ignored) / (total + ignored) * 100 */
const withIgnoredPercent = (s: CoverageSnapshot): number => {
  const allTotal = s.total + s.ignored;
  return allTotal > 0 ? Math.round(((s.registered + s.ignored) / allTotal) * 100) : 0;
};

/** Deduplicate to one snapshot per day (keeps the latest per date) */
const dedupeByDay = (items: CoverageSnapshot[]): CoverageSnapshot[] => {
  const map = new Map<string, CoverageSnapshot>();
  for (const s of items) {
    const day = s.scannedAt.slice(0, 10);
    map.set(day, s);
  }
  return Array.from(map.values());
};

export const CoverageTrendChart = ({
  snapshots: rawSnapshots,
}: {
  snapshots: CoverageSnapshot[];
}) => {
  const snapshots = useMemo(() => dedupeByDay(rawSnapshots), [rawSnapshots]);

  const { yTicks, innerW, innerH, barW } = useMemo(() => {
    const iW = 600 - CHART_PADDING.left - CHART_PADDING.right;
    const iH = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
    const yT = [0, 20, 40, 60, 80, 100];
    const maxBarW = 32;
    const groupW = snapshots.length > 0 ? iW / snapshots.length : iW;
    const bW = Math.min(maxBarW, (groupW - 8) / 2);
    return { yTicks: yT, innerW: iW, innerH: iH, barW: Math.max(bW, 4) };
  }, [snapshots]);

  if (snapshots.length === 0) {
    return (
      <Flex align="center" justify="center" style={{ minHeight: CHART_HEIGHT }}>
        <Text variant="body-small" color="secondary">No trend data yet</Text>
      </Flex>
    );
  }

  const groupW = innerW / snapshots.length;

  return (
    <Flex direction="column" gap="2">
      <svg
        viewBox={`0 0 600 ${CHART_HEIGHT}`}
        width="100%"
        height={CHART_HEIGHT}
        style={{ display: 'block' }}
      >
        <g transform={`translate(${CHART_PADDING.left},${CHART_PADDING.top})`}>
          {/* Grid lines and Y-axis labels */}
          {yTicks.map(tick => {
            const y = innerH - (tick / 100) * innerH;
            return (
              <g key={tick}>
                <line
                  x1={0} y1={y} x2={innerW} y2={y}
                  stroke="var(--bui-color-border-default, #333)"
                  strokeDasharray="3,3"
                />
                <text
                  x={-8} y={y + 4}
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

          {/* Bars */}
          {snapshots.map((s, i) => {
            const cx = groupW * i + groupW / 2;
            const regH = (s.percent / 100) * innerH;
            const ignPct = withIgnoredPercent(s);
            const ignH = (ignPct / 100) * innerH;
            const regX = cx - barW - BAR_GAP / 2;
            const ignX = cx + BAR_GAP / 2;
            return (
              <g key={s.id}>
                {/* Registered bar */}
                <rect
                  x={regX} y={innerH - regH}
                  width={barW} height={regH}
                  rx={2}
                  fill="#10b981"
                />
                {/* Registered label */}
                <text
                  x={regX + barW / 2} y={innerH - regH - 6}
                  textAnchor="middle"
                  fill="var(--bui-color-text-default, #e0e0e0)"
                  fontSize={9}
                  fontWeight={600}
                  fontFamily="inherit"
                >
                  {s.percent}%
                </text>

                {/* With Ignored bar */}
                <rect
                  x={ignX} y={innerH - ignH}
                  width={barW} height={ignH}
                  rx={2}
                  fill="#f59e0b"
                  opacity={0.7}
                />
                {/* With Ignored label */}
                <text
                  x={ignX + barW / 2} y={innerH - ignH - 6}
                  textAnchor="middle"
                  fill="#f59e0b"
                  fontSize={9}
                  fontWeight={600}
                  fontFamily="inherit"
                >
                  {ignPct}%
                </text>

                {/* X-axis date label */}
                <text
                  x={cx} y={innerH + 20}
                  textAnchor="middle"
                  fill="var(--bui-color-text-secondary, #888)"
                  fontSize={10}
                  fontFamily="inherit"
                >
                  {formatDate(s.scannedAt)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Legend */}
      <Flex gap="3" justify="center">
        <Flex align="center" gap="1">
          <svg width={12} height={12}><rect width={12} height={12} rx={2} fill="#10b981" /></svg>
          <Text variant="body-x-small" color="secondary">Registered</Text>
        </Flex>
        <Flex align="center" gap="1">
          <svg width={12} height={12}><rect width={12} height={12} rx={2} fill="#f59e0b" opacity={0.7} /></svg>
          <Text variant="body-x-small" color="secondary">With Ignored</Text>
        </Flex>
      </Flex>
    </Flex>
  );
};
