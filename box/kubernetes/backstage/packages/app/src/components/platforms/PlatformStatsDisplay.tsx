import React from 'react';
import { PlatformStats } from './usePlatformStats';

const TREND_UP = '#4ade80';
const TREND_DOWN = '#f87171';

/**
 * Formats the week-over-week change. Direction is carried by the glyph.
 * Renders nothing when there is no previous week to compare against, since the
 * popularity text already says so.
 */
const TrendIndicator = ({ stats, size = 11 }: { stats: PlatformStats; size?: number }) => {
  if (stats.trendPercent === null) {
    return null;
  }
  if (stats.trendPercent === 0) {
    return (
      <span style={{ fontSize: size, color: 'rgba(255,255,255,0.45)' }}>
        &#8212; flat
      </span>
    );
  }
  const up = stats.trendPercent > 0;
  return (
    <span
      style={{ fontSize: size, fontWeight: 600, color: up ? TREND_UP : TREND_DOWN }}
      title={`${stats.weeklyVisitors} visitors this week vs ${stats.previousWeeklyVisitors} last week`}
    >
      {up ? '▲' : '▼'} {Math.abs(stats.trendPercent)}%
    </span>
  );
};

/**
 * The rank, as plain text. No tiers, no icons, no percentile: the visitor counts
 * sitting directly below make the rank checkable on its own.
 *
 * A platform with no visitors this week has no rank and no previous week to
 * trend against. Both said the same thing in two places, so they collapse into
 * one label here and the trend renders nothing.
 */
const PopularityText = ({
  stats,
  rankedCount,
  size = 11,
}: {
  stats: PlatformStats;
  rankedCount: number;
  size?: number;
}) => {
  if (stats.rank === null) {
    return (
      <span
        style={{
          fontSize: size,
          color: 'rgba(255,255,255,0.35)',
          whiteSpace: 'nowrap',
        }}
        title="Nobody opened this in the last 7 days"
      >
        No visits
      </span>
    );
  }
  return (
    <span
      style={{
        fontSize: size,
        color: 'rgba(255,255,255,0.85)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
      title={`Rank ${stats.rank} of ${rankedCount} by weekly visitors`}
    >
      #{stats.rank}
    </span>
  );
};

/** "Visitors" always counts distinct people, in both views and in both windows. */
const DAILY_VISITORS_HINT = 'Distinct people who opened this today';
const WEEKLY_VISITORS_HINT = 'Distinct people who opened this in the last 7 days';
const WEEKLY_TREND_HINT =
  'Change in weekly visitors against the 7 days before that';

/**
 * One block serves both views. The grid tooltip and the card show the same rows,
 * in the same order, under the same labels, so a number never means one thing on
 * a tile and another on a card. The card shows it inline, the grid tile in its
 * hover tooltip, and nothing else about it changes between the two.
 */
export const PlatformStatBlock = ({
  stats,
  rankedCount,
}: {
  stats?: PlatformStats;
  rankedCount: number;
}) => {
  if (!stats) {
    return null;
  }
  const row = (label: string, value: React.ReactNode, hint?: string) => (
    <div
      key={label}
      title={hint}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        fontSize: 11,
      }}
    >
      <span style={{ color: 'rgba(255,255,255,0.45)' }}>{label}</span>
      <span style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 600 }}>
        {value}
      </span>
    </div>
  );

  /** The two visitor counts read as a pair, so they share a line. */
  const count = (label: string, value: number, hint: string) => (
    <span
      title={hint}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <span style={{ color: 'rgba(255,255,255,0.45)' }}>{label}</span>
      <span style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 600 }}>
        {value}
      </span>
    </span>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        marginTop: 10,
      }}
    >
      {row(
        'Popularity',
        <PopularityText stats={stats} rankedCount={rankedCount} />,
      )}
      {/* Dropped rather than shown empty when there is no week to compare. */}
      {stats.trendPercent !== null &&
        row('Weekly trend', <TrendIndicator stats={stats} />, WEEKLY_TREND_HINT)}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          fontSize: 11,
          whiteSpace: 'nowrap',
        }}
      >
        {count('Daily visitors', stats.dailyVisitors, DAILY_VISITORS_HINT)}
        {count('Weekly visitors', stats.weeklyVisitors, WEEKLY_VISITORS_HINT)}
      </div>
    </div>
  );
};
