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

    const url = `${cluster.url}/model/allocation?${params}`;
    this.logger.info(`Cache miss, fetching allocation from ${clusterName}: ${url}`);

    try {
      const response = await fetch(url);
      const body = await response.text();
      const contentType = response.headers.get('content-type') ?? 'application/json';

      const result: FetchResult = { status: response.status, body, contentType };

      // Only cache successful responses
      if (response.ok) {
        this.evictExpired();
        const ttl = this.getTtl(params);
        this.cache.set(cacheKey, { result, expiresAt: Date.now() + ttl });
        this.evictLru();
        this.logger.info(`Cached response for ${clusterName} (TTL: ${ttl / 1000}s)`);
      }

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
