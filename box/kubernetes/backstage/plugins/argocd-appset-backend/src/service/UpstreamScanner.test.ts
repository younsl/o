import { ConfigReader } from '@backstage/config';
import { UpstreamChart } from './UpstreamChartStore';
import { UpstreamScanner } from './UpstreamScanner';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as any;

const REPO = 'https://grafana.github.io/helm-charts';

const chartOf = (chart: string, latestVersion: string | null): UpstreamChart => ({
  chart,
  repository: REPO,
  latestVersion,
  latestAppVersion: null,
  versionCount: latestVersion ? 1 : 0,
  source: 'helm-index',
  unavailableReason: latestVersion ? null : 'the repository could not be read',
  checkedAt: new Date().toISOString(),
});

function createScanner(options: {
  getLatest?: jest.Mock;
  lastCheckedAt?: string | null;
  cooldownSeconds?: number;
} = {}) {
  const getLatest =
    options.getLatest ??
    jest.fn(async (_repository: string, chart: string) => chartOf(chart, '1.0.0'));
  const save = jest.fn().mockResolvedValue(undefined);

  const scanner = new UpstreamScanner({
    charts: { getLatest } as any,
    versions: {
      save,
      lastCheckedAt: jest.fn().mockResolvedValue(options.lastCheckedAt ?? null),
    } as any,
    logger: mockLogger,
    config: new ConfigReader({
      argocdApplicationSet: {
        upstreamChart: { scanCooldownSeconds: options.cooldownSeconds ?? 0 },
      },
    }),
  });

  return { scanner, getLatest, save };
}

const targets = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    repository: REPO,
    chart: `chart-${index}`,
  }));

/** Waits for the scan started by `start` to finish. */
const settle = async (scanner: UpstreamScanner) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!(await scanner.status()).running) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('scan did not finish');
};

describe('UpstreamScanner', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports nothing running before a scan', async () => {
    const { scanner } = createScanner();

    expect(await scanner.status()).toMatchObject({
      running: false,
      done: 0,
      total: 0,
      completedAt: null,
      cooldownSeconds: 0,
      failed: 0,
    });
  });

  it('reads every target and stores each result', async () => {
    const { scanner, getLatest, save } = createScanner();

    expect(await scanner.start(targets(5))).toBe('started');
    await settle(scanner);

    expect(getLatest).toHaveBeenCalledTimes(5);
    expect(save).toHaveBeenCalledTimes(5);
    expect(await scanner.status()).toMatchObject({ running: false, done: 5, total: 5 });
  });

  it('returns before the work is done so progress can be watched', async () => {
    const { scanner } = createScanner();

    await scanner.start(targets(4));
    const during = await scanner.status();

    expect(during.running).toBe(true);
    expect(during.total).toBe(4);
    await settle(scanner);
  });

  // A second reader must join the running scan rather than start another.
  it('refuses to start while one is running', async () => {
    const { scanner } = createScanner();

    await scanner.start(targets(4));
    expect(await scanner.start(targets(4))).toBe('already-running');

    await settle(scanner);
  });

  it('counts a chart that could not be read as failed', async () => {
    const getLatest = jest.fn(async (_repository: string, chart: string) =>
      chart === 'chart-1' ? chartOf(chart, null) : chartOf(chart, '1.0.0'),
    );
    const { scanner } = createScanner({ getLatest });

    await scanner.start(targets(3));
    await settle(scanner);

    expect(await scanner.status()).toMatchObject({ done: 3, failed: 1 });
  });

  // One repository failing outright must not abandon the rest.
  it('carries on when a lookup throws', async () => {
    const getLatest = jest.fn(async (_repository: string, chart: string) => {
      if (chart === 'chart-0') throw new Error('boom');
      return chartOf(chart, '1.0.0');
    });
    const { scanner, save } = createScanner({ getLatest });

    await scanner.start(targets(3));
    await settle(scanner);

    expect(save).toHaveBeenCalledTimes(2);
    expect(await scanner.status()).toMatchObject({ done: 3, failed: 1 });
  });

  describe('cooldown', () => {
    it('refuses a scan started again inside the cooldown', async () => {
      const { scanner } = createScanner({ cooldownSeconds: 60 });

      await scanner.start(targets(2));
      await settle(scanner);

      expect(await scanner.start(targets(2))).toBe('cooling-down');
      expect((await scanner.status()).cooldownSeconds).toBeGreaterThan(0);
    });

    /*
     * The cooldown is meant to apply to everyone, so it has to survive a restart
     * that loses the in-memory state. The stored checkedAt is what carries it.
     */
    it('derives the cooldown from what was last stored', async () => {
      const { scanner } = createScanner({
        cooldownSeconds: 60,
        lastCheckedAt: new Date(Date.now() - 10_000).toISOString(),
      });

      const status = await scanner.status();
      expect(status.cooldownSeconds).toBeGreaterThan(45);
      expect(status.cooldownSeconds).toBeLessThanOrEqual(50);
      expect(await scanner.start(targets(1))).toBe('cooling-down');
    });

    it('allows a scan once the stored check is older than the cooldown', async () => {
      const { scanner } = createScanner({
        cooldownSeconds: 60,
        lastCheckedAt: new Date(Date.now() - 120_000).toISOString(),
      });

      expect((await scanner.status()).cooldownSeconds).toBe(0);
      expect(await scanner.start(targets(1))).toBe('started');
      await settle(scanner);
    });
  });
});
