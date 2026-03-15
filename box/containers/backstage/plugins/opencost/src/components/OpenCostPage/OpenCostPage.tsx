import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  isEstimated?: boolean;
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

type DailySortField =
  | 'date' | 'status' | 'podCount'
  | 'cpuCost' | 'ramCost' | 'gpuCost' | 'pvCost' | 'networkCost' | 'totalCost' | 'carbonCost';

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
  const datePart = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const timePart = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return `${datePart} ${timePart} (${tz})`;
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

  /* ── Deep-link: read initial state from URL search params ── */
  const [searchParams, setSearchParams] = useSearchParams();
  const now = useMemo(() => new Date(), []);

  const initialState = useMemo(() => {
    const cluster = searchParams.get('cluster') ?? clusters[0].name;
    const year = Number(searchParams.get('year')) || now.getFullYear();
    const month = Number(searchParams.get('month')) || now.getMonth() + 1;
    const date = searchParams.get('date');
    const pod = searchParams.get('pod');

    let drill: DrillDown = 'year';
    if (pod && date) drill = 'pod';
    else if (date) drill = 'day';
    else if (searchParams.has('month')) drill = 'month';

    return { cluster, year, month, date, pod, drill };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once

  /* ── Global state ── */
  const [selectedCluster, setSelectedCluster] = useState(initialState.cluster);
  const [selectedYear, setSelectedYear] = useState(initialState.year);
  const [selectedMonth, setSelectedMonth] = useState(initialState.month);

  /* ── Drill-down state ── */
  const [drillDown, setDrillDown] = useState<DrillDown>(initialState.drill);
  const [selectedDate, setSelectedDate] = useState<string | null>(initialState.date);
  const [selectedPod, setSelectedPod] = useState<string | null>(initialState.pod);

  /* ── Sync state → URL search params ── */
  useEffect(() => {
    const params: Record<string, string> = { cluster: selectedCluster, year: String(selectedYear) };
    if (drillDown !== 'year') params.month = String(selectedMonth);
    if (selectedDate) params.date = selectedDate;
    if (selectedPod) params.pod = selectedPod;
    setSearchParams(params, { replace: true });
  }, [selectedCluster, selectedYear, selectedMonth, drillDown, selectedDate, selectedPod, setSearchParams]);

  /* ── Monthly (daily table) sort state ── */
  const [dailySortField, setDailySortField] = useState<DailySortField>('date');
  const [dailySortDir, setDailySortDir] = useState<SortDirection>('asc');

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

  // Fetch collection schedule config from backend
  const { value: backendConfig } = useAsync(async () => {
    if (!baseUrl) return null;
    try {
      const resp = await fetchApi.fetch(`${baseUrl}/config`);
      if (resp.ok) return resp.json() as Promise<{ timezone: string; dailyCollectorCron: string }>;
    } catch { /* ignore */ }
    return null;
  }, [baseUrl, fetchApi]);

  // Fetch cluster connectivity status
  const { value: clusterStatuses } = useAsync(async () => {
    if (!baseUrl) return null;
    try {
      const resp = await fetchApi.fetch(`${baseUrl}/clusters/status`);
      if (resp.ok) {
        const json = await resp.json();
        return new Map<string, string>(
          (json.data ?? []).map((c: any) => [c.name, c.status]),
        );
      }
    } catch { /* ignore */ }
    return null;
  }, [baseUrl, fetchApi]);

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

  // Controller multi-select filter (for Year/Month views)
  const [selectedControllers, setSelectedControllers] = useState<string[]>([]);
  const [controllerListByMonth, setControllerListByMonth] = useState<Map<string, string[]>>(new Map());
  const [controllerDropdownOpen, setControllerDropdownOpen] = useState(false);
  const [controllerSearch, setControllerSearch] = useState('');
  const controllerDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (controllerDropdownRef.current && !controllerDropdownRef.current.contains(e.target as Node)) {
        setControllerDropdownOpen(false);
        setControllerSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Fetch controller lists for relevant months
  useAsync(async () => {
    if (!baseUrl || (drillDown !== 'year' && drillDown !== 'month')) return;

    if (drillDown === 'month') {
      const key = `${selectedCluster}:${selectedYear}:${selectedMonth}`;
      if (controllerListByMonth.has(key)) return;
      try {
        const params = new URLSearchParams({
          cluster: selectedCluster,
          year: String(selectedYear),
          month: String(selectedMonth),
        });
        const res = await fetchApi.fetch(`${baseUrl}/costs/controllers?${params}`);
        if (res.ok) {
          const json = await res.json();
          setControllerListByMonth(prev => new Map(prev).set(key, json.data ?? []));
        }
      } catch { /* optional */ }
    } else {
      // Year view: fetch controllers for all months in parallel
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      const lastMonth = selectedYear < currentYear ? 12 : currentMonth;
      const fetches = [];
      for (let m = 1; m <= lastMonth; m++) {
        const key = `${selectedCluster}:${selectedYear}:${m}`;
        if (controllerListByMonth.has(key)) continue;
        fetches.push(
          fetchApi.fetch(
            `${baseUrl}/costs/controllers?cluster=${encodeURIComponent(selectedCluster)}&year=${selectedYear}&month=${m}`,
          ).then(async r => {
            if (r.ok) {
              const json = await r.json();
              return { key, data: json.data as string[] };
            }
            return null;
          }).catch(() => null),
        );
      }
      if (fetches.length > 0) {
        const results = await Promise.all(fetches);
        setControllerListByMonth(prev => {
          const next = new Map(prev);
          for (const r of results) {
            if (r) next.set(r.key, r.data);
          }
          return next;
        });
      }
    }
  }, [drillDown, baseUrl, selectedCluster, selectedYear, selectedMonth, fetchApi]);

  // Derived: merged controller list for current view
  const availableControllers = useMemo(() => {
    const set = new Set<string>();
    if (drillDown === 'month') {
      const key = `${selectedCluster}:${selectedYear}:${selectedMonth}`;
      for (const c of controllerListByMonth.get(key) ?? []) set.add(c);
    } else {
      // Year view: merge all months
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      const lastMonth = selectedYear < currentYear ? 12 : currentMonth;
      for (let m = 1; m <= lastMonth; m++) {
        const key = `${selectedCluster}:${selectedYear}:${m}`;
        for (const c of controllerListByMonth.get(key) ?? []) set.add(c);
      }
    }
    return Array.from(set).sort();
  }, [drillDown, selectedCluster, selectedYear, selectedMonth, controllerListByMonth, now]);

  const controllersParam = useMemo(
    () => selectedControllers.length > 0 ? selectedControllers.join(',') : undefined,
    [selectedControllers],
  );

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
    setSelectedControllers([]);
    goToYear();
  }, [goToYear]);

  const handleYearChange = useCallback((key: string) => {
    setSelectedYear(Number(key));
    setSelectedControllers([]);
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

    const ck = `year:${selectedCluster}:${selectedYear}:${controllersParam ?? ''}`;
    if (cache.current.has(ck)) return cache.current.get(ck);

    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const isPastYear = selectedYear < currentYear;
    const monthMap = new Map<number, MonthlySummaryItem>();

    // Past months: fetch from DB (fast, ~10ms each)
    const lastDbMonth = isPastYear ? 12 : currentMonth - 1;
    const dbFetches = [];
    for (let m = 1; m <= lastDbMonth; m++) {
      const costUrl = `${baseUrl}/costs?cluster=${encodeURIComponent(selectedCluster)}&year=${selectedYear}&month=${m}${controllersParam ? `&controllers=${encodeURIComponent(controllersParam)}` : ''}`;
      dbFetches.push(
        fetchApi.fetch(costUrl).then(async r => {
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
      const hasControllerFilter = selectedControllers.length > 0;
      const { start: mStart, end: mEnd } = getMonthWindow(selectedYear, currentMonth, billingTz);
      const params = new URLSearchParams({
        cluster: selectedCluster,
        window: `${mStart},${mEnd}`,
        aggregate: hasControllerFilter ? 'pod' : 'cluster',
        step: '1d',
      });
      try {
        const res = await fetchApi.fetch(`${baseUrl}/allocation?${params}`);
        if (res.ok) {
          const json = await res.json();
          const steps = (json.data ?? []) as Record<string, AllocationItem>[];
          let cpu = 0, ram = 0, gpu = 0, pv = 0, network = 0, total = 0, carbon = 0;
          let daysCovered = 0;
          const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: billingTz }).format(new Date());
          let todayInSteps = false;

          for (const stepMap of steps) {
            let entries = Object.values(stepMap).filter(e => e.name !== '__idle__');
            if (hasControllerFilter) {
              entries = entries.filter(e => selectedControllers.includes(e.properties?.controller ?? ''));
            }
            if (entries.length === 0) continue;
            daysCovered++;
            cpu += entries.reduce((s, e) => s + (e.cpuCost ?? 0), 0);
            ram += entries.reduce((s, e) => s + (e.ramCost ?? 0), 0);
            gpu += entries.reduce((s, e) => s + (e.gpuCost ?? 0), 0);
            pv += entries.reduce((s, e) => s + (e.pvCost ?? 0), 0);
            network += entries.reduce((s, e) => s + (e.networkCost ?? 0), 0);
            total += entries.reduce((s, e) => s + (e.totalCost ?? 0), 0);
            carbon += entries.reduce((s, e) => s + (e.carbonCost ?? 0), 0);
            // Check if today's step is present
            const w = (entries[0] as any).window?.start;
            if (w && new Date(w).toISOString().substring(0, 10) === todayStr) {
              todayInSteps = true;
            }
          }

          // Add today's live cost if step=1d didn't include it
          const monthPrefix = `${selectedYear}-${String(currentMonth).padStart(2, '0')}`;
          if (!todayInSteps && todayStr.startsWith(monthPrefix)) {
            const { start: dStart, end: dEnd } = getDayWindow(todayStr, billingTz);
            const liveParams = new URLSearchParams({
              cluster: selectedCluster,
              window: `${dStart},${dEnd}`,
              aggregate: hasControllerFilter ? 'pod' : 'cluster',
              accumulate: 'true',
            });
            try {
              const liveRes = await fetchApi.fetch(`${baseUrl}/allocation?${liveParams}`);
              if (liveRes.ok) {
                const liveJson = await liveRes.json();
                let le = Object.values(liveJson.data?.[0] ?? {}).filter((e: any) => e.name !== '__idle__') as any[];
                if (hasControllerFilter) {
                  le = le.filter((e: any) => selectedControllers.includes(e.properties?.controller ?? ''));
                }
                if (le.length > 0) {
                  cpu += le.reduce((s: number, e: any) => s + (e.cpuCost ?? 0), 0);
                  ram += le.reduce((s: number, e: any) => s + (e.ramCost ?? 0), 0);
                  gpu += le.reduce((s: number, e: any) => s + (e.gpuCost ?? 0), 0);
                  pv += le.reduce((s: number, e: any) => s + (e.pvCost ?? 0), 0);
                  network += le.reduce((s: number, e: any) => s + (e.networkCost ?? 0), 0);
                  total += le.reduce((s: number, e: any) => s + (e.totalCost ?? 0), 0);
                  carbon += le.reduce((s: number, e: any) => s + (e.carbonCost ?? 0), 0);
                  daysCovered++;
                }
              }
            } catch { /* live cost is supplementary */ }
          }

          if (total > 0) {
            const td = daysInMonth(selectedYear, currentMonth);
            monthMap.set(currentMonth, {
              month: `${selectedYear}-${String(currentMonth).padStart(2, '0')}`,
              monthNum: currentMonth, cpuCost: cpu, ramCost: ram, gpuCost: gpu,
              pvCost: pv, networkCost: network, totalCost: total, carbonCost: carbon,
              daysCovered,
              totalDays: td,
            });
          }
        }
      } catch { /* current month is optional */ }
    }

    const items = Array.from(monthMap.values()).sort((a, b) => a.monthNum - b.monthNum);
    if (isPastYear) cache.current.set(ck, items);
    return items;
  }, [drillDown, baseUrl, selectedCluster, selectedYear, yearStart, yearEnd, billingTz, controllersParam]);

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

    const ck = `month:${selectedCluster}:${selectedYear}:${selectedMonth}:${controllersParam ?? ''}`;
    if (isPastMonth && cache.current.has(ck)) return cache.current.get(ck);

    // Past month → DB
    if (isPastMonth) {
      try {
        const params = new URLSearchParams({
          cluster: selectedCluster,
          year: String(selectedYear),
          month: String(selectedMonth),
        });
        if (controllersParam) params.set('controllers', controllersParam);
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

    // Current month (or DB empty) → OpenCost API step=1d, aggregate by pod
    const probeParams = new URLSearchParams({
      cluster: selectedCluster,
      window: `${start},${end}`,
      aggregate: 'pod',
      step: '1d',
    });
    const res = await fetchApi.fetch(`${baseUrl}/allocation?${probeParams}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenCost API error (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const steps = (json.data ?? []) as Record<string, AllocationItem>[];

    const hasControllerFilter = selectedControllers.length > 0;
    const items: DailySummaryItem[] = [];
    for (const stepMap of steps) {
      let entries = Object.values(stepMap).filter(e => e.name !== '__idle__');
      if (hasControllerFilter) {
        entries = entries.filter(e => selectedControllers.includes(e.properties?.controller ?? ''));
      }
      if (entries.length === 0) continue;
      const entry = entries[0];
      const dateStr = entry.window?.start
        ? new Date(entry.window.start).toISOString().substring(0, 10)
        : '';
      if (!dateStr) continue;
      items.push({
        date: dateStr,
        podCount: entries.length,
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
  }, [drillDown, baseUrl, selectedCluster, selectedYear, selectedMonth, start, end, isPastMonth, controllersParam]);

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

  // Fetch today's live cost from OpenCost API (for "In Progress" row)
  const { value: todayLiveCost } = useAsync(async (): Promise<DailySummaryItem | null> => {
    if (drillDown !== 'month' || !baseUrl) return null;
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: billingTz }).format(new Date());
    const monthPrefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    if (!todayStr.startsWith(monthPrefix)) return null;

    const { start: dStart, end: dEnd } = getDayWindow(todayStr, billingTz);
    const params = new URLSearchParams({
      cluster: selectedCluster,
      window: `${dStart},${dEnd}`,
      aggregate: 'pod',
      accumulate: 'true',
    });
    try {
      const res = await fetchApi.fetch(`${baseUrl}/allocation?${params}`);
      if (!res.ok) return null;
      const json = await res.json();
      let entries = Object.values(json.data?.[0] ?? {}).filter((e: any) => e.name !== '__idle__') as any[];
      if (selectedControllers.length > 0) {
        entries = entries.filter((e: any) => selectedControllers.includes(e.properties?.controller ?? ''));
      }
      if (entries.length === 0) return null;
      return {
        date: todayStr,
        podCount: entries.length,
        cpuCost: entries.reduce((s: number, e: any) => s + (e.cpuCost ?? 0), 0),
        ramCost: entries.reduce((s: number, e: any) => s + (e.ramCost ?? 0), 0),
        gpuCost: entries.reduce((s: number, e: any) => s + (e.gpuCost ?? 0), 0),
        pvCost: entries.reduce((s: number, e: any) => s + (e.pvCost ?? 0), 0),
        networkCost: entries.reduce((s: number, e: any) => s + (e.networkCost ?? 0), 0),
        totalCost: entries.reduce((s: number, e: any) => s + (e.totalCost ?? 0), 0),
        carbonCost: entries.reduce((s: number, e: any) => s + (e.carbonCost ?? 0), 0),
      };
    } catch { return null; }
  }, [drillDown, baseUrl, selectedCluster, selectedYear, selectedMonth, billingTz, controllersParam]);

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
      // For today, prefer live cost data over step=1d data (which may be $0)
      const effectiveData = (dateStr === todayStr && todayLiveCost)
        ? todayLiveCost
        : existing;

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
        estimatedCompletion = toTzString(new Date(nextMidnightEpoch * 1000).toISOString(), billingTz);
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
        podCount: effectiveData?.podCount ?? 0,
        cpuCost: effectiveData?.cpuCost ?? 0,
        ramCost: effectiveData?.ramCost ?? 0,
        gpuCost: effectiveData?.gpuCost ?? 0,
        pvCost: effectiveData?.pvCost ?? 0,
        networkCost: effectiveData?.networkCost ?? 0,
        totalCost: effectiveData?.totalCost ?? 0,
        carbonCost: effectiveData?.carbonCost ?? 0,
        status,
        dayOfWeek,
        estimatedCompletion,
        collectionRun: collectionRuns?.get(dateStr),
        isEstimated: dateStr === todayStr && !!todayLiveCost,
      });
    }
    return rows;
  }, [monthlyData, selectedYear, selectedMonth, billingTz, collectionRuns, todayLiveCost]);

  const monthlyTotals = useMemo(() => {
    if (!monthlyData) return null;
    const sum = (fn: (r: DailySummaryItem) => number) => monthlyData.reduce((s, r) => s + fn(r), 0);
    const totalDays = daysInMonth(selectedYear, selectedMonth);
    const collected = fullMonthData?.filter(r => r.status === 'collected').length ?? 0;
    const collecting = fullMonthData?.filter(r => r.status === 'collecting').length ?? 0;
    const missing = fullMonthData?.filter(r => r.status === 'missing').length ?? 0;

    // Add today's live cost if not already in monthlyData
    const todayInData = todayLiveCost && monthlyData.some(d => d.date === todayLiveCost.date);
    const liveDelta = (todayLiveCost && !todayInData) ? todayLiveCost : null;

    return {
      cpu: sum(r => r.cpuCost) + (liveDelta?.cpuCost ?? 0),
      ram: sum(r => r.ramCost) + (liveDelta?.ramCost ?? 0),
      pv: sum(r => r.pvCost) + (liveDelta?.pvCost ?? 0),
      network: sum(r => r.networkCost) + (liveDelta?.networkCost ?? 0),
      total: sum(r => r.totalCost) + (liveDelta?.totalCost ?? 0),
      carbon: sum(r => r.carbonCost) + (liveDelta?.carbonCost ?? 0),
      totalDays,
      collected,
      collecting,
      missing,
    };
  }, [monthlyData, selectedYear, selectedMonth, fullMonthData, todayLiveCost]);

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

  const sortedMonthData = useMemo(() => {
    if (!fullMonthData) return null;
    return [...fullMonthData].sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;
      switch (dailySortField) {
        case 'date': aVal = a.date; bVal = b.date; break;
        case 'status': aVal = a.status; bVal = b.status; break;
        case 'podCount': aVal = a.podCount; bVal = b.podCount; break;
        default: aVal = (a as any)[dailySortField] ?? 0; bVal = (b as any)[dailySortField] ?? 0;
      }
      if (typeof aVal === 'string') {
        const cmp = aVal.localeCompare(bVal as string);
        return dailySortDir === 'asc' ? cmp : -cmp;
      }
      return dailySortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
  }, [fullMonthData, dailySortField, dailySortDir]);

  const handleDailySort = useCallback((field: DailySortField) => {
    if (dailySortField === field) {
      setDailySortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setDailySortField(field);
      setDailySortDir(field === 'date' || field === 'status' ? 'asc' : 'desc');
    }
  }, [dailySortField]);

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

  const DailySortIcon = ({ field }: { field: DailySortField }) => {
    if (dailySortField !== field) return <span className="oc-sort-icon">{'\u2195'}</span>;
    return (
      <span className="oc-sort-icon oc-sort-active">
        {dailySortDir === 'asc' ? '\u2191' : '\u2193'}
      </span>
    );
  };

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
      <PluginHeader title="Cost Report" />
      <Container my="4">
        <Text variant="body-medium" color="secondary">
          Cloud cost tracking and analysis for EC2 and EKS, powered by <Link href="https://www.opencost.io" target="_blank" rel="noopener noreferrer">OpenCost</Link>
        </Text>

        {/* ── Breadcrumb ── */}
        <Box mt="4" className="oc-breadcrumb">
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

        {/* ── Filters ── */}
        <Box mt="3" p="3" className="oc-section-box">
          <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
            Filters
          </Text>
          <Flex gap="3" align="end" style={{ flexWrap: 'wrap' }}>
            <Select label="Cluster" size="small" options={clusterOptions}
              selectedKey={selectedCluster} onSelectionChange={key => handleClusterChange(key as string)} />
            <Select label="Year" size="small" options={yearOptions}
              selectedKey={String(selectedYear)} onSelectionChange={key => handleYearChange(key as string)} />
            {(drillDown === 'year' || drillDown === 'month') && availableControllers.length > 0 && (
              <div className="oc-native-select" ref={controllerDropdownRef} style={{ position: 'relative' }}>
                <label className="oc-native-select-label">Controller</label>
                <button
                  className="oc-controller-toggle"
                  onClick={() => setControllerDropdownOpen(o => !o)}
                >
                  {selectedControllers.length === 0
                    ? `All (${availableControllers.length})`
                    : `${selectedControllers.length} selected`}
                  <span style={{ marginLeft: 4, opacity: 0.5 }}>{controllerDropdownOpen ? '\u25B2' : '\u25BC'}</span>
                </button>
                {controllerDropdownOpen && (() => {
                  const q = controllerSearch.toLowerCase();
                  const filtered = q
                    ? availableControllers.filter(c => c.toLowerCase().includes(q))
                    : availableControllers;
                  return (
                  <div className="oc-controller-dropdown">
                    <div className="oc-controller-search">
                      <input
                        type="text"
                        placeholder="Search controllers..."
                        value={controllerSearch}
                        onChange={e => setControllerSearch(e.target.value)}
                        autoFocus
                      />
                    </div>
                    <div className="oc-controller-actions">
                      <button onClick={() => setSelectedControllers(prev => {
                        const set = new Set(prev);
                        for (const c of filtered) set.add(c);
                        return Array.from(set);
                      })}>Select All{q ? ` (${filtered.length})` : ''}</button>
                      <button onClick={() => {
                        if (q) {
                          const remove = new Set(filtered);
                          setSelectedControllers(prev => prev.filter(c => !remove.has(c)));
                        } else {
                          setSelectedControllers([]);
                        }
                      }}>Clear{q ? ` (${filtered.length})` : ''}</button>
                    </div>
                    <div className="oc-controller-list">
                      {filtered.map(c => (
                        <label key={c} className="oc-controller-option">
                          <input
                            type="checkbox"
                            checked={selectedControllers.includes(c)}
                            onChange={e => {
                              if (e.target.checked) {
                                setSelectedControllers(prev => [...prev, c]);
                              } else {
                                setSelectedControllers(prev => prev.filter(x => x !== c));
                              }
                            }}
                          />
                          <span>{c}</span>
                        </label>
                      ))}
                      {filtered.length === 0 && (
                        <div className="oc-controller-no-match">No match</div>
                      )}
                    </div>
                  </div>
                  );
                })()}
              </div>
            )}
          </Flex>
          {selectedControllers.length > 0 && (
            <div className="oc-controller-chips" style={{ marginTop: 8 }}>
              {selectedControllers.map(c => (
                <span key={c} className="oc-controller-chip">
                  {c}
                  <span
                    className="oc-controller-chip-remove"
                    onClick={() => setSelectedControllers(prev => prev.filter(x => x !== c))}
                  >
                    {'\u00D7'}
                  </span>
                </span>
              ))}
            </div>
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
                    <Text weight="bold" className="oc-summary-value">{formatCost(yearlyTotals.network)}</Text>
                    <Text variant="body-x-small" color="secondary">Network Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{yearlyTotals.months}</Text>
                    <Text variant="body-x-small" color="secondary">Months</Text>
                  </div>
                </div>

                {yearlyTotals.total > 0 && (() => {
                  const allSegments = [
                    { label: 'CPU', value: yearlyTotals.cpu, color: '#60a5fa' },
                    { label: 'RAM', value: yearlyTotals.ram, color: '#a78bfa' },
                    { label: 'PV', value: yearlyTotals.pv, color: '#34d399' },
                    { label: 'Network', value: yearlyTotals.network, color: '#fbbf24' },
                  ];
                  const barSegments = allSegments.filter(s => s.value > 0);
                  return (
                    <div className="oc-breakdown">
                      <div className="oc-breakdown-bar">
                        {barSegments.map(s => {
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
                        {allSegments.map(s => {
                          const pct = yearlyTotals.total > 0 ? (s.value / yearlyTotals.total) * 100 : 0;
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
                  <span className="oc-count-badge">{yearlyData.length}</span>
                  <Text variant="body-small" color="secondary">months</Text>
                  {yearlyData.length > 0 && (
                    <button className="oc-export-btn" onClick={() => downloadCsv(
                      ['Month', 'CPU', 'RAM', 'GPU', 'PV', 'Network', 'Total', 'Carbon'],
                      yearlyData.map(r => [r.month, r.cpuCost, r.ramCost, r.gpuCost, r.pvCost, r.networkCost, r.totalCost, r.carbonCost]),
                      `backstage-${selectedCluster}-${selectedYear}-monthly-${randomHash()}.csv`,
                    )}>{'\u2913'} Export CSV</button>
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
                          <td>{row.month}{row.daysCovered < row.totalDays ? ' *' : ''}</td>
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
                    {yearlyTotals && (() => {
                      const collectedDays = yearlyData.reduce((s, r) => s + r.daysCovered, 0);
                      const totalDaysYear = yearlyData.reduce((s, r) => s + r.totalDays, 0);
                      const m = yearlyTotals.months || 1;
                      return (
                      <tfoot>
                        <tr className="oc-daily-avg-row">
                          <td>Monthly Avg</td>
                          <td>{yearlyTotals.months} months</td>
                          <td className="oc-cost">{formatCost(yearlyTotals.cpu / m)}</td>
                          <td className="oc-cost">{formatCost(yearlyTotals.ram / m)}</td>
                          <td className="oc-cost">-</td>
                          <td className="oc-cost">{formatCost(yearlyTotals.pv / m)}</td>
                          <td className="oc-cost">{formatCost(yearlyTotals.network / m)}</td>
                          <td className="oc-cost oc-cost-total">{formatCost(yearlyTotals.total / m)}</td>
                          <td className="oc-cost oc-carbon">{formatCarbon(yearlyTotals.carbon / m)}</td>
                        </tr>
                        <tr>
                          <td><strong>Total</strong></td>
                          <td><strong>{collectedDays}/{totalDaysYear} days</strong></td>
                          <td className="oc-cost"><strong>{formatCost(yearlyTotals.cpu)}</strong></td>
                          <td className="oc-cost"><strong>{formatCost(yearlyTotals.ram)}</strong></td>
                          <td className="oc-cost"><strong>-</strong></td>
                          <td className="oc-cost"><strong>{formatCost(yearlyTotals.pv)}</strong></td>
                          <td className="oc-cost"><strong>{formatCost(yearlyTotals.network)}</strong></td>
                          <td className="oc-cost oc-cost-total"><strong>{formatCost(yearlyTotals.total)}</strong></td>
                          <td className="oc-cost oc-carbon"><strong>{formatCarbon(yearlyTotals.carbon)}</strong></td>
                        </tr>
                        {yearlyData.some(r => r.daysCovered < r.totalDays) && (
                          <tr>
                            <td colSpan={9} className="oc-cost-estimated" style={{ fontStyle: 'italic', fontSize: '0.75rem' }}>
                              * Total includes in-progress costs for the current month. Values may change until the month ends.
                            </td>
                          </tr>
                        )}
                      </tfoot>
                      );
                    })()}
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
                <div className="oc-summary-split">
                <div className="oc-summary-left">
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
                    <Text weight="bold" className="oc-summary-value">{formatCost(monthlyTotals.network)}</Text>
                    <Text variant="body-x-small" color="secondary">Network Cost</Text>
                  </div>
                </div>

                {/* Cost breakdown bar */}
                {monthlyTotals.total > 0 && (() => {
                  const allSegments = [
                    { label: 'CPU', value: monthlyTotals.cpu, color: '#60a5fa' },
                    { label: 'RAM', value: monthlyTotals.ram, color: '#a78bfa' },
                    { label: 'PV', value: monthlyTotals.pv, color: '#34d399' },
                    { label: 'Network', value: monthlyTotals.network, color: '#fbbf24' },
                  ];
                  const barSegments = allSegments.filter(s => s.value > 0);
                  return (
                    <div className="oc-breakdown">
                      <div className="oc-breakdown-bar">
                        {barSegments.map(s => {
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
                        {allSegments.map(s => {
                          const pct = monthlyTotals.total > 0 ? (s.value / monthlyTotals.total) * 100 : 0;
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
                </div>{/* end oc-summary-left */}

                {/* Right: Collection calendar (compact) */}
                {fullMonthData && (() => {
                  const firstDow = new Date(Date.UTC(selectedYear, selectedMonth - 1, 1, 12)).getDay();
                  const statusColor: Record<SnapshotStatus, string> = {
                    collected: '#34d399', collecting: '#60a5fa', missing: '#f87171', pending: '#2a2a2a',
                  };
                  const statusLbl: Record<SnapshotStatus, string> = {
                    collected: 'Collected', collecting: 'In Progress', missing: 'Missing', pending: 'Pending',
                  };
                  return (
                    <div className="oc-summary-right">
                      <div className="oc-calendar-header">
                        <Text variant="body-small" weight="bold">
                          Collection {monthlyTotals.collected}/{monthlyTotals.totalDays}
                          <span style={{ fontWeight: 'normal', opacity: 0.6 }}> ({Math.round((monthlyTotals.collected / monthlyTotals.totalDays) * 100)}%)</span>
                        </Text>
                      </div>
                      <div className="oc-calendar-grid">
                        <div className="oc-calendar-week-label" />
                        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => (
                          <div key={d} className="oc-calendar-dow">{d}</div>
                        ))}
                        {(() => {
                          const cells: React.ReactNode[] = [];
                          let weekNum = 1;
                          // Week label for first row
                          cells.push(<div key="w1" className="oc-calendar-week-label">W{weekNum}</div>);
                          // Leading padding
                          for (let i = 0; i < firstDow; i++) {
                            cells.push(<div key={`pad-${i}`} className="oc-calendar-cell" />);
                          }
                          let colIdx = firstDow;
                          for (const row of fullMonthData) {
                            if (colIdx === 7) {
                              colIdx = 0;
                              weekNum++;
                              cells.push(<div key={`w${weekNum}`} className="oc-calendar-week-label">W{weekNum}</div>);
                            }
                            const hasData = row.status === 'collected' || row.status === 'collecting';
                            cells.push(
                              <div
                                key={row.date}
                                className={`oc-calendar-cell oc-has-tooltip${row.status === 'collecting' ? ' oc-stamp-collecting' : ''}${hasData ? ' oc-calendar-clickable' : ''}`}
                                onClick={hasData ? () => goToDay(row.date) : undefined}
                              >
                                <span
                                  className={`oc-calendar-stamp${row.status === 'missing' ? ' oc-stamp-missing' : row.status === 'pending' ? ' oc-stamp-pending' : ''}`}
                                  style={row.status !== 'missing' ? { background: statusColor[row.status] } : undefined}
                                >
                                  {parseInt(row.date.substring(8, 10), 10)}
                                </span>
                                <span className="oc-tooltip">{`${row.date} (${row.dayOfWeek}): ${statusLbl[row.status]}`}</span>
                              </div>,
                            );
                            colIdx++;
                          }
                          return cells;
                        })()}
                      </div>
                    </div>
                  );
                })()}
                </div>{/* end oc-summary-split */}
              </Box>
            )}

            {/* Daily table */}
            <Box mt="3" p="3" className="oc-section-box">
              <Flex justify="between" align="center" mb="3">
                <Text variant="body-medium" weight="bold">Daily Cost Breakdown</Text>
                <Flex align="center" gap="2">
                  <span className="oc-count-badge">{fullMonthData.length}</span>
                  <Text variant="body-small" color="secondary">days</Text>
                  <button className="oc-export-btn" onClick={() => downloadCsv(
                    ['Date', 'Day', 'Status', 'CPU', 'RAM', 'GPU', 'PV', 'Network', 'Total', 'Carbon'],
                    sortedMonthData!.map(r => [r.date, r.dayOfWeek, r.status, r.cpuCost, r.ramCost, r.gpuCost, r.pvCost, r.networkCost, r.totalCost, r.carbonCost]),
                    `backstage-${selectedCluster}-${monthLabel}-daily-${randomHash()}.csv`,
                  )}>{'\u2913'} Export CSV</button>
                </Flex>
              </Flex>

              <div className="oc-table-wrapper">
                <table className="oc-table">
                  <thead>
                    <tr>
                      <th onClick={() => handleDailySort('date')}>Date <DailySortIcon field="date" /></th>
                      <th onClick={() => handleDailySort('status')}>Status <DailySortIcon field="status" /></th>
                      <th onClick={() => handleDailySort('cpuCost')}>CPU <DailySortIcon field="cpuCost" /></th>
                      <th onClick={() => handleDailySort('ramCost')}>RAM <DailySortIcon field="ramCost" /></th>
                      <th onClick={() => handleDailySort('gpuCost')}>GPU <DailySortIcon field="gpuCost" /></th>
                      <th onClick={() => handleDailySort('pvCost')}>PV <DailySortIcon field="pvCost" /></th>
                      <th onClick={() => handleDailySort('networkCost')}>Network <DailySortIcon field="networkCost" /></th>
                      <th onClick={() => handleDailySort('totalCost')}>Total <DailySortIcon field="totalCost" /></th>
                      <th onClick={() => handleDailySort('carbonCost')}>Carbon <DailySortIcon field="carbonCost" /></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedMonthData!.map(row => {
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
                        const lines = [`Finalizes: ${row.estimatedCompletion}`];
                        if (backendConfig?.dailyCollectorCron) {
                          const cronParts = backendConfig.dailyCollectorCron.split(/\s+/);
                          if (cronParts.length >= 2) {
                            const cronTz = backendConfig.timezone ?? billingTz;
                            const hh = cronParts[1].padStart(2, '0');
                            const mm = cronParts[0].padStart(2, '0');
                            const nextDay = new Date(new Date(`${row.date}T12:00:00Z`).getTime() + 86400000);
                            const collectDate = nextDay.toISOString().substring(0, 10);
                            lines.push(`Collects: ${collectDate} ${hh}:${mm} (${cronTz})`);
                          }
                        }
                        statusTooltip = lines.join('\n');
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
                          <td>{row.date} <span className={`oc-day-of-week${row.dayOfWeek === 'Sun' ? ' oc-dow-sun' : row.dayOfWeek === 'Sat' ? ' oc-dow-sat' : ''}`}>({row.dayOfWeek})</span></td>
                          <td title={statusTooltip}>
                            <span
                              className={row.status === 'collecting' ? 'oc-led-pulse' : undefined}
                              style={{
                                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                                backgroundColor: ledColor, marginRight: 6, verticalAlign: 'middle',
                              }}
                            />
                            {statusLabel}
                          </td>
                          <td className={`oc-cost${row.isEstimated ? ' oc-cost-estimated' : ''}`}>{hasData ? `${row.isEstimated ? '~' : ''}${formatCost(row.cpuCost)}` : '-'}</td>
                          <td className={`oc-cost${row.isEstimated ? ' oc-cost-estimated' : ''}`}>{hasData ? `${row.isEstimated ? '~' : ''}${formatCost(row.ramCost)}` : '-'}</td>
                          <td className={`oc-cost${row.isEstimated ? ' oc-cost-estimated' : ''}`}>{hasData ? `${row.isEstimated ? '~' : ''}${formatCost(row.gpuCost)}` : '-'}</td>
                          <td className={`oc-cost${row.isEstimated ? ' oc-cost-estimated' : ''}`}>{hasData ? `${row.isEstimated ? '~' : ''}${formatCost(row.pvCost)}` : '-'}</td>
                          <td className={`oc-cost${row.isEstimated ? ' oc-cost-estimated' : ''}`}>{hasData ? `${row.isEstimated ? '~' : ''}${formatCost(row.networkCost)}` : '-'}</td>
                          <td className={`oc-cost oc-cost-total${row.isEstimated ? ' oc-cost-estimated' : ''}`}>{hasData ? `${row.isEstimated ? '~' : ''}${formatCost(row.totalCost)}` : '-'}</td>
                          <td className={`oc-cost oc-carbon${row.isEstimated ? ' oc-cost-estimated' : ''}`}>{hasData ? `${row.isEstimated ? '~' : ''}${formatCarbon(row.carbonCost)}` : '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {monthlyTotals && (() => {
                    const d = monthlyTotals.collected || 1;
                    return (
                    <tfoot>
                      <tr className="oc-daily-avg-row">
                        <td>Daily Avg</td>
                        <td>{monthlyTotals.collected} days</td>
                        <td className="oc-cost">{formatCost(monthlyTotals.cpu / d)}</td>
                        <td className="oc-cost">{formatCost(monthlyTotals.ram / d)}</td>
                        <td className="oc-cost">-</td>
                        <td className="oc-cost">{formatCost(monthlyTotals.pv / d)}</td>
                        <td className="oc-cost">{formatCost(monthlyTotals.network / d)}</td>
                        <td className="oc-cost oc-cost-total">{formatCost(monthlyTotals.total / d)}</td>
                        <td className="oc-cost oc-carbon">{formatCarbon(monthlyTotals.carbon / d)}</td>
                      </tr>
                      <tr>
                        <td><strong>Total</strong></td>
                        <td><strong>{monthlyTotals.collected}/{monthlyTotals.totalDays} days</strong></td>
                        <td className="oc-cost"><strong>{formatCost(monthlyTotals.cpu)}</strong></td>
                        <td className="oc-cost"><strong>{formatCost(monthlyTotals.ram)}</strong></td>
                        <td className="oc-cost"><strong>-</strong></td>
                        <td className="oc-cost"><strong>{formatCost(monthlyTotals.pv)}</strong></td>
                        <td className="oc-cost"><strong>{formatCost(monthlyTotals.network)}</strong></td>
                        <td className="oc-cost oc-cost-total"><strong>{formatCost(monthlyTotals.total)}</strong></td>
                        <td className="oc-cost oc-carbon"><strong>{formatCarbon(monthlyTotals.carbon)}</strong></td>
                      </tr>
                      {fullMonthData?.some(r => r.isEstimated) && (
                        <tr>
                          <td colSpan={9} className="oc-cost-estimated" style={{ fontStyle: 'italic', fontSize: '0.75rem' }}>
                            ~ Values are estimated from real-time data and may change until the day ends.
                          </td>
                        </tr>
                      )}
                    </tfoot>
                    );
                  })()}
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
                  {`Metric period: ${toTzString(dayMetricWindow.start, billingTz)} ~ ${toTzString(dayMetricWindow.end, billingTz)}`}
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
                  <Text weight="bold" className="oc-summary-value">{formatCost(dayTotals.pv)}</Text>
                  <Text variant="body-x-small" color="secondary">PV Cost</Text>
                </div>
                <div className="oc-summary-card">
                  <Text weight="bold" className="oc-summary-value">{formatCost(dayTotals.network)}</Text>
                  <Text variant="body-x-small" color="secondary">Network Cost</Text>
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

              {dayTotals.total > 0 && (() => {
                const allSegments = [
                  { label: 'CPU', value: dayTotals.cpu, color: '#60a5fa' },
                  { label: 'RAM', value: dayTotals.ram, color: '#a78bfa' },
                  { label: 'PV', value: dayTotals.pv, color: '#34d399' },
                  { label: 'Network', value: dayTotals.network, color: '#fbbf24' },
                ];
                const barSegments = allSegments.filter(s => s.value > 0);
                return (
                  <div className="oc-breakdown">
                    <div className="oc-breakdown-bar">
                      {barSegments.map(s => {
                        const pct = (s.value / dayTotals.total) * 100;
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
                      {allSegments.map(s => {
                        const pct = dayTotals.total > 0 ? (s.value / dayTotals.total) * 100 : 0;
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
                    )}>{'\u2913'} Export CSV</button>
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
                    <Text weight="bold" className="oc-summary-value">{formatCost(podTotals.pv)}</Text>
                    <Text variant="body-x-small" color="secondary">PV Cost</Text>
                  </div>
                  <div className="oc-summary-card">
                    <Text weight="bold" className="oc-summary-value">{formatCost(podTotals.network)}</Text>
                    <Text variant="body-x-small" color="secondary">Network Cost</Text>
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
                  <span className="oc-count-badge">{podDailyData.length}</span>
                  <Text variant="body-small" color="secondary">days</Text>
                  {podDailyData.length > 0 && (
                    <button className="oc-export-btn" onClick={() => downloadCsv(
                      ['Date', 'CPU', 'RAM', 'GPU', 'PV', 'Network', 'Total', 'Carbon'],
                      podDailyData.map(r => [r.date, r.cpuCost, r.ramCost, r.gpuCost, r.pvCost, r.networkCost, r.totalCost, r.carbonCost]),
                      `backstage-${selectedCluster}-${selectedPod}-daily-${randomHash()}.csv`,
                    )}>{'\u2913'} Export CSV</button>
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
                    {podTotals && (() => {
                      const d = podTotals.days || 1;
                      return (
                      <tfoot>
                        <tr className="oc-daily-avg-row">
                          <td>Daily Avg</td>
                          <td className="oc-cost">{formatCost(podTotals.cpu / d)}</td>
                          <td className="oc-cost">{formatCost(podTotals.ram / d)}</td>
                          <td className="oc-cost">-</td>
                          <td className="oc-cost">{formatCost(podTotals.pv / d)}</td>
                          <td className="oc-cost">{formatCost(podTotals.network / d)}</td>
                          <td className="oc-cost oc-cost-total">{formatCost(podTotals.total / d)}</td>
                          <td className="oc-cost oc-carbon">{formatCarbon(podTotals.carbon / d)}</td>
                        </tr>
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
                      );
                    })()}
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
