import { LoggerService, SchedulerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import fetch from 'node-fetch';
import {
  OpenCostCostStore,
  DailyCostItem,
  CollectionTaskType,
} from './OpenCostCostStore';

interface ClusterConfig {
  name: string;
  title: string;
  url: string;
}

interface AllocationItem {
  name: string;
  properties: {
    namespace?: string;
    pod?: string;
    controller?: string;
    controllerKind?: string;
  };
  cpuCost: number;
  ramCost: number;
  gpuCost: number;
  pvCost: number;
  networkCost: number;
  totalCost: number;
}

interface CarbonAssetEntry {
  co2e?: number;
}

/* ─── Timezone helpers ─── */

/**
 * Get YYYY-MM-DD for a Date in the given IANA timezone.
 * Works for any timezone including DST-observing ones.
 */
function formatDateInTz(date: Date, tz: string): string {
  // 'en-CA' locale returns YYYY-MM-DD format
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
}

/**
 * Get { year, month, day } for a Date in the given IANA timezone.
 */
function getDatePartsInTz(date: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Get UTC epoch (seconds) for midnight of dateStr (YYYY-MM-DD) in the given timezone.
 *
 * Example: "2026-03-14" in "Asia/Seoul" (UTC+9)
 *   → KST 2026-03-14 00:00:00 = UTC 2026-03-13 15:00:00 → epoch 1773525600
 *
 * Strategy: probe the offset at dateStr noon UTC (avoids DST transition edge),
 * then subtract the offset from the local midnight timestamp.
 */
function midnightEpochInTz(dateStr: string, tz: string): number {
  // Use noon UTC as the probe point to avoid DST midnight ambiguity
  const probeUtc = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(probeUtc);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);

  // What the probe UTC instant looks like in the target timezone
  const tzHour = get('hour') === 24 ? 0 : get('hour');
  const tzAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), tzHour, get('minute'), get('second'));
  // offset = tzLocalTime - utcTime (positive for east-of-UTC)
  const offsetMs = tzAsUtcMs - probeUtc.getTime();

  // Midnight in the target timezone as UTC ms
  const localMidnightMs = Date.UTC(
    parseInt(dateStr.substring(0, 4), 10),
    parseInt(dateStr.substring(5, 7), 10) - 1,
    parseInt(dateStr.substring(8, 10), 10),
    0, 0, 0,
  );
  return Math.floor((localMidnightMs - offsetMs) / 1000);
}

/**
 * Get the UTC offset in minutes for an IANA timezone at the current instant.
 * Positive = east of UTC (e.g. Asia/Seoul → +540).
 */
function getTimezoneOffsetMinutes(tz: string): number {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);

  const tzHour = get('hour') === 24 ? 0 : get('hour');
  const tzAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), tzHour, get('minute'), get('second'));
  const offsetMs = tzAsUtcMs - now.getTime();
  return Math.round(offsetMs / 60_000);
}

/**
 * Convert a 5-field cron expression from local time to UTC.
 *
 * - If hour field is '*', the cron is hour-granularity and needs no conversion.
 * - If day-of-month is '*', day shift from hour wrapping is ignored (daily tasks).
 * - If day-of-month is numeric, day shift is applied (monthly tasks).
 */
function localCronToUtc(localCron: string, tz: string): string {
  const fields = localCron.trim().split(/\s+/);
  if (fields.length !== 5) return localCron;

  const [minuteF, hourF, domF, monthF, dowF] = fields;

  // Hour is '*' → no conversion needed (e.g. gap-validator "0 * * * *")
  if (hourF === '*') return localCron;

  const offsetMin = getTimezoneOffsetMinutes(tz);
  if (offsetMin === 0) return localCron;

  const localMinute = parseInt(minuteF, 10);
  const localHour = parseInt(hourF, 10);
  if (isNaN(localMinute) || isNaN(localHour)) return localCron;

  const totalMinutes = localHour * 60 + localMinute - offsetMin;
  let utcHour = Math.floor(totalMinutes / 60) % 24;
  let utcMinute = totalMinutes % 60;
  if (utcHour < 0) utcHour += 24;
  if (utcMinute < 0) utcMinute += 60;

  const dayShift = Math.floor(totalMinutes / 60 / 24) - Math.floor(localHour / 24);

  let utcDom = domF;
  if (domF !== '*' && dayShift !== 0) {
    const dom = parseInt(domF, 10);
    if (!isNaN(dom)) {
      let newDom = dom + dayShift;
      if (newDom < 1) newDom += 28; // wrap conservatively
      if (newDom > 28) newDom -= 28;
      utcDom = String(newDom);
    }
  }

  return `${utcMinute} ${utcHour} ${utcDom} ${monthF} ${dowF}`;
}

