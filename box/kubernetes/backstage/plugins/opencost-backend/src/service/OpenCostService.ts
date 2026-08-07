import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import fetch from 'node-fetch';

interface ClusterConfig {
  name: string;
  title: string;
  url: string;
}

export interface FetchResult {
  status: number;
  body: string;
  contentType: string;
}

interface CacheEntry {
  result: FetchResult;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 50;
const TTL_PAST_MONTH_MS = 24 * 60 * 60 * 1000; // 24h
const TTL_CURRENT_MONTH_MS = 5 * 60 * 1000; // 5m

export class OpenCostService {
  private readonly clusters: Map<string, ClusterConfig>;
  private readonly cache = new Map<string, CacheEntry>();

  private constructor(
    clusters: Map<string, ClusterConfig>,
    private readonly logger: LoggerService,
  ) {
    this.clusters = clusters;
  }

  static fromConfig(config: Config, logger: LoggerService): OpenCostService {
    const clusters = new Map<string, ClusterConfig>();
    const clusterConfigs = config.getOptionalConfigArray('opencost.clusters') ?? [];

    for (const c of clusterConfigs) {
      const name = c.getString('name');
      const title = c.getOptionalString('title') ?? name;
      const url = c.getOptionalString('url');
      if (!url) {
        logger.warn(`OpenCost cluster '${name}' has no url configured, skipping`);
        continue;
      }
      clusters.set(name, { name, title, url });
    }

    logger.info(`Loaded ${clusters.size} OpenCost cluster(s): ${[...clusters.keys()].join(', ')}`);
    return new OpenCostService(clusters, logger);
  }

  getCluster(name: string): ClusterConfig | undefined {
    return this.clusters.get(name);
  }

  private getTtl(params: string): number {
    const sp = new URLSearchParams(params);
    const window = sp.get('window') ?? '';
    // window format: "startEpoch,endEpoch"
    const endEpoch = Number(window.split(',')[1]);
    if (!endEpoch) return TTL_CURRENT_MONTH_MS;

    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    // If the window end is at or before the current month start, it's a past month
    return endEpoch <= Math.floor(currentMonthStart.getTime() / 1000)
      ? TTL_PAST_MONTH_MS
      : TTL_CURRENT_MONTH_MS;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
  }

  private evictLru(): void {
    // Map iteration order is insertion order; oldest entries come first
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
  }

  async checkClustersStatus(): Promise<{ name: string; title: string; status: 'connected' | 'disconnected' }[]> {
    const results = await Promise.all(
      [...this.clusters.values()].map(async cluster => {
        try {
          const res = await fetch(`${cluster.url}/healthz`, { timeout: 3000 } as any);
          return { name: cluster.name, title: cluster.title, status: res.ok ? 'connected' as const : 'disconnected' as const };
        } catch {
          return { name: cluster.name, title: cluster.title, status: 'disconnected' as const };
        }
      }),
    );
    return results;
  }

  /**
   * Fetches total carbon (kg CO2e) from the /assets/carbon endpoint for a
   * given window. Returns 0 when the endpoint is unavailable.
   */
  private async fetchTotalCarbon(baseUrl: string, window: string): Promise<number> {
    try {
      const res = await fetch(`${baseUrl}/model/assets/carbon?window=${window}`);
      if (!res.ok) return 0;
      const json = await res.json();
      const data: Record<string, { co2e?: number }> = json.data ?? {};
      let total = 0;
      for (const entry of Object.values(data)) {
        total += entry.co2e ?? 0;
      }
      return total;
    } catch {
      return 0;
    }
  }

  /**
   * Enrich an allocation API response with carbonCost per item, distributed
   * proportionally by each item's totalCost share of the cluster total.
   */
  private enrichWithCarbon(json: any, totalCarbon: number): void {
    if (totalCarbon <= 0 || !Array.isArray(json.data)) return;

    // Sum totalCost across ALL steps (for proportional distribution)
    let grandTotal = 0;
    for (const step of json.data) {
      for (const alloc of Object.values(step) as any[]) {
        if (alloc.name === '__idle__') continue;
        grandTotal += alloc.totalCost ?? 0;
      }
    }
    if (grandTotal <= 0) return;

    for (const step of json.data) {
      for (const alloc of Object.values(step) as any[]) {
        if (alloc.name === '__idle__') continue;
        alloc.carbonCost = ((alloc.totalCost ?? 0) / grandTotal) * totalCarbon;
      }
    }
  }

  async fetchAllocation(clusterName: string, params: string): Promise<FetchResult> {
    const cluster = this.clusters.get(clusterName);
    if (!cluster) {
      const available = [...this.clusters.keys()].join(', ') || '(none)';
      this.logger.warn(`Unknown cluster '${clusterName}', available: ${available}`);
      return {
        status: 400,
        body: JSON.stringify({ message: `Unknown cluster: ${clusterName}. Available: ${available}` }),
        contentType: 'application/json',
      };
    }

    const cacheKey = `${clusterName}:${params}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      // Move to end of Map (most recently used)
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      this.logger.info(`Cache hit for ${clusterName}: ${params}`);
      return cached.result;
    }

    const allocationUrl = `${cluster.url}/model/allocation?${params}`;
    this.logger.info(`Cache miss, fetching allocation from ${clusterName}: ${allocationUrl}`);

    try {
      // Extract window param for carbon query
      const sp = new URLSearchParams(params);
      const window = sp.get('window') ?? '';

      // Fetch allocation and carbon in parallel
      const [response, totalCarbon] = await Promise.all([
        fetch(allocationUrl),
        window ? this.fetchTotalCarbon(cluster.url, window) : Promise.resolve(0),
      ]);

      if (!response.ok) {
        const body = await response.text();
        return { status: response.status, body, contentType: 'application/json' };
      }

      const json = await response.json();

      // Inject carbonCost into each allocation item
      this.enrichWithCarbon(json, totalCarbon);

      const body = JSON.stringify(json);
      const result: FetchResult = { status: response.status, body, contentType: 'application/json' };

      this.evictExpired();
      const ttl = this.getTtl(params);
      this.cache.set(cacheKey, { result, expiresAt: Date.now() + ttl });
      this.evictLru();
      this.logger.info(`Cached response for ${clusterName} (TTL: ${ttl / 1000}s, carbon: ${totalCarbon.toFixed(6)} kg)`);

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to fetch allocation from ${clusterName}: ${message}`);
      return {
        status: 502,
        body: JSON.stringify({ message: `Failed to reach OpenCost for cluster ${clusterName}: ${message}` }),
        contentType: 'application/json',
      };
    }
  }
}
