import { Router } from 'express';
import { LoggerService } from '@backstage/backend-plugin-api';
import { OpenCostService } from './OpenCostService';
import { OpenCostCostStore } from './OpenCostCostStore';
import { OpenCostCollector } from './OpenCostCollector';

export interface RouterOptions {
  service: OpenCostService;
  costStore: OpenCostCostStore;
  collector: OpenCostCollector;
  logger: LoggerService;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { service, costStore, collector, logger } = options;

  const router = Router();

  // Log response time for all routes except /health
  router.use((req, res, next) => {
    if (req.path === '/health') return next();
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`, {
        path: req.path,
        query: req.query,
        status: res.statusCode,
        durationMs: ms,
      });
    });
    next();
  });

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/config', (_, res) => {
    res.json({
      timezone: collector.timezone,
      dailyCollectorCron: collector.dailyCronLocal,
    });
  });

  router.get('/clusters/status', async (_req, res) => {
    const statuses = await service.checkClustersStatus();
    res.json({ data: statuses });
  });

  router.get('/allocation', async (req, res) => {
    const cluster = req.query.cluster as string | undefined;
    if (!cluster) {
      res.status(400).json({ message: 'Missing required query parameter: cluster' });
      return;
    }

    // Forward all query params except 'cluster' to OpenCost
    // Express may parse comma-separated values (e.g. window=start,end) as arrays
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'cluster') continue;
      if (typeof value === 'string') {
        params.set(key, value);
      } else if (Array.isArray(value)) {
        params.set(key, value.join(','));
      }
    }

    logger.debug(`Allocation request for cluster=${cluster}, params=${params.toString()}`);

    const result = await service.fetchAllocation(cluster, params.toString());
    res.status(result.status).setHeader('Content-Type', result.contentType).send(result.body);
  });

  /**
   * GET /costs/years?cluster=X
   * Returns distinct years that have cost data for the given cluster.
   */
  router.get('/costs/years', async (req, res) => {
    const cluster = req.query.cluster as string | undefined;
    if (!cluster) {
      res.status(400).json({ message: 'Required: cluster' });
      return;
    }

    try {
      const clusterId = await costStore.getClusterId(cluster);
      if (!clusterId) {
        res.json({ data: [] });
        return;
      }

      const years = await costStore.getAvailableYears(clusterId);
      res.json({ data: years });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching available years for cluster=${cluster}: ${msg}`);
      res.status(500).json({ message: 'Internal error fetching available years' });
    }
  });

  /**
   * GET /costs/controllers?cluster=X&year=Y&month=Z
   * Returns distinct controller names for the given cluster/month.
   */
  router.get('/costs/controllers', async (req, res) => {
    const cluster = req.query.cluster as string | undefined;
    const year = Number(req.query.year);
    const month = Number(req.query.month);

    if (!cluster || !year || !month || month < 1 || month > 12) {
      res.status(400).json({ message: 'Required: cluster, year, month (1-12)' });
      return;
    }

    try {
      const clusterId = await costStore.getClusterId(cluster);
      if (!clusterId) {
        res.json({ data: [] });
        return;
      }

      const data = await costStore.getControllers(clusterId, year, month);
      res.json({ data });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching controllers for cluster=${cluster} ${year}-${month}: ${msg}`);
      res.status(500).json({ message: 'Internal error fetching controllers' });
    }
  });

  /**
   * GET /costs/daily-summary?cluster=X&year=Y&month=Z[&controllers=a,b]
   * Returns per-day aggregated cost totals for a month from DB.
   */
  router.get('/costs/daily-summary', async (req, res) => {
    const cluster = req.query.cluster as string | undefined;
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    const controllersParam = req.query.controllers as string | undefined;
    const controllers = controllersParam ? controllersParam.split(',').filter(Boolean) : undefined;

    if (!cluster || !year || !month || month < 1 || month > 12) {
      res.status(400).json({ message: 'Required: cluster, year, month (1-12)' });
      return;
    }

    try {
      const clusterId = await costStore.getClusterId(cluster);
      if (!clusterId) {
        res.json({ data: [] });
        return;
      }

      const data = await costStore.getDailySummary(clusterId, year, month, controllers);
      res.json({ data });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching daily summary for cluster=${cluster} ${year}-${month}: ${msg}`);
      res.status(500).json({ message: 'Internal error fetching daily summary' });
    }
  });

  /**
   * GET /costs/pods?cluster=X&date=YYYY-MM-DD
   * Returns all pod costs for a specific date from DB.
   */
  router.get('/costs/pods', async (req, res) => {
    const cluster = req.query.cluster as string | undefined;
    const date = req.query.date as string | undefined;

    if (!cluster || !date) {
      res.status(400).json({ message: 'Required: cluster, date (YYYY-MM-DD)' });
      return;
    }

    try {
      const clusterId = await costStore.getClusterId(cluster);
      if (!clusterId) {
        res.json({ data: [] });
        return;
      }

      const data = await costStore.getPodsForDate(clusterId, date);
      res.json({ data });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching pods for cluster=${cluster} date=${date}: ${msg}`);
      res.status(500).json({ message: 'Internal error fetching pod data' });
    }
  });

  /**
   * GET /costs?cluster=X&year=Y&month=Z[&controllers=a,b]
   * Returns monthly pod cost data from DB.
   * Checks monthly_summaries first, falls back to real-time aggregation from daily_costs.
   */
  router.get('/costs', async (req, res) => {
    const cluster = req.query.cluster as string | undefined;
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    const controllersParam = req.query.controllers as string | undefined;
    const controllers = controllersParam ? controllersParam.split(',').filter(Boolean) : undefined;

    if (!cluster || !year || !month || month < 1 || month > 12) {
      res.status(400).json({ message: 'Required: cluster, year, month (1-12)' });
      return;
    }

    try {
      const clusterId = await costStore.getClusterId(cluster);
      if (!clusterId) {
        res.json({ data: [], daysCovered: 0, source: 'none' });
        return;
      }

      // Try monthly summaries first
      const summaries = await costStore.getMonthlySummary(clusterId, year, month, controllers);
      if (summaries.length > 0) {
        res.json({ data: summaries, daysCovered: summaries[0].daysCovered, source: 'monthly' });
        return;
      }

      // Fall back to real-time aggregation from daily costs
      const { rows, daysCovered } = await costStore.aggregateMonthOnTheFly(clusterId, year, month, controllers);
      res.json({ data: rows, daysCovered, source: 'daily' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching costs for cluster=${cluster} ${year}-${month}: ${msg}`);
      res.status(500).json({ message: 'Internal error fetching cost data' });
    }
  });

  /**
   * GET /costs/daily?cluster=X&pod=POD&year=Y&month=Z
   * Returns daily cost breakdown for a specific pod in a given month.
   */
  router.get('/costs/daily', async (req, res) => {
    const cluster = req.query.cluster as string | undefined;
    const pod = req.query.pod as string | undefined;
    const year = Number(req.query.year);
    const month = Number(req.query.month);

    if (!cluster || !pod || !year || !month || month < 1 || month > 12) {
      res.status(400).json({ message: 'Required: cluster, pod, year, month (1-12)' });
      return;
    }

    try {
      const clusterId = await costStore.getClusterId(cluster);
      if (!clusterId) {
        res.json({ data: [] });
        return;
      }

      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

      const rows = await costStore.getDailyCostsForPod(clusterId, pod, startDate, endDate);
      res.json({ data: rows });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching daily costs for pod=${pod}: ${msg}`);
      res.status(500).json({ message: 'Internal error fetching daily cost data' });
    }
  });

  /**
   * GET /costs/collection-runs?cluster=X&year=Y&month=Z
   * Returns collection run info (start/finish times) per date for a month.
   */
  router.get('/costs/collection-runs', async (req, res) => {
    const cluster = req.query.cluster as string | undefined;
    const year = Number(req.query.year);
    const month = Number(req.query.month);

    if (!cluster || !year || !month || month < 1 || month > 12) {
      res.status(400).json({ message: 'Required: cluster, year, month (1-12)' });
      return;
    }

    try {
      const clusterId = await costStore.getClusterId(cluster);
      if (!clusterId) {
        res.json({ data: [] });
        return;
      }

      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

      const runs = await costStore.getCollectionRuns(clusterId, startDate, endDate);
      res.json({ data: runs });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching collection runs for cluster=${cluster} ${year}-${month}: ${msg}`);
      res.status(500).json({ message: 'Internal error fetching collection runs' });
    }
  });

  return router;
}
