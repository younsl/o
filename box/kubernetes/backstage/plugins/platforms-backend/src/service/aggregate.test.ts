import { aggregateStats, VisitRow } from './aggregate';
import { dayKeyRange, shiftDayKey, toDayKey } from './dayKey';

const TODAY = '2026-08-10';

function visit(platform: string, userRef: string, dayKey: string): VisitRow {
  return { platform, userRef, dayKey };
}

describe('dayKey', () => {
  it('formats an instant in the target timezone', () => {
    // 15:30 UTC is already the next day in Seoul (UTC+9).
    expect(toDayKey(new Date('2026-08-10T15:30:00Z'), 'Asia/Seoul')).toBe(
      '2026-08-11',
    );
    expect(toDayKey(new Date('2026-08-10T15:30:00Z'), 'UTC')).toBe('2026-08-10');
  });

  it('shifts across month boundaries', () => {
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('returns an inclusive range ending at the given key', () => {
    expect(dayKeyRange('2026-08-10', 3)).toEqual([
      '2026-08-08',
      '2026-08-09',
      '2026-08-10',
    ]);
  });
});

describe('aggregateStats', () => {
  it('counts each user once per day however many times they visit', () => {
    const [stats] = aggregateStats({
      platforms: ['Grafana'],
      rows: [
        visit('Grafana', 'user:default/a', TODAY),
        visit('Grafana', 'user:default/a', TODAY),
        visit('Grafana', 'user:default/b', TODAY),
      ],
      today: TODAY,
    });

    expect(stats.dailyVisitors).toBe(2);
  });

  it('excludes yesterday from the daily counters but keeps it in the week', () => {
    const [stats] = aggregateStats({
      platforms: ['Grafana'],
      rows: [visit('Grafana', 'user:default/a', shiftDayKey(TODAY, -1))],
      today: TODAY,
    });

    expect(stats.dailyVisitors).toBe(0);
    expect(stats.weeklyVisitors).toBe(1);
  });

  it('splits the two trailing weeks and computes the trend', () => {
    const [stats] = aggregateStats({
      platforms: ['Grafana'],
      rows: [
        visit('Grafana', 'user:default/a', TODAY),
        visit('Grafana', 'user:default/b', shiftDayKey(TODAY, -6)),
        visit('Grafana', 'user:default/c', shiftDayKey(TODAY, -8)),
        visit('Grafana', 'user:default/d', shiftDayKey(TODAY, -13)),
      ],
      today: TODAY,
    });

    expect(stats.weeklyVisitors).toBe(2);
    expect(stats.previousWeeklyVisitors).toBe(2);
    expect(stats.trendPercent).toBe(0);
  });

  it('ignores rows older than the two-week window', () => {
    const [stats] = aggregateStats({
      platforms: ['Grafana'],
      rows: [visit('Grafana', 'user:default/a', shiftDayKey(TODAY, -14))],
      today: TODAY,
    });

    expect(stats.weeklyVisitors).toBe(0);
    expect(stats.previousWeeklyVisitors).toBe(0);
  });

  it('returns a null trend rather than a percent change from zero', () => {
    const [stats] = aggregateStats({
      platforms: ['Grafana'],
      rows: [visit('Grafana', 'user:default/a', TODAY)],
      today: TODAY,
    });

    expect(stats.weeklyVisitors).toBe(1);
    expect(stats.previousWeeklyVisitors).toBe(0);
    expect(stats.trendPercent).toBeNull();
  });

  it('rounds a week-over-week decline', () => {
    const previousDay = shiftDayKey(TODAY, -8);
    const [stats] = aggregateStats({
      platforms: ['Grafana'],
      rows: [
        visit('Grafana', 'user:default/a', TODAY),
        visit('Grafana', 'user:default/a', previousDay),
        visit('Grafana', 'user:default/b', previousDay),
        visit('Grafana', 'user:default/c', previousDay),
      ],
      today: TODAY,
    });

    expect(stats.trendPercent).toBe(-67);
  });

  it('keeps platforms with no visits unranked rather than dropping them', () => {
    const stats = aggregateStats({
      platforms: ['Grafana', 'ArgoCD'],
      rows: [visit('Grafana', 'user:default/a', TODAY)],
      today: TODAY,
    });

    const argocd = stats.find(s => s.platform === 'ArgoCD')!;
    expect(stats).toHaveLength(2);
    expect(argocd.rank).toBeNull();
    expect(argocd.trendPercent).toBeNull();
  });

  it('ranks by weekly visitors and shares a rank on ties', () => {
    const rows: VisitRow[] = [
      visit('A', 'user:default/1', TODAY),
      visit('A', 'user:default/2', TODAY),
      visit('A', 'user:default/3', TODAY),
      visit('B', 'user:default/1', TODAY),
      visit('B', 'user:default/2', TODAY),
      visit('C', 'user:default/1', TODAY),
      visit('C', 'user:default/2', TODAY),
      visit('D', 'user:default/1', TODAY),
    ];
    const byName = new Map(
      aggregateStats({
        platforms: ['A', 'B', 'C', 'D'],
        rows,
        today: TODAY,
      }).map(s => [s.platform, s]),
    );

    expect(byName.get('A')!.rank).toBe(1);
    expect(byName.get('B')!.rank).toBe(2);
    expect(byName.get('C')!.rank).toBe(2);
    expect(byName.get('D')!.rank).toBe(4);
  });

  it('ranks a wide set in descending visitor order', () => {
    const platforms = Array.from({ length: 20 }, (_, i) => `p${i}`);
    // p0 gets 20 visitors, p1 gets 19, and so on down to p19 with 1.
    const rows = platforms.flatMap((platform, index) =>
      Array.from({ length: 20 - index }, (_, u) =>
        visit(platform, `user:default/${u}`, TODAY),
      ),
    );
    const byName = new Map(
      aggregateStats({ platforms, rows, today: TODAY }).map(s => [
        s.platform,
        s,
      ]),
    );

    // The UI reads rank against the ranked total to show a percentile, so the
    // ranks have to be dense and 1-based for that division to mean anything.
    platforms.forEach((platform, index) => {
      expect(byName.get(platform)!.rank).toBe(index + 1);
    });
  });

  it('excludes unvisited platforms from the ranked total', () => {
    const stats = aggregateStats({
      platforms: ['A', 'B', 'C'],
      rows: [visit('A', 'user:default/1', TODAY)],
      today: TODAY,
    });

    expect(stats.filter(s => s.rank !== null)).toHaveLength(1);
  });
});
