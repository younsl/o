import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  PluginHeader,
  Container,
  Box,
  Flex,
  Text,
  Select,
  SearchField,
  Skeleton,
  Alert,
  Link,
} from '@backstage/ui';
import {
  useApi,
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { useAsync } from 'react-use';
import './OpenCostPage.css';

/* ─── Types ─── */

interface AllocationItem {
  name: string;
  properties: {
    cluster?: string;
    namespace?: string;
    pod?: string;
    controller?: string;
    controllerKind?: string;
  };
  window: { start: string; end: string };
  start: string;
  end: string;
  cpuCost: number;
  ramCost: number;
  gpuCost: number;
  pvCost: number;
  networkCost: number;
  totalCost: number;
  totalEfficiency: number;
  carbonCost: number;
}

interface DailySummaryItem {
  date: string;
  podCount: number;
  cpuCost: number;
  ramCost: number;
  gpuCost: number;
  pvCost: number;
  networkCost: number;
  totalCost: number;
  carbonCost: number;
}

type SnapshotStatus = 'collected' | 'collecting' | 'missing' | 'pending';

interface CollectionRunInfo {
  taskType: string;
  status: string;
  podsCollected: number;
  startedAt: string;
  finishedAt: string | null;
}

interface DailyRow extends DailySummaryItem {
  status: SnapshotStatus;
  dayOfWeek: string;
  estimatedCompletion?: string;
  collectionRun?: CollectionRunInfo;
}

interface PodCostItem {
  namespace: string;
  controllerKind: string | null;
  controller: string | null;
  pod: string;
  cpuCost: number;
  ramCost: number;
  gpuCost: number;
  pvCost: number;
  networkCost: number;
  totalCost: number;
  carbonCost: number;
}

interface PodDailyItem {
  date: string;
  cpuCost: number;
  ramCost: number;
  gpuCost: number;
  pvCost: number;
  networkCost: number;
  totalCost: number;
  carbonCost: number;
}

interface DayResult {
  pods: PodCostItem[];
  metricWindow: { start: string; end: string } | null;
}

interface MonthlySummaryItem {
  month: string;
  monthNum: number;
  cpuCost: number;
  ramCost: number;
  gpuCost: number;
  pvCost: number;
  networkCost: number;
  totalCost: number;
  carbonCost: number;
  daysCovered: number;
  totalDays: number;
}

type DrillDown = 'year' | 'month' | 'day' | 'pod';

type PodSortField =
  | 'namespace' | 'controllerKind' | 'controller' | 'pod'
  | 'cpuCost' | 'ramCost' | 'pvCost' | 'networkCost' | 'totalCost' | 'carbonCost';

type SortDirection = 'asc' | 'desc';

/* ─── Utilities ─── */

/**
 * Get UTC epoch (seconds) for midnight of dateStr (YYYY-MM-DD) in the given IANA timezone.
 * e.g. "2026-03-14" in "Asia/Seoul" → UTC 2026-03-13T15:00:00Z
 */
function midnightEpochInTz(dateStr: string, tz: string): number {
  const probeUtc = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(probeUtc);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);

  const tzHour = get('hour') === 24 ? 0 : get('hour');
  const tzAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), tzHour, get('minute'), get('second'));
  const offsetMs = tzAsUtcMs - probeUtc.getTime();

  const localMidnightMs = Date.UTC(
    parseInt(dateStr.substring(0, 4), 10),
    parseInt(dateStr.substring(5, 7), 10) - 1,
    parseInt(dateStr.substring(8, 10), 10),
  );
  return Math.floor((localMidnightMs - offsetMs) / 1000);
}

function getMonthWindow(year: number, month: number, tz: string) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  return {
    start: String(midnightEpochInTz(startDate, tz)),
    end: String(midnightEpochInTz(endDate, tz)),
  };
}

function getDayWindow(dateStr: string, tz: string) {
  const startEpoch = midnightEpochInTz(dateStr, tz);
  return {
    start: String(startEpoch),
    end: String(startEpoch + 86400),
  };
}

function getYearWindow(year: number, tz: string) {
  const startDate = `${year}-01-01`;
  const endDate = `${year + 1}-01-01`;
  return {
    start: String(midnightEpochInTz(startDate, tz)),
    end: String(midnightEpochInTz(endDate, tz)),
  };
}

function truncate1(n: number): number {
  return Math.floor(n * 10) / 10;
}

function formatCost(cost: number): string {
  return `$${truncate1(cost)}`;
}

function formatCarbon(kg: number): string {
  if (kg >= 1000) return `${truncate1(kg / 1000)} t`;
  if (kg >= 1) return `${truncate1(kg)} kg`;
  return `${truncate1(kg * 1000)} g`;
}