/* ─── Collector ─── */

export class OpenCostCollector {
  private readonly clusters: ClusterConfig[];
  private readonly tz: string;
  /** Local-time cron for the daily collector (exposed via /config API) */
  readonly dailyCronLocal: string;
  /** Billing timezone (exposed via /config API) */
  get timezone(): string { return this.tz; }

  static async create(
    store: OpenCostCostStore,
    config: Config,
    logger: LoggerService,
  ): Promise<OpenCostCollector> {
    const collector = new OpenCostCollector(store, config, logger);
    await collector.seedClusters();
    return collector;
  }

  private constructor(
    private readonly store: OpenCostCostStore,
    private readonly config: Config,
    private readonly logger: LoggerService,
  ) {
    this.clusters = this.loadClusters();
    this.tz = config.getOptionalString('opencost.timezone') ?? 'UTC';
    this.dailyCronLocal = '30 0 * * *';
    this.logger.info(`OpenCost billing timezone: ${this.tz}`);
  }

  private async seedClusters(): Promise<void> {
    for (const cluster of this.clusters) {
      await this.store.ensureCluster(cluster.name, cluster.title);
    }
    this.logger.info(`Seeded ${this.clusters.length} cluster(s) into DB`);
  }

  private loadClusters(): ClusterConfig[] {
    const clusterConfigs = this.config.getOptionalConfigArray('opencost.clusters') ?? [];
    const result: ClusterConfig[] = [];
    for (const c of clusterConfigs) {
      const name = c.getString('name');
      const title = c.getOptionalString('title') ?? name;
      const url = c.getOptionalString('url');
      if (url) {
        result.push({ name, title, url });
      }
    }
    return result;
  }

  async registerTasks(scheduler: SchedulerService): Promise<void> {
    // Local-time cron definitions (billing timezone)
    const dailyLocal = this.dailyCronLocal;      // 00:30 daily
    const gapLocal = '0 * * * *';                // every hour (no conversion needed)
    const monthlyLocal = '0 1 2 * *';            // 2nd of month 01:00

    // Convert to UTC
    const dailyUtc = localCronToUtc(dailyLocal, this.tz);
    const gapUtc = localCronToUtc(gapLocal, this.tz);
    const monthlyUtc = localCronToUtc(monthlyLocal, this.tz);

    this.logger.info(
      `OpenCost cron schedules (${this.tz}): ` +
      `daily-collector="${dailyUtc}" (from "${dailyLocal}"), ` +
      `gap-validator="${gapUtc}" (from "${gapLocal}"), ` +
      `monthly-aggregator="${monthlyUtc}" (from "${monthlyLocal}")`,
    );

    await scheduler.scheduleTask({
      id: 'opencost:daily-collector',
      frequency: { cron: dailyUtc },
      timeout: { minutes: 30 },
      initialDelay: { seconds: 60 },
      fn: async () => this.collectDaily(),
    });

    await scheduler.scheduleTask({
      id: 'opencost:gap-validator',
      frequency: { cron: gapUtc },
      timeout: { minutes: 30 },
      initialDelay: { minutes: 5 },
      fn: async () => this.validateGaps(),
    });

    await scheduler.scheduleTask({
      id: 'opencost:monthly-aggregator',
      frequency: { cron: monthlyUtc },
      timeout: { minutes: 30 },
      initialDelay: { minutes: 10 },
      fn: async () => this.aggregateMonthly(),
    });

    this.logger.info('OpenCost scheduled tasks registered: daily-collector, gap-validator, monthly-aggregator');
  }

