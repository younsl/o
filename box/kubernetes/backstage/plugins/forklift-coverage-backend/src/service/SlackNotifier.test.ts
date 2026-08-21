import { ConfigReader } from '@backstage/config';
import { isFullCoverage, readWebhookFromConfig } from './SlackNotifier';
import { CoverageSummary } from './types';

const summary = (over: Partial<CoverageSummary> = {}): CoverageSummary => ({
  target: 10,
  applied: 10,
  partial: 0,
  notApplied: 0,
  errored: 0,
  skipped: 4,
  excluded: 2,
  percent: 100,
  ...over,
});

describe('isFullCoverage', () => {
  it('is true when every target project is applied', () => {
    expect(isFullCoverage(summary())).toBe(true);
  });

  it.each([
    ['a partial project', { partial: 1, applied: 9 }],
    ['a not applied project', { notApplied: 1, applied: 9 }],
    ['a scan error hiding a verdict', { errored: 1, applied: 9 }],
  ])('is false with %s', (_label, over) => {
    expect(isFullCoverage(summary(over))).toBe(false);
  });

  // An empty target usually means the scope is wrong, not that the work is
  // done, so the report still goes out.
  it('is false when the scan found no target project', () => {
    expect(isFullCoverage(summary({ target: 0, applied: 0, percent: 0 }))).toBe(
      false,
    );
  });
});

describe('readWebhookFromConfig', () => {
  it('returns null without a URL', () => {
    expect(readWebhookFromConfig(new ConfigReader({}))).toBeNull();
  });

  it('defaults to enabled and to posting at full coverage', () => {
    const config = new ConfigReader({
      forkliftCoverage: { webhook: { url: 'https://hooks.example.com/abc' } },
    });
    expect(readWebhookFromConfig(config)).toEqual({
      url: 'https://hooks.example.com/abc',
      enabled: true,
      skipWhenFullCoverage: false,
    });
  });

  it('reads the skip toggle', () => {
    const config = new ConfigReader({
      forkliftCoverage: {
        webhook: {
          url: 'https://hooks.example.com/abc',
          enabled: false,
          skipWhenFullCoverage: true,
        },
      },
    });
    expect(readWebhookFromConfig(config)).toEqual({
      url: 'https://hooks.example.com/abc',
      enabled: false,
      skipWhenFullCoverage: true,
    });
  });
});
