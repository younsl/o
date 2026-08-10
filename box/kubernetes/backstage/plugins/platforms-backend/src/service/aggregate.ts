import { dayKeyRange } from './dayKey';
import { PlatformStats } from './types';

export interface VisitRow {
  platform: string;
  userRef: string;
  dayKey: string;
}

export interface AggregateOptions {
  /** Every configured platform name, so platforms with no visits still get an entry. */
  platforms: string[];
  /** Visit rows covering at least the trailing 14 days. Extra rows are ignored. */
  rows: VisitRow[];
  /** Today's day key in the configured timezone. */
  today: string;
}

export function aggregateStats(options: AggregateOptions): PlatformStats[] {
  const { platforms, rows, today } = options;

  const currentWeek = new Set(dayKeyRange(today, 7));
  const previousWeek = new Set(
    dayKeyRange(today, 14).filter(key => !currentWeek.has(key)),
  );

  const dailyUsers = new Map<string, Set<string>>();
  const weekUsers = new Map<string, Set<string>>();
  const previousWeekUsers = new Map<string, Set<string>>();

  const track = (map: Map<string, Set<string>>, key: string, userRef: string) => {
    const existing = map.get(key);
    if (existing) {
      existing.add(userRef);
    } else {
      map.set(key, new Set([userRef]));
    }
  };

  for (const row of rows) {
    if (row.dayKey === today) {
      track(dailyUsers, row.platform, row.userRef);
    }
    if (currentWeek.has(row.dayKey)) {
      track(weekUsers, row.platform, row.userRef);
    } else if (previousWeek.has(row.dayKey)) {
      track(previousWeekUsers, row.platform, row.userRef);
    }
  }

  const base = platforms.map(platform => {
    const weeklyVisitors = weekUsers.get(platform)?.size ?? 0;
    const previousWeeklyVisitors = previousWeekUsers.get(platform)?.size ?? 0;
    return {
      platform,
      dailyVisitors: dailyUsers.get(platform)?.size ?? 0,
      weeklyVisitors,
      previousWeeklyVisitors,
      // A percent change from zero has no meaning, so an empty previous window
      // yields null and the UI drops the trend row entirely.
      trendPercent:
        previousWeeklyVisitors > 0
          ? Math.round(
              ((weeklyVisitors - previousWeeklyVisitors) /
                previousWeeklyVisitors) *
                100,
            )
          : null,
    };
  });

  const ranked = base
    .filter(entry => entry.weeklyVisitors > 0)
    .sort(
      (a, b) =>
        b.weeklyVisitors - a.weeklyVisitors || a.platform.localeCompare(b.platform),
    );

  const rankByPlatform = new Map<string, number>();
  let lastVisitors: number | undefined;
  let lastRank = 0;
  ranked.forEach((entry, index) => {
    // Equal visitor counts share a rank, so #1 #1 #3 rather than #1 #2 #3.
    const rank = entry.weeklyVisitors === lastVisitors ? lastRank : index + 1;
    rankByPlatform.set(entry.platform, rank);
    lastVisitors = entry.weeklyVisitors;
    lastRank = rank;
  });

  return base.map(entry => ({
    ...entry,
    rank: rankByPlatform.get(entry.platform) ?? null,
  }));
}