  /**
   * Daily Collector: Fetches yesterday's (in billing TZ) cost data for all clusters.
   */
  private async collectDaily(): Promise<void> {
    // "Yesterday" in the billing timezone
    const now = new Date();
    const todayStr = formatDateInTz(now, this.tz);
    const todayEpoch = midnightEpochInTz(todayStr, this.tz);
    const yesterdayDate = new Date((todayEpoch - 86400) * 1000);
    const dateStr = formatDateInTz(yesterdayDate, this.tz);

    this.logger.info(`[daily-collector] Collecting costs for ${dateStr} (${this.tz})`);

    for (const cluster of this.clusters) {
      try {
        await this.collectForDate(cluster, dateStr, 'daily');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`[daily-collector] Failed for cluster=${cluster.name} date=${dateStr}: ${msg}`);
      }
    }
  }

  /**
   * Gap Validator: Detects missing dates in the current month (billing TZ) and attempts backfill.
   */
  private async validateGaps(): Promise<void> {
    const now = new Date();
    const { year, month } = getDatePartsInTz(now, this.tz);
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;

    // Yesterday in billing TZ
    const todayStr = formatDateInTz(now, this.tz);
    const todayEpoch = midnightEpochInTz(todayStr, this.tz);
    const yesterdayDate = new Date((todayEpoch - 86400) * 1000);
    const endDate = formatDateInTz(yesterdayDate, this.tz);

    if (startDate > endDate) {
      this.logger.info('[gap-validator] First day of month, nothing to validate');
      return;
    }

    for (const cluster of this.clusters) {
      try {
        const clusterId = await this.store.getClusterId(cluster.name);
        if (!clusterId) {
          this.logger.info(`[gap-validator] Cluster ${cluster.name} not in DB yet, skipping`);
          continue;
        }

        const missing = await this.store.getMissingDates(clusterId, startDate, endDate);
        if (missing.length === 0) {
          this.logger.info(`[gap-validator] No gaps for cluster=${cluster.name}`);
          continue;
        }

        this.logger.warn(
          `[gap-validator] Found ${missing.length} missing date(s) for cluster=${cluster.name}: ${missing.join(', ')}`,
        );

        for (const date of missing) {
          try {
            await this.collectForDate(cluster, date, 'gap-fill');
            this.logger.info(`[gap-validator] Backfill succeeded for cluster=${cluster.name} date=${date}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(
              `[gap-validator] Backfill failed for cluster=${cluster.name} date=${date}: ${msg}. ` +
              'Data may be lost if Prometheus retention has expired.',
            );
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`[gap-validator] Error validating cluster=${cluster.name}: ${msg}`);
      }
    }
  }

  /**
   * Monthly Aggregator: Aggregates previous month's (billing TZ) daily costs into monthly summaries.
   */
  private async aggregateMonthly(): Promise<void> {
    const now = new Date();
    let { year, month } = getDatePartsInTz(now, this.tz);
    // Previous month
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }

    this.logger.info(`[monthly-aggregator] Aggregating ${year}-${String(month).padStart(2, '0')}`);

    for (const cluster of this.clusters) {
      const clusterId = await this.store.getClusterId(cluster.name);
      if (!clusterId) {
        this.logger.info(`[monthly-aggregator] Cluster ${cluster.name} not in DB yet, skipping`);
        continue;
      }

      const startedAt = new Date().toISOString();
      const runId = await this.store.insertCollectionRun({
        clusterId,
        taskType: 'monthly-agg',
        targetYear: year,
        targetMonth: month,
        startedAt,
      });

      try {
        const count = await this.store.aggregateMonth(clusterId, year, month);
        const coverage = await this.store.getDailyCoverage(clusterId, year, month);
        const totalDays = new Date(year, month, 0).getDate();

        this.logger.info(
          `[monthly-aggregator] cluster=${cluster.name}: ${count} pods aggregated, ` +
          `coverage=${coverage}/${totalDays} days`,
        );

        await this.store.updateCollectionRun(runId, {
          status: 'success',
          podsCollected: count,
          finishedAt: new Date().toISOString(),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`[monthly-aggregator] Failed for cluster=${cluster.name}: ${msg}`);

        await this.store.updateCollectionRun(runId, {
          status: 'failure',
          errorMessage: msg,
          finishedAt: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Fetches allocation data from OpenCost API for a specific date (in billing TZ) and stores it.
   *
   * The day window is dateStr 00:00:00 ~ dateStr+1 00:00:00 in the billing timezone.
   * e.g. timezone=Asia/Seoul, dateStr=2026-03-14
   *   → KST 2026-03-14 00:00 ~ KST 2026-03-15 00:00
   *   → UTC 2026-03-13 15:00 ~ UTC 2026-03-14 15:00
   */
  /**
   * Fetches total carbon emissions (kg CO2e) from the OpenCost /assets/carbon
   * endpoint for the given time window. The allocation API does not include
   * carbon data, so this is fetched separately and distributed proportionally
   * to each pod based on its share of the total cost.
   *
   * Returns 0 if the endpoint is unavailable (e.g. carbonCost is disabled).
   */
  private async fetchTotalCarbon(
    cluster: ClusterConfig,
    startEpoch: number,
    endEpoch: number,
  ): Promise<number> {
    try {
      const url = `${cluster.url}/model/assets/carbon?window=${startEpoch},${endEpoch}`;
      const response = await fetch(url);
      if (!response.ok) {
        this.logger.warn(
          `[collector] Carbon API returned ${response.status} for ${cluster.name}, carbon will be 0`,
        );
        return 0;
      }
      const json = await response.json();
      const data: Record<string, CarbonAssetEntry> = json.data ?? {};
      let total = 0;
      for (const entry of Object.values(data)) {
        total += entry.co2e ?? 0;
      }
      return total;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[collector] Failed to fetch carbon for ${cluster.name}: ${msg}`);
      return 0;
    }
  }

  private async collectForDate(
    cluster: ClusterConfig,
    dateStr: string,
    taskType: CollectionTaskType = 'daily',
  ): Promise<void> {
    const clusterId = await this.store.ensureCluster(cluster.name, cluster.title);

    const startedAt = new Date().toISOString();
    const runId = await this.store.insertCollectionRun({
      clusterId,
      taskType,
      targetDate: dateStr,
      startedAt,
    });

    try {
      const startEpoch = midnightEpochInTz(dateStr, this.tz);
      const endEpoch = startEpoch + 86400; // +24h

      const params = new URLSearchParams({
        window: `${startEpoch},${endEpoch}`,
        aggregate: 'pod',
        accumulate: 'true',
      });

      const allocationUrl = `${cluster.url}/model/allocation?${params}`;
      this.logger.info(`[collector] Fetching ${cluster.name} for ${dateStr} (${this.tz}): epoch ${startEpoch}~${endEpoch}`);

      const [allocationResponse, totalCarbon] = await Promise.all([
        fetch(allocationUrl),
        this.fetchTotalCarbon(cluster, startEpoch, endEpoch),
      ]);

      if (!allocationResponse.ok) {
        throw new Error(`OpenCost API returned ${allocationResponse.status}: ${await allocationResponse.text()}`);
      }

      const json = await allocationResponse.json();
      const allocationMap = json.data?.[0] ?? {};

      // First pass: collect allocations and sum total cost
      const allocations: AllocationItem[] = [];
      let totalCost = 0;
      for (const [, value] of Object.entries(allocationMap)) {
        const item = value as AllocationItem;
        if (item.name === '__idle__') continue;
        allocations.push(item);
        totalCost += item.totalCost ?? 0;
      }

      // Second pass: distribute carbon proportionally by cost
      const items: DailyCostItem[] = allocations.map(item => {
        const podCost = item.totalCost ?? 0;
        const carbonCost = totalCost > 0 ? (podCost / totalCost) * totalCarbon : 0;
        return {
          namespace: item.properties?.namespace ?? 'unknown',
          controllerKind: item.properties?.controllerKind ?? null,
          controller: item.properties?.controller ?? null,
          pod: item.properties?.pod ?? item.name,
          cpuCost: item.cpuCost ?? 0,
          ramCost: item.ramCost ?? 0,
          gpuCost: item.gpuCost ?? 0,
          pvCost: item.pvCost ?? 0,
          networkCost: item.networkCost ?? 0,
          totalCost: item.totalCost ?? 0,
          carbonCost,
        };
      });

      await this.store.insertDailyCosts(clusterId, dateStr, items);
      this.logger.info(
        `[collector] Stored ${items.length} pods for cluster=${cluster.name} date=${dateStr}` +
        ` (carbon=${totalCarbon.toFixed(6)} kg CO2e)`,
      );

      await this.store.updateCollectionRun(runId, {
        status: 'success',
        podsCollected: items.length,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.store.updateCollectionRun(runId, {
        status: 'failure',
        errorMessage: msg,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }
  }
}