function randomHash(len = 6): string {
  const chars = 'abcdef0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function downloadCsv(headers: string[], rows: (string | number)[][], filename: string) {
  const escape = (v: string | number) => {
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function toTzString(utcIso: string, tz: string): string {
  const d = new Date(utcIso);
  return d.toLocaleString('en-US', { timeZone: tz });
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/* ─── Component ─── */

export const OpenCostPage = () => {
  const configApi = useApi(configApiRef);
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);

  const billingTz = useMemo(
    () => configApi.getOptionalString('opencost.timezone') ?? 'UTC',
    [configApi],
  );

  const clusters = useMemo(() => {
    const arr = configApi.getOptionalConfigArray('opencost.clusters');
    if (!arr || arr.length === 0) return [{ name: 'default', title: 'Default' }];
    return arr.map(c => ({
      name: c.getString('name'),
      title: c.getOptionalString('title') ?? c.getString('name'),
    }));
  }, [configApi]);

  /* ── Global state ── */
  const [selectedCluster, setSelectedCluster] = useState(clusters[0].name);
  const now = useMemo(() => new Date(), []);
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);

  /* ── Drill-down state ── */
  const [drillDown, setDrillDown] = useState<DrillDown>('year');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedPod, setSelectedPod] = useState<string | null>(null);

  /* ── Pod-level filter/sort state ── */
  const [searchQuery, setSearchQuery] = useState('');
  const [namespaceFilter, setNamespaceFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [podSortField, setPodSortField] = useState<PodSortField>('totalCost');
  const [podSortDir, setPodSortDir] = useState<SortDirection>('desc');

  const { start, end } = useMemo(
    () => getMonthWindow(selectedYear, selectedMonth, billingTz),
    [selectedYear, selectedMonth, billingTz],
  );

  const isPastMonth = useMemo(() => {
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const selectedStart = new Date(selectedYear, selectedMonth - 1, 1);
    return selectedStart < currentMonthStart;
  }, [now, selectedYear, selectedMonth]);

  // Resolve base URL once
  const [baseUrl, setBaseUrl] = useState('');
  useAsync(async () => {
    const url = await discoveryApi.getBaseUrl('opencost');
    setBaseUrl(url);
  }, [discoveryApi]);

  // Fetch available years for the selected cluster
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  useAsync(async () => {
    if (!baseUrl) return;
    try {
      const resp = await fetchApi.fetch(
        `${baseUrl}/costs/years?cluster=${encodeURIComponent(selectedCluster)}`,
      );
      if (resp.ok) {
        const json = await resp.json();
        setAvailableYears(json.data ?? []);
      }
    } catch {
      // Ignore — fallback to current year
    }
  }, [baseUrl, selectedCluster, fetchApi]);

  // Cache for past-month data
  const cache = useRef(new Map<string, any>());

  /* ── Navigation helpers ── */
  const goToYear = useCallback(() => {
    setDrillDown('year');
    setSelectedDate(null);
    setSelectedPod(null);
    setSearchQuery('');
    setNamespaceFilter('all');
    setKindFilter('all');
  }, []);

  const goToMonth = useCallback((month?: number) => {
    if (month !== undefined) setSelectedMonth(month);
    setDrillDown('month');
    setSelectedDate(null);
    setSelectedPod(null);
    setSearchQuery('');
    setNamespaceFilter('all');
    setKindFilter('all');
  }, []);

  const goToDay = useCallback((date: string) => {
    setDrillDown('day');
    setSelectedDate(date);
    setSelectedPod(null);
    setSearchQuery('');
    setNamespaceFilter('all');
    setKindFilter('all');
  }, []);

  const goToPod = useCallback((pod: string) => {
    setDrillDown('pod');
    setSelectedPod(pod);
  }, []);

  // Reset drill-down when cluster/year/month changes
  const handleClusterChange = useCallback((key: string) => {
    setSelectedCluster(key);
    goToYear();
  }, [goToYear]);

  const handleYearChange = useCallback((key: string) => {
    setSelectedYear(Number(key));
    goToYear();
  }, [goToYear]);

  /* ═══════════════════════════════════════════
     Level 0: Yearly View — monthly summary table
     ═══════════════════════════════════════════ */

  const { start: yearStart, end: yearEnd } = useMemo(
    () => getYearWindow(selectedYear, billingTz),
    [selectedYear, billingTz],
  );

  const {
    value: yearlyData,
    loading: yearlyLoading,
    error: yearlyError,
  } = useAsync(async (): Promise<MonthlySummaryItem[] | null> => {
    if (drillDown !== 'year' || !baseUrl) return null;

    const ck = `year:${selectedCluster}:${selectedYear}`;
    if (cache.current.has(ck)) return cache.current.get(ck);

    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const isPastYear = selectedYear < currentYear;
    const monthMap = new Map<number, MonthlySummaryItem>();

    // Past months: fetch from DB (fast, ~10ms each)
    const lastDbMonth = isPastYear ? 12 : currentMonth - 1;
    const dbFetches = [];
    for (let m = 1; m <= lastDbMonth; m++) {
      dbFetches.push(
        fetchApi.fetch(
          `${baseUrl}/costs?cluster=${encodeURIComponent(selectedCluster)}&year=${selectedYear}&month=${m}`,
        ).then(async r => {
          if (!r.ok) return;
          const json = await r.json();
          const rows = json.data as Array<{
            cpuCost: number; ramCost: number; gpuCost: number;
            pvCost: number; networkCost: number; totalCost: number; carbonCost: number;
          }> | undefined;
          if (!rows || rows.length === 0) return;
          const cpu = rows.reduce((s, e) => s + (e.cpuCost ?? 0), 0);
          const ram = rows.reduce((s, e) => s + (e.ramCost ?? 0), 0);
          const gpu = rows.reduce((s, e) => s + (e.gpuCost ?? 0), 0);
          const pv = rows.reduce((s, e) => s + (e.pvCost ?? 0), 0);
          const network = rows.reduce((s, e) => s + (e.networkCost ?? 0), 0);
          const total = rows.reduce((s, e) => s + (e.totalCost ?? 0), 0);
          const carbon = rows.reduce((s, e) => s + (e.carbonCost ?? 0), 0);
          const td = daysInMonth(selectedYear, m);
          monthMap.set(m, {
            month: `${selectedYear}-${String(m).padStart(2, '0')}`,
            monthNum: m, cpuCost: cpu, ramCost: ram, gpuCost: gpu,
            pvCost: pv, networkCost: network, totalCost: total, carbonCost: carbon,
            daysCovered: json.daysCovered ?? td, totalDays: td,
          });
        }).catch(() => {}),
      );
    }
    await Promise.all(dbFetches);

    // Current month (if selected year is current year): fetch from OpenCost API
    if (!isPastYear) {
      const { start: mStart, end: mEnd } = getMonthWindow(selectedYear, currentMonth, billingTz);
      const params = new URLSearchParams({
        cluster: selectedCluster,
        window: `${mStart},${mEnd}`,
        aggregate: 'cluster',
        step: '1d',
      });
      try {
        const res = await fetchApi.fetch(`${baseUrl}/allocation?${params}`);
        if (res.ok) {
          const json = await res.json();
          const steps = (json.data ?? []) as Record<string, AllocationItem>[];
          let cpu = 0, ram = 0, gpu = 0, pv = 0, network = 0, total = 0, carbon = 0;
          for (const stepMap of steps) {
            const entries = Object.values(stepMap).filter(e => e.name !== '__idle__');
            cpu += entries.reduce((s, e) => s + (e.cpuCost ?? 0), 0);
            ram += entries.reduce((s, e) => s + (e.ramCost ?? 0), 0);
            gpu += entries.reduce((s, e) => s + (e.gpuCost ?? 0), 0);
            pv += entries.reduce((s, e) => s + (e.pvCost ?? 0), 0);
            network += entries.reduce((s, e) => s + (e.networkCost ?? 0), 0);
            total += entries.reduce((s, e) => s + (e.totalCost ?? 0), 0);
            carbon += entries.reduce((s, e) => s + (e.carbonCost ?? 0), 0);
          }
          if (total > 0) {
            const td = daysInMonth(selectedYear, currentMonth);
            monthMap.set(currentMonth, {
              month: `${selectedYear}-${String(currentMonth).padStart(2, '0')}`,
              monthNum: currentMonth, cpuCost: cpu, ramCost: ram, gpuCost: gpu,
              pvCost: pv, networkCost: network, totalCost: total, carbonCost: carbon,
              daysCovered: steps.filter(s => Object.values(s).some(e => e.name !== '__idle__')).length,
              totalDays: td,
            });
          }
        }
      } catch { /* current month is optional */ }
    }

    const items = Array.from(monthMap.values()).sort((a, b) => a.monthNum - b.monthNum);
    if (isPastYear) cache.current.set(ck, items);
    return items;
  }, [drillDown, baseUrl, selectedCluster, selectedYear, yearStart, yearEnd, billingTz]);

  const yearlyTotals = useMemo(() => {
    if (!yearlyData) return null;
    const sum = (fn: (r: MonthlySummaryItem) => number) => yearlyData.reduce((s, r) => s + fn(r), 0);
    return {
      cpu: sum(r => r.cpuCost),
      ram: sum(r => r.ramCost),
      pv: sum(r => r.pvCost),
      network: sum(r => r.networkCost),
      total: sum(r => r.totalCost),
      carbon: sum(r => r.carbonCost),
      months: yearlyData.length,
    };
  }, [yearlyData]);

  /* ═══════════════════════════════════════════
     Level 1: Monthly View — daily summary table
     ═══════════════════════════════════════════ */

  const {
    value: monthlyData,
    loading: monthlyLoading,
    error: monthlyError,
  } = useAsync(async (): Promise<DailySummaryItem[] | null> => {
    if (drillDown !== 'month' || !baseUrl) return null;

    const ck = `month:${selectedCluster}:${selectedYear}:${selectedMonth}`;
    if (isPastMonth && cache.current.has(ck)) return cache.current.get(ck);

    // Past month → DB
    if (isPastMonth) {
      try {
        const params = new URLSearchParams({
          cluster: selectedCluster,
          year: String(selectedYear),
          month: String(selectedMonth),
        });
        const res = await fetchApi.fetch(`${baseUrl}/costs/daily-summary?${params}`);
        if (res.ok) {
          const json = await res.json();
          if (json.data && json.data.length > 0) {
            cache.current.set(ck, json.data);
            return json.data as DailySummaryItem[];
          }
        }
      } catch { /* fall through */ }
    }

    // Current month (or DB empty) → OpenCost API step=1d
    const probeParams = new URLSearchParams({
      cluster: selectedCluster,
      window: `${start},${end}`,
      aggregate: 'cluster',
      step: '1d',
    });
    const res = await fetchApi.fetch(`${baseUrl}/allocation?${probeParams}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenCost API error (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const steps = (json.data ?? []) as Record<string, AllocationItem>[];

    const items: DailySummaryItem[] = [];
    for (const stepMap of steps) {
      const entries = Object.values(stepMap).filter(e => e.name !== '__idle__');
      if (entries.length === 0) continue;
      const entry = entries[0];
      const dateStr = entry.window?.start
        ? new Date(entry.window.start).toISOString().substring(0, 10)
        : '';
      if (!dateStr) continue;
      // For cluster aggregate, costs are already summed across pods
      items.push({
        date: dateStr,
        podCount: 0, // not available from cluster aggregate
        cpuCost: entries.reduce((s, e) => s + (e.cpuCost ?? 0), 0),
        ramCost: entries.reduce((s, e) => s + (e.ramCost ?? 0), 0),
        gpuCost: entries.reduce((s, e) => s + (e.gpuCost ?? 0), 0),
        pvCost: entries.reduce((s, e) => s + (e.pvCost ?? 0), 0),
        networkCost: entries.reduce((s, e) => s + (e.networkCost ?? 0), 0),
        totalCost: entries.reduce((s, e) => s + (e.totalCost ?? 0), 0),
        carbonCost: entries.reduce((s, e) => s + (e.carbonCost ?? 0), 0),
      });
    }

    if (isPastMonth) cache.current.set(ck, items);
    return items;
  }, [drillDown, baseUrl, selectedCluster, selectedYear, selectedMonth, start, end, isPastMonth]);

  // Fetch collection run info for the selected month
  const { value: collectionRuns } = useAsync(async () => {
    if (drillDown !== 'month' || !baseUrl) return null;
    try {
      const params = new URLSearchParams({
        cluster: selectedCluster,
        year: String(selectedYear),
        month: String(selectedMonth),
      });
      const res = await fetchApi.fetch(`${baseUrl}/costs/collection-runs?${params}`);
      if (res.ok) {
        const json = await res.json();
        return new Map<string, CollectionRunInfo>(
          (json.data ?? []).map((r: any) => [r.targetDate, r as CollectionRunInfo]),
        );
      }
    } catch { /* optional data */ }
    return null;
  }, [drillDown, baseUrl, selectedCluster, selectedYear, selectedMonth]);

  // Build full month calendar with snapshot status
  const fullMonthData = useMemo((): DailyRow[] | null => {
    if (!monthlyData) return null;

    const totalDays = daysInMonth(selectedYear, selectedMonth);
    const dataMap = new Map(monthlyData.map(d => [d.date, d]));

    // "Today" in billing timezone
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: billingTz }).format(new Date());
    const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: billingTz, weekday: 'short' });

    const rows: DailyRow[] = [];
    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const existing = dataMap.get(dateStr);

      let status: SnapshotStatus;
      let estimatedCompletion: string | undefined;
      if (dateStr === todayStr) {
        status = 'collecting';
        // Next midnight in billing TZ = when today's cost window closes
        const y = parseInt(dateStr.substring(0, 4), 10);
        const m = parseInt(dateStr.substring(5, 7), 10);
        const d = parseInt(dateStr.substring(8, 10), 10);
        const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
        const nextDayStr = nextDay.toISOString().substring(0, 10);
        const nextMidnightEpoch = midnightEpochInTz(nextDayStr, billingTz);
        estimatedCompletion = new Intl.DateTimeFormat('en-US', {
          timeZone: billingTz,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit',
          hour12: false,
        }).format(new Date(nextMidnightEpoch * 1000));
      } else if (existing) {
        status = 'collected';
      } else if (dateStr > todayStr) {
        status = 'pending';
      } else {
        status = 'missing';
      }

      const dayOfWeek = weekdayFmt.format(new Date(`${dateStr}T12:00:00Z`));

      rows.push({
        date: dateStr,
        podCount: existing?.podCount ?? 0,
        cpuCost: existing?.cpuCost ?? 0,
        ramCost: existing?.ramCost ?? 0,
        gpuCost: existing?.gpuCost ?? 0,
        pvCost: existing?.pvCost ?? 0,
        networkCost: existing?.networkCost ?? 0,
        totalCost: existing?.totalCost ?? 0,
        carbonCost: existing?.carbonCost ?? 0,
        status,
        dayOfWeek,
        estimatedCompletion,
        collectionRun: collectionRuns?.get(dateStr),
      });
    }
    return rows;
  }, [monthlyData, selectedYear, selectedMonth, billingTz, collectionRuns]);

  const monthlyTotals = useMemo(() => {
    if (!monthlyData) return null;
    const sum = (fn: (r: DailySummaryItem) => number) => monthlyData.reduce((s, r) => s + fn(r), 0);
    const totalDays = daysInMonth(selectedYear, selectedMonth);
    const collected = fullMonthData?.filter(r => r.status === 'collected').length ?? 0;
    const collecting = fullMonthData?.filter(r => r.status === 'collecting').length ?? 0;
    const missing = fullMonthData?.filter(r => r.status === 'missing').length ?? 0;
    return {
      cpu: sum(r => r.cpuCost),
      ram: sum(r => r.ramCost),
      pv: sum(r => r.pvCost),
      network: sum(r => r.networkCost),
      total: sum(r => r.totalCost),
      carbon: sum(r => r.carbonCost),
      totalDays,
      collected,
      collecting,
      missing,
    };
  }, [monthlyData, selectedYear, selectedMonth, fullMonthData]);

  /* ═══════════════════════════════════════════
     Level 2: Day View — pods for a date
     ═══════════════════════════════════════════ */

  const {
    value: dayResult,
    loading: dayLoading,
    error: dayError,
  } = useAsync(async (): Promise<DayResult | null> => {
    if (drillDown !== 'day' || !baseUrl || !selectedDate) return null;

    const ck = `day:${selectedCluster}:${selectedDate}`;
    if (isPastMonth && cache.current.has(ck)) return cache.current.get(ck);

    // Past month → DB
    if (isPastMonth) {
      try {
        const params = new URLSearchParams({ cluster: selectedCluster, date: selectedDate });
        const res = await fetchApi.fetch(`${baseUrl}/costs/pods?${params}`);
        if (res.ok) {
          const json = await res.json();
          if (json.data && json.data.length > 0) {
            // DB stores whole-day data; window is date 00:00 ~ 23:59:59 in billing TZ
            const dayStartEpoch = midnightEpochInTz(selectedDate, billingTz);
            const result: DayResult = {
              pods: json.data as PodCostItem[],
              metricWindow: {
                start: new Date(dayStartEpoch * 1000).toISOString(),
                end: new Date((dayStartEpoch + 86400 - 1) * 1000).toISOString(),
              },
            };
            cache.current.set(ck, result);
            return result;
          }
        }
      } catch { /* fall through */ }
    }

    // Current month → OpenCost API single-day window
    const { start: dayStart, end: dayEnd } = getDayWindow(selectedDate, billingTz);
    const params = new URLSearchParams({
      cluster: selectedCluster,
      window: `${dayStart},${dayEnd}`,
      aggregate: 'pod',
      accumulate: 'true',
    });
    const res = await fetchApi.fetch(`${baseUrl}/allocation?${params}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenCost API error (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const allocationMap = json.data?.[0] ?? {};
    const allItems = Object.values(allocationMap) as AllocationItem[];
    const filtered = allItems.filter(v => v.name !== '__idle__');

    // Extract actual metric window from allocation items
    let minStart: string | null = null;
    let maxEnd: string | null = null;
    for (const v of filtered) {
      const s = v.window?.start ?? v.start;
      const e = v.window?.end ?? v.end;
      if (s && (!minStart || s < minStart)) minStart = s;
      if (e && (!maxEnd || e > maxEnd)) maxEnd = e;
    }

    const items: PodCostItem[] = filtered.map((v: any) => ({
      namespace: v.properties?.namespace ?? 'unknown',
      controllerKind: v.properties?.controllerKind ?? null,
      controller: v.properties?.controller ?? null,
      pod: v.properties?.pod ?? v.name,
      cpuCost: v.cpuCost ?? 0,
      ramCost: v.ramCost ?? 0,
      gpuCost: v.gpuCost ?? 0,
      pvCost: v.pvCost ?? 0,
      networkCost: v.networkCost ?? 0,
      totalCost: v.totalCost ?? 0,
      carbonCost: v.carbonCost ?? 0,
    }));

    const result: DayResult = {
      pods: items,
      metricWindow: minStart && maxEnd ? { start: minStart, end: maxEnd } : null,
    };

    if (isPastMonth) cache.current.set(ck, result);
    return result;
  }, [drillDown, baseUrl, selectedCluster, selectedDate, isPastMonth]);

  const dayData = dayResult?.pods ?? null;
  const dayMetricWindow = dayResult?.metricWindow ?? null;

  // Day-level filters and sort
  const filteredDayData = useMemo(() => {
    if (!dayData) return [];
    return dayData.filter(item => {
      const matchesSearch =
        searchQuery === '' ||
        item.pod.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.namespace.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.controller ?? '').toLowerCase().includes(searchQuery.toLowerCase());
      const matchesNs = namespaceFilter === 'all' || item.namespace === namespaceFilter;
      const matchesKind = kindFilter === 'all' || (item.controllerKind ?? 'unknown') === kindFilter;
      return matchesSearch && matchesNs && matchesKind;
    });
  }, [dayData, searchQuery, namespaceFilter, kindFilter]);

  const sortedDayData = useMemo(() => {
    return [...filteredDayData].sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;
      switch (podSortField) {
        case 'namespace': aVal = a.namespace; bVal = b.namespace; break;
        case 'controllerKind': aVal = a.controllerKind ?? ''; bVal = b.controllerKind ?? ''; break;
        case 'controller': aVal = a.controller ?? ''; bVal = b.controller ?? ''; break;
        case 'pod': aVal = a.pod; bVal = b.pod; break;
        default: aVal = (a as any)[podSortField] ?? 0; bVal = (b as any)[podSortField] ?? 0;
      }
      if (typeof aVal === 'string') {
        const cmp = aVal.localeCompare(bVal as string);
        return podSortDir === 'asc' ? cmp : -cmp;
      }
      return podSortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
  }, [filteredDayData, podSortField, podSortDir]);

  const dayNamespaces = useMemo(() => {
    if (!dayData) return [];
    return Array.from(new Set(dayData.map(i => i.namespace))).sort();
  }, [dayData]);

  const dayKinds = useMemo(() => {
    if (!dayData) return [];
    return Array.from(new Set(dayData.map(i => i.controllerKind ?? 'unknown'))).sort();
  }, [dayData]);

  const dayTotals = useMemo(() => {
    const sum = (fn: (i: PodCostItem) => number) => filteredDayData.reduce((s, i) => s + fn(i), 0);
    return {
      cpu: sum(i => i.cpuCost),
      ram: sum(i => i.ramCost),
      pv: sum(i => i.pvCost),
      network: sum(i => i.networkCost),
      total: sum(i => i.totalCost),
      carbon: sum(i => i.carbonCost),
    };
  }, [filteredDayData]);

  const handlePodSort = useCallback((field: PodSortField) => {
    if (podSortField === field) {
      setPodSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setPodSortField(field);
      setPodSortDir(
        field === 'namespace' || field === 'pod' || field === 'controllerKind' || field === 'controller' ? 'asc' : 'desc',
      );
    }
  }, [podSortField]);

  /* ═══════════════════════════════════════════
     Level 3: Pod View — daily history for a pod
     ═══════════════════════════════════════════ */

  const {
    value: podDailyData,
    loading: podLoading,
    error: podError,
  } = useAsync(async (): Promise<PodDailyItem[] | null> => {
    if (drillDown !== 'pod' || !baseUrl || !selectedPod) return null;

    const ck = `pod:${selectedCluster}:${selectedYear}:${selectedMonth}:${selectedPod}`;
    if (isPastMonth && cache.current.has(ck)) return cache.current.get(ck);

    // Past month → DB
    if (isPastMonth) {
      try {
        const params = new URLSearchParams({
          cluster: selectedCluster,
          pod: selectedPod,
          year: String(selectedYear),
          month: String(selectedMonth),
        });
        const res = await fetchApi.fetch(`${baseUrl}/costs/daily?${params}`);
        if (res.ok) {
          const json = await res.json();
          if (json.data && json.data.length > 0) {
            cache.current.set(ck, json.data);
            return json.data as PodDailyItem[];
          }
        }
      } catch { /* fall through */ }
    }

    // Current month → OpenCost API step=1d, aggregate=pod, filter by pod client-side
    const params = new URLSearchParams({
      cluster: selectedCluster,
      window: `${start},${end}`,
      aggregate: 'pod',
      step: '1d',
    });
    const res = await fetchApi.fetch(`${baseUrl}/allocation?${params}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenCost API error (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const steps = (json.data ?? []) as Record<string, AllocationItem>[];

    const items: PodDailyItem[] = [];
    for (const stepMap of steps) {
      // Find this pod in this day's data
      const match = Object.values(stepMap).find(
        v => (v.properties?.pod ?? v.name) === selectedPod,
      );
      if (match) {
        const dateStr = match.window?.start
          ? new Date(match.window.start).toISOString().substring(0, 10)
          : '';
        if (dateStr) {
          items.push({
            date: dateStr,
            cpuCost: match.cpuCost ?? 0,
            ramCost: match.ramCost ?? 0,
            gpuCost: match.gpuCost ?? 0,
            pvCost: match.pvCost ?? 0,
            networkCost: match.networkCost ?? 0,
            totalCost: match.totalCost ?? 0,
            carbonCost: match.carbonCost ?? 0,
          });
        }
      }
    }

    if (isPastMonth) cache.current.set(ck, items);
    return items;
  }, [drillDown, baseUrl, selectedCluster, selectedPod, selectedYear, selectedMonth, start, end, isPastMonth]);

  const podTotals = useMemo(() => {
    if (!podDailyData) return null;
    const sum = (fn: (r: PodDailyItem) => number) => podDailyData.reduce((s, r) => s + fn(r), 0);
    return {
      cpu: sum(r => r.cpuCost),
      ram: sum(r => r.ramCost),
      pv: sum(r => r.pvCost),
      network: sum(r => r.networkCost),
      total: sum(r => r.totalCost),
      carbon: sum(r => r.carbonCost),
      days: podDailyData.length,
    };
  }, [podDailyData]);

  /* ── Shared UI ── */

  const currentYear = now.getFullYear();
  const yearOptions = useMemo(() => {
    // Use data-driven years; always include the current year as fallback
    const years = availableYears.length > 0
      ? [...new Set([currentYear, ...availableYears])].sort((a, b) => b - a)
      : [currentYear];
    return years.map(y => ({ value: String(y), label: String(y) }));
  }, [availableYears, currentYear]);
  const clusterOptions = useMemo(
    () => clusters.map(c => ({ value: c.name, label: c.title })),
    [clusters],
  );

  const PodSortIcon = ({ field }: { field: PodSortField }) => {
    if (podSortField !== field) return <span className="oc-sort-icon">{'\u2195'}</span>;
    return (
      <span className="oc-sort-icon oc-sort-active">
        {podSortDir === 'asc' ? '\u2191' : '\u2193'}
      </span>
    );
  };

  const loading = (drillDown === 'year' && yearlyLoading)
    || (drillDown === 'month' && monthlyLoading)
    || (drillDown === 'day' && dayLoading)
    || (drillDown === 'pod' && podLoading);
  const error = (drillDown === 'year' ? yearlyError : drillDown === 'month' ? monthlyError : drillDown === 'day' ? dayError : podError);

  const loadingLabel = drillDown === 'year'
    ? 'yearly summary'
    : drillDown === 'month'
      ? 'monthly summary'
      : drillDown === 'day'
        ? 'pod costs'
        : 'pod daily history';

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!loading) {
      setElapsedSeconds(0);
      return;
    }
    setElapsedSeconds(0);
    const interval = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    return () => clearInterval(interval);
  }, [loading]);

  const monthLabel = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;

  return (
    <>
      <PluginHeader title="OpenCost" />
      <Container my="4">
        <Text variant="body-medium" color="secondary">
          Kubernetes cost explorer powered by <Link href="https://www.opencost.io" target="_blank" rel="noopener noreferrer">OpenCost</Link>
        </Text>

        {/* ── Filters ── */}
        <Box mt="4" p="3" className="oc-section-box">
          <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
            Filters
          </Text>
          <Flex gap="3" align="end">
            <Select label="Cluster" size="small" options={clusterOptions}
              selectedKey={selectedCluster} onSelectionChange={key => handleClusterChange(key as string)} />
            <Select label="Year" size="small" options={yearOptions}
              selectedKey={String(selectedYear)} onSelectionChange={key => handleYearChange(key as string)} />
          </Flex>
        </Box>

        {/* ── Breadcrumb ── */}
        <Box mt="3" className="oc-breadcrumb">
          <span
            className={drillDown === 'year' ? 'oc-crumb-active' : 'oc-crumb-link'}
            onClick={drillDown !== 'year' ? goToYear : undefined}
          >
            {selectedYear}
          </span>

          {drillDown !== 'year' && (
            <>
              <span className="oc-crumb-sep">/</span>
              <span
                className={drillDown === 'month' ? 'oc-crumb-active' : 'oc-crumb-link'}
                onClick={drillDown !== 'month' ? () => goToMonth() : undefined}
              >
                {monthLabel}
              </span>
            </>
          )}

          {selectedDate && (
            <>
              <span className="oc-crumb-sep">/</span>
              <span
                className={drillDown === 'day' ? 'oc-crumb-active' : 'oc-crumb-link'}
                onClick={drillDown === 'pod' && selectedDate ? () => goToDay(selectedDate) : undefined}
              >
                {selectedDate}
              </span>
            </>
          )}

          {selectedPod && (
            <>
              <span className="oc-crumb-sep">/</span>
              <span className="oc-crumb-active">{selectedPod}</span>
            </>
          )}
        </Box>

        {/* ── Loading / Error ── */}
        {loading && (
          <Flex direction="column" gap="3" mt="3">
            <div style={{ position: 'relative' }}>
              <Skeleton width="100%" height={60} />
              <Text variant="body-medium" color="secondary" style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
              }}>
                Loading {loadingLabel}... {elapsedSeconds > 0 && `(${elapsedSeconds}s)`}
              </Text>
            </div>
            <Skeleton width="100%" height={400} />
          </Flex>
        )}
        {error && (
          <Box mt="3">
            <Alert status="danger" title={`Failed to load data: ${error.message}`} />
          </Box>
        )}

        {/* ═══════════════════════════════════
            Level 0: Yearly — monthly summary
            ═══════════════════════════════════ */}
        {drillDown === 'year' && yearlyData && !loading && (
          <>
            {yearlyTotals && (
              <Box mt="3" p="3" className="oc-section-box">
                <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
                  Summary
                </Text>
                <div className="oc-summary-bar">
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(yearlyTotals.total)}</Text>
                    <Text variant="body-x-small" color="secondary">Total Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(yearlyTotals.cpu)}</Text>
                    <Text variant="body-x-small" color="secondary">CPU Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(yearlyTotals.ram)}</Text>
                    <Text variant="body-x-small" color="secondary">RAM Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(yearlyTotals.pv)}</Text>
                    <Text variant="body-x-small" color="secondary">PV Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{yearlyTotals.months}</Text>
                    <Text variant="body-x-small" color="secondary">Months</Text>
                  </div>
                </div>

                {yearlyTotals.total > 0 && (() => {
                  const segments = [
                    { label: 'CPU', value: yearlyTotals.cpu, color: '#60a5fa' },
                    { label: 'RAM', value: yearlyTotals.ram, color: '#a78bfa' },
                    { label: 'PV', value: yearlyTotals.pv, color: '#34d399' },
                    { label: 'Network', value: yearlyTotals.network, color: '#fbbf24' },
                  ].filter(s => s.value > 0);
                  return (
                    <div className="oc-breakdown">
                      <div className="oc-breakdown-bar">
                        {segments.map(s => {
                          const pct = (s.value / yearlyTotals.total) * 100;
                          return (
                            <div
                              key={s.label}
                              className="oc-breakdown-segment"
                              style={{ width: `${pct}%`, background: s.color }}
                              title={`${s.label}: ${formatCost(s.value)} (${pct.toFixed(1)}%)`}
                            />
                          );
                        })}
                      </div>
                      <div className="oc-breakdown-legend">
                        {segments.map(s => {
                          const pct = (s.value / yearlyTotals.total) * 100;
                          return (
                            <div key={s.label} className="oc-breakdown-item">
                              <span className="oc-breakdown-dot" style={{ background: s.color }} />
                              <span className="oc-breakdown-label">{s.label}</span>
                              <span className="oc-breakdown-value">{formatCost(s.value)}</span>
                              <span className="oc-breakdown-pct">{pct.toFixed(1)}%</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </Box>
            )}

            <Box mt="3" p="3" className="oc-section-box">
              <Flex justify="between" align="center" mb="3">
                <Text variant="body-medium" weight="bold">Monthly Cost Breakdown</Text>
                <Flex align="center" gap="2">
                  <span className="oc-count-badge">{yearlyData.length} months</span>
                  {yearlyData.length > 0 && (
                    <button className="oc-export-btn" onClick={() => downloadCsv(
                      ['Month', 'CPU', 'RAM', 'GPU', 'PV', 'Network', 'Total', 'Carbon'],
                      yearlyData.map(r => [r.month, r.cpuCost, r.ramCost, r.gpuCost, r.pvCost, r.networkCost, r.totalCost, r.carbonCost]),
                      `backstage-${selectedCluster}-${selectedYear}-monthly-${randomHash()}.csv`,
                    )}>Export CSV</button>
                  )}
                </Flex>
              </Flex>

              {yearlyData.length === 0 ? (
                <div className="oc-empty-state">
                  <Text variant="body-medium" color="secondary">No cost data for {selectedYear}</Text>
                </div>
              ) : (
                <div className="oc-table-wrapper">
                  <table className="oc-table">
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th>Coverage</th>
                        <th>CPU</th>
                        <th>RAM</th>
                        <th>GPU</th>
                        <th>PV</th>
                        <th>Network</th>
                        <th>Total</th>
                        <th>Carbon</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yearlyData.map(row => {
                        const pct = row.totalDays > 0 ? Math.round((row.daysCovered / row.totalDays) * 100) : 0;
                        return (
                        <tr key={row.month} className="oc-clickable-row" onClick={() => goToMonth(row.monthNum)}>
                          <td>{row.month}</td>
                          <td>{row.daysCovered}/{row.totalDays} <span style={{ opacity: 0.6 }}>({pct}%)</span></td>
                          <td className="oc-cost">{formatCost(row.cpuCost)}</td>
                          <td className="oc-cost">{formatCost(row.ramCost)}</td>
                          <td className="oc-cost">{formatCost(row.gpuCost)}</td>
                          <td className="oc-cost">{formatCost(row.pvCost)}</td>
                          <td className="oc-cost">{formatCost(row.networkCost)}</td>
                          <td className="oc-cost oc-cost-total">{formatCost(row.totalCost)}</td>
                          <td className="oc-cost oc-carbon">{formatCarbon(row.carbonCost)}</td>
                        </tr>
                        );
                      })}
                    </tbody>
                    {yearlyTotals && (
                      <tfoot>
                        <tr>
                          <td colSpan={2}><strong>Total</strong></td>
                          <td className="oc-cost"><strong>{formatCost(yearlyTotals.cpu)}</strong></td>
                          <td className="oc-cost"><strong>{formatCost(yearlyTotals.ram)}</strong></td>
                          <td className="oc-cost"><strong>-</strong></td>
                          <td className="oc-cost"><strong>{formatCost(yearlyTotals.pv)}</strong></td>
                          <td className="oc-cost"><strong>{formatCost(yearlyTotals.network)}</strong></td>
                          <td className="oc-cost oc-cost-total"><strong>{formatCost(yearlyTotals.total)}</strong></td>
                          <td className="oc-cost oc-carbon"><strong>{formatCarbon(yearlyTotals.carbon)}</strong></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </Box>
          </>
        )}

        {/* ═══════════════════════════════════
            Level 1: Monthly — daily summary
            ═══════════════════════════════════ */}
        {drillDown === 'month' && fullMonthData && !loading && (
          <>
            {/* Summary */}
            {monthlyTotals && (
              <Box mt="3" p="3" className="oc-section-box">
                <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
                  Summary
                </Text>
                <div className="oc-summary-bar">
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(monthlyTotals.total)}</Text>
                    <Text variant="body-x-small" color="secondary">Total Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(monthlyTotals.cpu)}</Text>
                    <Text variant="body-x-small" color="secondary">CPU Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(monthlyTotals.ram)}</Text>
                    <Text variant="body-x-small" color="secondary">RAM Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(monthlyTotals.pv)}</Text>
                    <Text variant="body-x-small" color="secondary">PV Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">
                      {monthlyTotals.collected}/{monthlyTotals.totalDays} <span style={{ fontWeight: 'normal', opacity: 0.6 }}>({Math.round((monthlyTotals.collected / monthlyTotals.totalDays) * 100)}%)</span>
                    </Text>
                    <Text variant="body-x-small" color="secondary">Collected</Text>
                  </div>
                  {monthlyTotals.collecting > 0 && (
                    <div className="oc-summary-card oc-summary-card-collecting">
                      <Text weight="bold" className="oc-summary-value oc-status-collecting">
                        {monthlyTotals.collecting}
                      </Text>
                      <Text variant="body-x-small" color="secondary">In Progress</Text>
                    </div>
                  )}
                  {monthlyTotals.missing > 0 && (
                    <div className="oc-summary-card oc-summary-card-missing">
                      <Text weight="bold" className="oc-summary-value oc-status-missing">
                        {monthlyTotals.missing}
                      </Text>
                      <Text variant="body-x-small" color="secondary">Missing</Text>
                    </div>
                  )}
                </div>

                {/* Cost breakdown bar */}
                {monthlyTotals.total > 0 && (() => {
                  const segments = [
                    { label: 'CPU', value: monthlyTotals.cpu, color: '#60a5fa' },
                    { label: 'RAM', value: monthlyTotals.ram, color: '#a78bfa' },
                    { label: 'PV', value: monthlyTotals.pv, color: '#34d399' },
                    { label: 'Network', value: monthlyTotals.network, color: '#fbbf24' },
                  ].filter(s => s.value > 0);
                  return (
                    <div className="oc-breakdown">
                      <div className="oc-breakdown-bar">
                        {segments.map(s => {
                          const pct = (s.value / monthlyTotals.total) * 100;
                          return (
                            <div
                              key={s.label}
                              className="oc-breakdown-segment"
                              style={{ width: `${pct}%`, background: s.color }}
                              title={`${s.label}: ${formatCost(s.value)} (${pct.toFixed(1)}%)`}
                            />
                          );
                        })}
                      </div>
                      <div className="oc-breakdown-legend">
                        {segments.map(s => {
                          const pct = (s.value / monthlyTotals.total) * 100;
                          return (
                            <div key={s.label} className="oc-breakdown-item">
                              <span className="oc-breakdown-dot" style={{ background: s.color }} />
                              <span className="oc-breakdown-label">{s.label}</span>
                              <span className="oc-breakdown-value">{formatCost(s.value)}</span>
                              <span className="oc-breakdown-pct">{pct.toFixed(1)}%</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </Box>
            )}

            {/* Daily table */}
            <Box mt="3" p="3" className="oc-section-box">
              <Flex justify="between" align="center" mb="3">
                <Text variant="body-medium" weight="bold">Daily Cost Breakdown</Text>
                <Flex align="center" gap="2">
                  <span className="oc-count-badge">{fullMonthData.length} days</span>
                  <button className="oc-export-btn" onClick={() => downloadCsv(
                    ['Date', 'Day', 'Status', 'Pods', 'CPU', 'RAM', 'GPU', 'PV', 'Network', 'Total', 'Carbon'],
                    fullMonthData.map(r => [r.date, r.dayOfWeek, r.status, r.podCount, r.cpuCost, r.ramCost, r.gpuCost, r.pvCost, r.networkCost, r.totalCost, r.carbonCost]),
                    `backstage-${selectedCluster}-${monthLabel}-daily-${randomHash()}.csv`,
                  )}>Export CSV</button>
                </Flex>
              </Flex>

              <div className="oc-table-wrapper">
                <table className="oc-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Status</th>
                      <th>Pods</th>
                      <th>CPU</th>
                      <th>RAM</th>
                      <th>GPU</th>
                      <th>PV</th>
                      <th>Network</th>
                      <th>Total</th>
                      <th>Carbon</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fullMonthData.map(row => {
                      const hasData = row.status === 'collected' || row.status === 'collecting';
                      const statusLabel = ({ collected: 'Collected', collecting: 'In Progress', missing: 'Missing', pending: 'Pending' })[row.status];
                      const run = row.collectionRun;
                      const fmtTime = (iso: string) => toTzString(iso, billingTz);
                      let statusTooltip: string;
                      if (run) {
                        const lines = [
                          `Type: ${run.taskType}`,
                          `Started: ${fmtTime(run.startedAt)}`,
                          run.finishedAt ? `Finished: ${fmtTime(run.finishedAt)}` : 'Finished: -',
                          `Pods: ${run.podsCollected}`,
                        ];
                        statusTooltip = lines.join('\n');
                      } else if (row.status === 'collecting' && row.estimatedCompletion) {
                        statusTooltip = `Finalizes at ${row.estimatedCompletion} (${billingTz})`;
                      } else {
                        statusTooltip = statusLabel;
                      }
                      const ledColor = ({ collected: '#34d399', collecting: '#60a5fa', missing: '#f87171', pending: '#6b7280' })[row.status];
                      return (
                        <tr
                          key={row.date}
                          className={hasData ? 'oc-clickable-row' : 'oc-row-disabled'}
                          onClick={hasData ? () => goToDay(row.date) : undefined}
                        >
                          <td>{row.date} <span className="oc-day-of-week">({row.dayOfWeek})</span></td>
                          <td title={statusTooltip}>
                            <span style={{
                              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                              backgroundColor: ledColor, marginRight: 6, verticalAlign: 'middle',
                            }} />
                            {statusLabel}
                          </td>
                          <td>{hasData ? (row.podCount || '-') : '-'}</td>
                          <td className="oc-cost">{hasData ? formatCost(row.cpuCost) : '-'}</td>
                          <td className="oc-cost">{hasData ? formatCost(row.ramCost) : '-'}</td>
                          <td className="oc-cost">{hasData ? formatCost(row.gpuCost) : '-'}</td>
                          <td className="oc-cost">{hasData ? formatCost(row.pvCost) : '-'}</td>
                          <td className="oc-cost">{hasData ? formatCost(row.networkCost) : '-'}</td>
                          <td className="oc-cost oc-cost-total">{hasData ? formatCost(row.totalCost) : '-'}</td>
                          <td className="oc-cost oc-carbon">{hasData ? formatCarbon(row.carbonCost) : '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {monthlyTotals && (
                    <tfoot>
                      <tr>
                        <td colSpan={3}><strong>Total</strong></td>
                        <td className="oc-cost"><strong>{formatCost(monthlyTotals.cpu)}</strong></td>
                        <td className="oc-cost"><strong>{formatCost(monthlyTotals.ram)}</strong></td>
                        <td className="oc-cost"><strong>-</strong></td>
                        <td className="oc-cost"><strong>{formatCost(monthlyTotals.pv)}</strong></td>
                        <td className="oc-cost"><strong>{formatCost(monthlyTotals.network)}</strong></td>
                        <td className="oc-cost oc-cost-total"><strong>{formatCost(monthlyTotals.total)}</strong></td>
                        <td className="oc-cost oc-carbon"><strong>{formatCarbon(monthlyTotals.carbon)}</strong></td>
                      </tr>
                    </tfoot>
                  )}
                  </table>
                </div>
            </Box>
          </>
        )}

        {/* ═══════════════════════════════════
            Level 2: Day — pods for a date
            ═══════════════════════════════════ */}
        {drillDown === 'day' && dayData && !loading && (
          <>
            {/* Summary */}
            <Box mt="3" p="3" className="oc-section-box">
              <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
                Summary — {selectedDate}
              </Text>
              {dayMetricWindow && (
                <Text variant="body-x-small" color="secondary" style={{ display: 'block', marginBottom: 12 }}>
                  {`Metric period: ${toTzString(dayMetricWindow.start, billingTz)} ~ ${toTzString(dayMetricWindow.end, billingTz)} (${billingTz})`}
                </Text>
              )}
              <div className="oc-summary-bar">
                <div className="oc-summary-card">
                  <Text weight="bold" className="oc-summary-value">{formatCost(dayTotals.total)}</Text>
                  <Text variant="body-x-small" color="secondary">Total Cost</Text>
                </div>
                <div className="oc-summary-card">
                  <Text weight="bold" className="oc-summary-value">{formatCost(dayTotals.cpu)}</Text>
                  <Text variant="body-x-small" color="secondary">CPU Cost</Text>
                </div>
                <div className="oc-summary-card">
                  <Text weight="bold" className="oc-summary-value">{formatCost(dayTotals.ram)}</Text>
                  <Text variant="body-x-small" color="secondary">RAM Cost</Text>
                </div>
                <div className="oc-summary-card">
                  <Text weight="bold" className="oc-summary-value oc-carbon">{formatCarbon(dayTotals.carbon)}</Text>
                  <Text variant="body-x-small" color="secondary">Carbon Cost</Text>
                </div>
                <div className="oc-summary-card">
                  <Text weight="bold" className="oc-summary-value">{filteredDayData.length}</Text>
                  <Text variant="body-x-small" color="secondary">Pods</Text>
                </div>
              </div>
            </Box>

            {/* Filters */}
            <Box mt="3" p="3" className="oc-section-box">
              <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
                Filters
              </Text>
              <div className="oc-filter-bar">
                <SearchField label="Search" placeholder="Search by pod or namespace..."
                  size="small" value={searchQuery} onChange={setSearchQuery} />
                <div className="oc-native-select">
                  <label className="oc-native-select-label" htmlFor="oc-ns-filter">Namespace</label>
                  <select id="oc-ns-filter" value={namespaceFilter}
                    onChange={e => setNamespaceFilter(e.target.value)}>
                    <option value="all">All ({dayNamespaces.length})</option>
                    {dayNamespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                  </select>
                </div>
                <Select label="Kind" size="small"
                  options={[
                    { value: 'all', label: `All (${dayKinds.length})` },
                    ...dayKinds.map(k => ({ value: k, label: k })),
                  ]}
                  selectedKey={kindFilter}
                  onSelectionChange={key => setKindFilter(key as string)} />
              </div>
            </Box>

            {/* Pod table */}
            <Box mt="3" p="3" className="oc-section-box">
              <Flex justify="between" align="center" mb="3">
                <Text variant="body-medium" weight="bold">Pod Cost Details</Text>
                <Flex align="center" gap="2">
                  <span className="oc-count-badge">
                    {sortedDayData.length !== dayData.length
                      ? `${sortedDayData.length} / ${dayData.length}`
                      : dayData.length}
                  </span>
                  <Text variant="body-small" color="secondary">pods</Text>
                  {sortedDayData.length > 0 && (
                    <button className="oc-export-btn" onClick={() => downloadCsv(
                      ['Namespace', 'Kind', 'Workload', 'Pod', 'CPU', 'RAM', 'PV', 'Network', 'Total', 'Carbon'],
                      sortedDayData.map(r => [r.namespace, r.controllerKind ?? '', r.controller ?? '', r.pod, r.cpuCost, r.ramCost, r.pvCost, r.networkCost, r.totalCost, r.carbonCost]),
                      `backstage-${selectedCluster}-${selectedDate}-pods-${randomHash()}.csv`,
                    )}>Export CSV</button>
                  )}
                </Flex>
              </Flex>

              {sortedDayData.length === 0 ? (
                <div className="oc-empty-state">
                  <Text variant="body-medium" color="secondary">No pods match the current filters</Text>
                </div>
              ) : (
                <div className="oc-table-wrapper">
                  <table className="oc-table">
                    <thead>
                      <tr>
                        <th onClick={() => handlePodSort('namespace')}>Namespace <PodSortIcon field="namespace" /></th>
                        <th onClick={() => handlePodSort('controllerKind')}>Kind <PodSortIcon field="controllerKind" /></th>
                        <th onClick={() => handlePodSort('controller')}>Workload <PodSortIcon field="controller" /></th>
                        <th onClick={() => handlePodSort('pod')}>Pod <PodSortIcon field="pod" /></th>
                        <th onClick={() => handlePodSort('cpuCost')}>CPU <PodSortIcon field="cpuCost" /></th>
                        <th onClick={() => handlePodSort('ramCost')}>RAM <PodSortIcon field="ramCost" /></th>
                        <th onClick={() => handlePodSort('pvCost')}>PV <PodSortIcon field="pvCost" /></th>
                        <th onClick={() => handlePodSort('networkCost')}>Network <PodSortIcon field="networkCost" /></th>
                        <th onClick={() => handlePodSort('totalCost')}>Total <PodSortIcon field="totalCost" /></th>
                        <th onClick={() => handlePodSort('carbonCost')}>Carbon <PodSortIcon field="carbonCost" /></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedDayData.map(item => (
                        <tr key={item.pod} className="oc-clickable-row" onClick={() => goToPod(item.pod)}>
                          <td>{item.namespace}</td>
                          <td className="oc-kind">{item.controllerKind ?? '-'}</td>
                          <td>{item.controller ?? '-'}</td>
                          <td className="oc-pod-name">{item.pod}</td>
                          <td className="oc-cost">{formatCost(item.cpuCost)}</td>
                          <td className="oc-cost">{formatCost(item.ramCost)}</td>
                          <td className="oc-cost">{formatCost(item.pvCost)}</td>
                          <td className="oc-cost">{formatCost(item.networkCost)}</td>
                          <td className="oc-cost oc-cost-total">{formatCost(item.totalCost)}</td>
                          <td className="oc-cost oc-carbon">{formatCarbon(item.carbonCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4}><strong>Total</strong></td>
                        <td className="oc-cost"><strong>{formatCost(dayTotals.cpu)}</strong></td>
                        <td className="oc-cost"><strong>{formatCost(dayTotals.ram)}</strong></td>
                        <td className="oc-cost"><strong>{formatCost(dayTotals.pv)}</strong></td>
                        <td className="oc-cost"><strong>{formatCost(dayTotals.network)}</strong></td>
                        <td className="oc-cost oc-cost-total"><strong>{formatCost(dayTotals.total)}</strong></td>
                        <td className="oc-cost oc-carbon"><strong>{formatCarbon(dayTotals.carbon)}</strong></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </Box>
          </>
        )}

        {/* ═══════════════════════════════════
            Level 3: Pod — daily cost history
            ═══════════════════════════════════ */}
        {drillDown === 'pod' && podDailyData && !loading && (
          <>
            {/* Summary */}
            {podTotals && (
              <Box mt="3" p="3" className="oc-section-box">
                <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
                  Pod Summary — {selectedPod}
                </Text>
                <div className="oc-summary-bar">
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(podTotals.total)}</Text>
                    <Text variant="body-x-small" color="secondary">Total Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(podTotals.cpu)}</Text>
                    <Text variant="body-x-small" color="secondary">CPU Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(podTotals.ram)}</Text>
                    <Text variant="body-x-small" color="secondary">RAM Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value oc-carbon">{formatCarbon(podTotals.carbon)}</Text>
                    <Text variant="body-x-small" color="secondary">Carbon Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{podTotals.days}</Text>
                    <Text variant="body-x-small" color="secondary">Active Days</Text>
                  </div>
                  {podTotals.days > 0 && (
                    <div className="oc-summary-card">
                      <Text weight="bold" className="oc-summary-value">
                        {formatCost(podTotals.total / podTotals.days)}
                      </Text>
                      <Text variant="body-x-small" color="secondary">Avg Daily Cost</Text>
                    </div>
                  )}
                </div>
              </Box>
            )}

            {/* Daily history table */}
            <Box mt="3" p="3" className="oc-section-box">
              <Flex justify="between" align="center" mb="3">
                <Text variant="body-medium" weight="bold">Daily Cost History</Text>
                <Flex align="center" gap="2">
                  <span className="oc-count-badge">{podDailyData.length} days</span>
                  {podDailyData.length > 0 && (
                    <button className="oc-export-btn" onClick={() => downloadCsv(
                      ['Date', 'CPU', 'RAM', 'GPU', 'PV', 'Network', 'Total', 'Carbon'],
                      podDailyData.map(r => [r.date, r.cpuCost, r.ramCost, r.gpuCost, r.pvCost, r.networkCost, r.totalCost, r.carbonCost]),
                      `backstage-${selectedCluster}-${selectedPod}-daily-${randomHash()}.csv`,
                    )}>Export CSV</button>
                  )}
                </Flex>
              </Flex>

              {podDailyData.length === 0 ? (
                <div className="oc-empty-state">
                  <Text variant="body-medium" color="secondary">No daily cost data for this pod</Text>
                </div>
              ) : (
                <div className="oc-table-wrapper">
                  <table className="oc-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>CPU</th>
                        <th>RAM</th>
                        <th>GPU</th>
                        <th>PV</th>
                        <th>Network</th>
                        <th>Total</th>
                        <th>Carbon</th>
                      </tr>
                    </thead>
                    <tbody>
                      {podDailyData.map(row => (
                        <tr key={row.date}>
                          <td>{row.date}</td>
                          <td className="oc-cost">{formatCost(row.cpuCost)}</td>
                          <td className="oc-cost">{formatCost(row.ramCost)}</td>
                          <td className="oc-cost">{formatCost(row.gpuCost)}</td>
                          <td className="oc-cost">{formatCost(row.pvCost)}</td>
                          <td className="oc-cost">{formatCost(row.networkCost)}</td>
                          <td className="oc-cost oc-cost-total">{formatCost(row.totalCost)}</td>
                          <td className="oc-cost oc-carbon">{formatCarbon(row.carbonCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                    {podTotals && (
                      <tfoot>
                        <tr>
                          <td><strong>Total</strong></td>
                          <td className="oc-cost"><strong>{formatCost(podTotals.cpu)}</strong></td>
                          <td className="oc-cost"><strong>{formatCost(podTotals.ram)}</strong></td>
                          <td className="oc-cost"><strong>-</strong></td>
                          <td className="oc-cost"><strong>{formatCost(podTotals.pv)}</strong></td>
                          <td className="oc-cost"><strong>{formatCost(podTotals.network)}</strong></td>
                          <td className="oc-cost oc-cost-total"><strong>{formatCost(podTotals.total)}</strong></td>
                          <td className="oc-cost oc-carbon"><strong>{formatCarbon(podTotals.carbon)}</strong></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </Box>
          </>
        )}
      </Container>
    </>
  );
};
