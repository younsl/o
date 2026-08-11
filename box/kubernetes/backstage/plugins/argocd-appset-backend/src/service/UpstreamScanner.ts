import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import { mapWithConcurrency } from './ApplicationSetService';
import { UpstreamChartStore } from './UpstreamChartStore';
import { UpstreamVersionStore } from './UpstreamVersionStore';

/** Parallel repository reads during a scan. Bounded to stay a polite client. */
const SCAN_CONCURRENCY = 6;

const DEFAULT_COOLDOWN_SECONDS = 60;

export interface ScanStatus {
  running: boolean;
  done: number;
  total: number;
  /** ISO stamp of the last scan to finish, whoever started it */
  completedAt: string | null;
  /** Seconds before another scan may start, 0 when one may start now */
  cooldownSeconds: number;
  /** Charts that could not be read during the last scan */
  failed: number;
}

export type StartOutcome = 'started' | 'already-running' | 'cooling-down';

export interface ScanTarget {
  repository: string;
  chart: string;
}

/**
 * Runs the upstream version scan on the server rather than in a browser, so that
 * the progress and the cooldown are properties of the deployment rather than of
 * whoever pressed the button. A scan started by one reader is visible to every
 * other, and the cooldown that follows applies to all of them.
 *
 * State is held in memory, so a second replica would keep its own. The cooldown
 * falls back to the newest stored `checkedAt`, which does survive a restart.
 */
export class UpstreamScanner {
  private readonly charts: UpstreamChartStore;
  private readonly versions: UpstreamVersionStore;
  private readonly logger: LoggerService;
  private readonly cooldownMs: number;

  private running = false;
  private done = 0;
  private total = 0;
  private failed = 0;
  private completedAt: string | null = null;

  constructor(options: {
    charts: UpstreamChartStore;
    versions: UpstreamVersionStore;
    logger: LoggerService;
    config: Config;
  }) {
    this.charts = options.charts;
    this.versions = options.versions;
    this.logger = options.logger;
    this.cooldownMs =
      (options.config.getOptionalNumber(
        'argocdApplicationSet.upstreamChart.scanCooldownSeconds',
      ) ?? DEFAULT_COOLDOWN_SECONDS) * 1000;
  }

  async status(): Promise<ScanStatus> {
    const completedAt = this.completedAt ?? (await this.versions.lastCheckedAt());
    const elapsed = completedAt ? Date.now() - new Date(completedAt).getTime() : Infinity;
    const remaining = this.cooldownMs - elapsed;

    return {
      running: this.running,
      done: this.done,
      total: this.total,
      completedAt,
      cooldownSeconds: remaining > 0 ? Math.ceil(remaining / 1000) : 0,
      failed: this.failed,
    };
  }

  /**
   * Starts a scan unless one is already running or the cooldown has not passed.
   * Returns as soon as the work is under way: the caller follows progress
   * through `status`, which is what lets every reader watch the same scan.
   */
  async start(targets: ScanTarget[]): Promise<StartOutcome> {
    if (this.running) return 'already-running';
    if ((await this.status()).cooldownSeconds > 0) return 'cooling-down';

    this.running = true;
    this.done = 0;
    this.failed = 0;
    this.total = targets.length;

    // Deliberately not awaited: the request returns and the scan carries on.
    this.run(targets).catch(error => {
      this.logger.error(`Upstream scan failed: ${error}`);
      this.finish();
    });

    return 'started';
  }

  private async run(targets: ScanTarget[]): Promise<void> {
    try {
      await mapWithConcurrency(targets, SCAN_CONCURRENCY, async target => {
        try {
          const result = await this.charts.getLatest(target.repository, target.chart);
          await this.versions.save(result);
          if (!result.latestVersion) this.failed += 1;
        } catch (error) {
          this.failed += 1;
          this.logger.warn(`Scan skipped ${target.chart}: ${error}`);
        } finally {
          this.done += 1;
        }
      });

      this.logger.info(
        `Scanned ${this.done} upstream charts, ${this.failed} could not be read`,
      );
    } finally {
      this.finish();
    }
  }

  private finish(): void {
    this.running = false;
    this.completedAt = new Date().toISOString();
  }
}
