export interface PlatformStats {
  platform: string;
  /** Distinct users who opened the platform today, in the configured timezone. */
  dailyVisitors: number;
  /** Distinct users over the trailing 7 days, including today. */
  weeklyVisitors: number;
  /** Distinct users over the 7 days before that window. */
  previousWeeklyVisitors: number;
  /**
   * Week-over-week change in distinct users, rounded to a percent. Null when the
   * previous window is empty, since a percent change from zero has no meaning.
   */
  trendPercent: number | null;
  /**
   * 1-based rank by weeklyVisitors. Null for platforms with no visitors this
   * week. Read against `rankedCount` to get the percentile.
   */
  rank: number | null;
}

export interface PlatformStatsResponse {
  stats: PlatformStats[];
  /** Number of platforms that had at least one visitor this week. */
  rankedCount: number;
  generatedAt: string;
}
