import fetch from 'node-fetch';
import { LoggerService } from '@backstage/backend-plugin-api';
import { DashboardAlertRule, GrafanaSearchResult } from './types';

export interface GrafanaClientOptions {
  baseUrl: string;
  apiToken: string;
  cacheTtlSeconds: number;
  logger: LoggerService;
}

export class GrafanaClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly cacheTtlMs: number;
  private readonly logger: LoggerService;

  private cache: { fetchedAt: number; results: GrafanaSearchResult[] } | undefined;
  private alertCache:
    | { fetchedAt: number; rules: Map<string, DashboardAlertRule[]> }
    | undefined;

  constructor(options: GrafanaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiToken = options.apiToken;
    this.cacheTtlMs = Math.max(0, options.cacheTtlSeconds) * 1000;
    this.logger = options.logger;
  }

  async searchDashboards(): Promise<GrafanaSearchResult[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.cache.results;
    }

    const url = `${this.baseUrl}/api/search?type=dash-db&limit=5000`;
    this.logger.debug(`Fetching Grafana dashboards from ${url}`);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: 'application/json',
        'User-Agent': 'backstage-grafana-dashboard-map',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Grafana search failed: ${response.status} ${response.statusText} ${body}`,
      );
    }

    const raw = (await response.json()) as Array<Record<string, unknown>>;
    const results: GrafanaSearchResult[] = raw
      .filter(item => typeof item.uid === 'string' && typeof item.title === 'string')
      .map(item => ({
        uid: item.uid as string,
        title: item.title as string,
        url: this.absoluteUrl(item.url as string | undefined),
        folderTitle: item.folderTitle as string | undefined,
        tags: Array.isArray(item.tags) ? (item.tags as string[]) : [],
      }));

    this.cache = { fetchedAt: now, results };
    return results;
  }

  async fetchDashboardAlertRules(): Promise<Map<string, DashboardAlertRule[]>> {
    const now = Date.now();
    if (this.alertCache && now - this.alertCache.fetchedAt < this.cacheTtlMs) {
      return this.alertCache.rules;
    }

    const rulesByDash = new Map<string, DashboardAlertRule[]>();

    // Strategy A: provisioning rules (canonical dashboardUid + name) +
    // alertmanager active alerts (joined by __alert_rule_uid__).
    const ruleInfoByUid = await this.fetchRuleInfoByUid();
    if (ruleInfoByUid.size > 0) {
      const firingRuleUids = await this.fetchFiringRuleUids();
      for (const [ruleUid, info] of ruleInfoByUid) {
        const arr = rulesByDash.get(info.dashUid) ?? [];
        arr.push({ name: info.name, firing: firingRuleUids.has(ruleUid) });
        rulesByDash.set(info.dashUid, arr);
      }
      sortRules(rulesByDash);
      const firingDashboards = countFiringDashboards(rulesByDash);
      this.logger.info(
        `Grafana alerts: ${ruleInfoByUid.size} rule→dashboard mappings via provisioning API; ${firingRuleUids.size} firing rules; ${rulesByDash.size} dashboards with alerts (${firingDashboards} firing)`,
      );
    } else {
      // Strategy B (fallback): prometheus-compatible rules endpoint.
      const fallback = await this.fetchAlertRulesFromPrometheus();
      for (const [dash, rules] of fallback) rulesByDash.set(dash, rules);
      sortRules(rulesByDash);
      const firingDashboards = countFiringDashboards(rulesByDash);
      this.logger.info(
        `Grafana alerts (fallback via prometheus rules): ${rulesByDash.size} dashboards with alerts (${firingDashboards} firing)`,
      );
    }

    this.alertCache = { fetchedAt: now, rules: rulesByDash };
    return rulesByDash;
  }

  private async fetchRuleInfoByUid(): Promise<
    Map<string, { dashUid: string; name: string }>
  > {
    const url = `${this.baseUrl}/api/v1/provisioning/alert-rules`;
    const map = new Map<string, { dashUid: string; name: string }>();
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          Accept: 'application/json',
          'User-Agent': 'backstage-grafana-dashboard-map',
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `Grafana provisioning alert-rules fetch failed: ${res.status} ${res.statusText} ${body}`,
        );
        return map;
      }
      const rules = (await res.json()) as Array<Record<string, any>>;
      if (!Array.isArray(rules)) return map;
      for (const rule of rules) {
        const ruleUid = typeof rule.uid === 'string' ? rule.uid : undefined;
        const dashUid =
          (typeof rule.dashboardUid === 'string' && rule.dashboardUid) ||
          (typeof rule?.annotations?.__dashboardUid__ === 'string' &&
            rule.annotations.__dashboardUid__) ||
          undefined;
        const name =
          (typeof rule.title === 'string' && rule.title) ||
          (typeof rule.name === 'string' && rule.name) ||
          undefined;
        if (ruleUid && dashUid && name) {
          map.set(ruleUid, { dashUid, name });
        }
      }
    } catch (err) {
      this.logger.warn(
        `Grafana provisioning alert-rules fetch threw: ${(err as Error).message}`,
      );
    }
    return map;
  }

  private async fetchFiringRuleUids(): Promise<Set<string>> {
    const url = `${this.baseUrl}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false`;
    const uids = new Set<string>();
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          Accept: 'application/json',
          'User-Agent': 'backstage-grafana-dashboard-map',
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `Grafana alertmanager alerts fetch failed: ${res.status} ${res.statusText} ${body}`,
        );
        return uids;
      }
      const alerts = (await res.json()) as Array<Record<string, any>>;
      if (!Array.isArray(alerts)) return uids;
      for (const alert of alerts) {
        const status = alert?.status?.state;
        if (status && status !== 'active') continue;
        const ruleUid = alert?.labels?.__alert_rule_uid__;
        if (typeof ruleUid === 'string' && ruleUid) uids.add(ruleUid);
      }
    } catch (err) {
      this.logger.warn(
        `Grafana alertmanager alerts fetch threw: ${(err as Error).message}`,
      );
    }
    return uids;
  }

  private async fetchAlertRulesFromPrometheus(): Promise<Map<string, DashboardAlertRule[]>> {
    const url = `${this.baseUrl}/api/prometheus/grafana/api/v1/rules`;
    const out = new Map<string, DashboardAlertRule[]>();
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          Accept: 'application/json',
          'User-Agent': 'backstage-grafana-dashboard-map',
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `Grafana prometheus rules fetch failed: ${res.status} ${res.statusText} ${body}`,
        );
        return out;
      }
      const payload = (await res.json()) as {
        data?: { groups?: Array<{ rules?: any[] }> };
      };
      for (const group of payload.data?.groups ?? []) {
        for (const rule of group.rules ?? []) {
          const dash = extractDashboardUid(rule);
          if (!dash) continue;
          const name =
            (typeof rule?.name === 'string' && rule.name) ||
            (typeof rule?.title === 'string' && rule.title) ||
            'unnamed';
          const arr = out.get(dash) ?? [];
          arr.push({ name, firing: isFiring(rule) });
          out.set(dash, arr);
        }
      }
    } catch (err) {
      this.logger.warn(
        `Grafana prometheus rules fetch threw: ${(err as Error).message}`,
      );
    }
    return out;
  }

  private absoluteUrl(maybeRelative?: string): string {
    if (!maybeRelative) return this.baseUrl;
    if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
    return `${this.baseUrl}${maybeRelative.startsWith('/') ? '' : '/'}${maybeRelative}`;
  }
}

function extractDashboardUid(rule: any): string | undefined {
  const fromAnnotations = rule?.annotations?.__dashboardUid__;
  if (typeof fromAnnotations === 'string' && fromAnnotations) return fromAnnotations;
  const fromLabels = rule?.labels?.__dashboardUid__;
  if (typeof fromLabels === 'string' && fromLabels) return fromLabels;
  return undefined;
}

function isFiring(rule: any): boolean {
  if (rule?.state === 'firing') return true;
  const alerts = Array.isArray(rule?.alerts) ? rule.alerts : [];
  return alerts.some((a: any) => a?.state === 'firing' || a?.state === 'Alerting');
}

function sortRules(rulesByDash: Map<string, DashboardAlertRule[]>): void {
  for (const arr of rulesByDash.values()) {
    arr.sort((a, b) => {
      if (a.firing !== b.firing) return a.firing ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
}

function countFiringDashboards(
  rulesByDash: Map<string, DashboardAlertRule[]>,
): number {
  let n = 0;
  for (const arr of rulesByDash.values()) {
    if (arr.some(r => r.firing)) n += 1;
  }
  return n;
}
