import React, { useState, useMemo, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  PluginHeader,
  Container,
  Box,
  Flex,
  Text,
  Skeleton,
  Alert,
  Link,
  Tooltip,
  TooltipTrigger,
  ButtonIcon,
} from '@backstage/ui';
import {
  useApi,
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { useAsync } from 'react-use';
import {
  daysInMonth,
  formatCost,
  formatCarbon,
  downloadCsv,
  randomHash,
  truncate1,
  getDayWindow,
} from '../OpenCostPage/utils';
import '../OpenCostPage/OpenCostPage.css';
import './CostAdjustPage.css';

/* ─── Types ─── */

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

type DataStatus = 'collected' | 'collecting' | 'missing' | 'pending';

interface DayRow extends DailySummaryItem {
  dayOfWeek: string;
  status: DataStatus;
}

/* ─── Component ─── */

export const CostAdjustPage = () => {
  const configApi = useApi(configApiRef);
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const cluster = searchParams.get('cluster') ?? 'default';
  const year = Number(searchParams.get('year')) || new Date().getFullYear();
  const month = Number(searchParams.get('month')) || new Date().getMonth() + 1;
  const controllersParam = searchParams.get('controllers') ?? undefined;
  const monthLabel = `${year}-${String(month).padStart(2, '0')}`;

  const billingTz = useMemo(
    () => configApi.getOptionalString('opencost.timezone') ?? 'UTC',
    [configApi],
  );

  /* ── Fetch data ── */
  const [baseUrl, setBaseUrl] = useState('');
  useAsync(async () => {
    const url = await discoveryApi.getBaseUrl('opencost');
    setBaseUrl(url);
  }, [discoveryApi]);

  const { value: rawData, loading, error } = useAsync(async (): Promise<DailySummaryItem[] | null> => {
    if (!baseUrl) return null;
    const params = new URLSearchParams({
      cluster,
      year: String(year),
      month: String(month),
    });
    if (controllersParam) params.set('controllers', controllersParam);
    const res = await fetchApi.fetch(`${baseUrl}/costs/daily-summary?${params}`);
    if (res.ok) {
      const json = await res.json();
      return (json.data as DailySummaryItem[]) ?? null;
    }
    return null;
  }, [baseUrl, cluster, year, month, controllersParam]);

  // Fetch today's live cost from OpenCost API (for "In Progress" row)
  const { value: todayLiveCost } = useAsync(async (): Promise<DailySummaryItem | null> => {
    if (!baseUrl) return null;
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: billingTz }).format(new Date());
    const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
    if (!todayStr.startsWith(monthPrefix)) return null;

    const { start: dStart, end: dEnd } = getDayWindow(todayStr, billingTz);
    const params = new URLSearchParams({
      cluster,
      window: `${dStart},${dEnd}`,
      aggregate: 'pod',
      accumulate: 'true',
    });
    try {
      const res = await fetchApi.fetch(`${baseUrl}/allocation?${params}`);
      if (!res.ok) return null;
      const json = await res.json();
      let entries = Object.values(json.data?.[0] ?? {}).filter((e: any) => e.name !== '__idle__') as any[];
      if (controllersParam) {
        const ctrl = controllersParam.split(',');
        entries = entries.filter((e: any) => ctrl.includes(e.properties?.controller ?? ''));
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
  }, [baseUrl, cluster, year, month, billingTz, controllersParam]);

  /* ── Build full month rows ── */
  const fullRows = useMemo((): DayRow[] => {
    const total = daysInMonth(year, month);
    const dataMap = new Map((rawData ?? []).map(d => [d.date, d]));
    const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: billingTz, weekday: 'short' });

    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: billingTz }).format(new Date());
    const rows: DayRow[] = [];
    for (let day = 1; day <= total; day++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const existing = dataMap.get(dateStr);
      // For today, prefer live cost data over step=1d data (which may be $0)
      const effectiveData = (dateStr === todayStr && todayLiveCost)
        ? todayLiveCost
        : existing;

      let status: DataStatus;
      if (dateStr === todayStr) {
        status = 'collecting';
      } else if (existing) {
        status = 'collected';
      } else if (dateStr > todayStr) {
        status = 'pending';
      } else {
        status = 'missing';
      }

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
        dayOfWeek: weekdayFmt.format(new Date(`${dateStr}T12:00:00Z`)),
        status,
      });
    }
    return rows;
  }, [rawData, year, month, billingTz, todayLiveCost]);

  /* ── Adjustment state ── */
  const [excludedDates, setExcludedDates] = useState<Set<string>>(new Set());

  const costFields = ['cpu', 'ram', 'gpu', 'pv', 'network'] as const;
  type CostField = typeof costFields[number];
  const costFieldLabels: Record<CostField, string> = { cpu: 'CPU', ram: 'RAM', gpu: 'GPU', pv: 'PV', network: 'Network' };

  const [fieldPercents, setFieldPercents] = useState<Record<CostField, number>>({ cpu: 0, ram: 0, gpu: 0, pv: 0, network: 0 });
  const [fieldDirections, setFieldDirections] = useState<Record<CostField, 'markup' | 'discount'>>({ cpu: 'markup', ram: 'markup', gpu: 'markup', pv: 'markup', network: 'markup' });

  const multipliers = useMemo(() => {
    const m: Record<CostField, number> = { cpu: 1, ram: 1, gpu: 1, pv: 1, network: 1 };
    for (const f of costFields) {
      if (fieldPercents[f] === 0) continue;
      m[f] = fieldDirections[f] === 'markup' ? 1 + fieldPercents[f] / 100 : 1 - fieldPercents[f] / 100;
    }
    return m;
  }, [fieldPercents, fieldDirections]);

  const hasAnyAdjustment = useMemo(() => costFields.some(f => fieldPercents[f] > 0), [fieldPercents]);

  const applyRow = (r: DayRow) => {
    const adj = {
      cpu: r.cpuCost * multipliers.cpu,
      ram: r.ramCost * multipliers.ram,
      gpu: r.gpuCost * multipliers.gpu,
      pv: r.pvCost * multipliers.pv,
      network: r.networkCost * multipliers.network,
    };
    return { ...adj, total: adj.cpu + adj.ram + adj.gpu + adj.pv + adj.network, carbon: r.carbonCost };
  };

  const toggleDate = (date: string) => {
    setExcludedDates(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const weekendDates = useMemo(() => fullRows.filter(r => r.dayOfWeek === 'Sat' || r.dayOfWeek === 'Sun').map(r => r.date), [fullRows]);
  const missingDates = useMemo(() => fullRows.filter(r => r.totalCost === 0).map(r => r.date), [fullRows]);

  const weekendsExcluded = useMemo(() => weekendDates.length > 0 && weekendDates.every(d => excludedDates.has(d)), [weekendDates, excludedDates]);
  const missingExcluded = useMemo(() => missingDates.length > 0 && missingDates.every(d => excludedDates.has(d)), [missingDates, excludedDates]);

  const toggleWeekends = () => {
    setExcludedDates(prev => {
      const next = new Set(prev);
      if (weekendsExcluded) {
        for (const d of weekendDates) next.delete(d);
      } else {
        for (const d of weekendDates) next.add(d);
      }
      return next;
    });
  };

  const toggleMissing = () => {
    setExcludedDates(prev => {
      const next = new Set(prev);
      if (missingExcluded) {
        for (const d of missingDates) next.delete(d);
      } else {
        for (const d of missingDates) next.add(d);
      }
      return next;
    });
  };

  const clearExclusions = () => setExcludedDates(new Set());

  /* ── Sort state ── */
  type SortField = 'date' | 'status' | 'cpuCost' | 'ramCost' | 'gpuCost' | 'pvCost' | 'networkCost' | 'totalCost' | 'carbonCost';
  type SortDir = 'asc' | 'desc';
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'date' || field === 'status' ? 'asc' : 'desc');
    }
  }, [sortField]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="oc-sort-icon">{'\u2195'}</span>;
    return (
      <span className="oc-sort-icon oc-sort-active">
        {sortDir === 'asc' ? '\u2191' : '\u2193'}
      </span>
    );
  };

  const sortedRows = useMemo(() => {
    return [...fullRows].sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;
      switch (sortField) {
        case 'date': aVal = a.date; bVal = b.date; break;
        case 'status': {
          const excluded_a = excludedDates.has(a.date);
          const excluded_b = excludedDates.has(b.date);
          aVal = excluded_a ? 'Excluded' : a.status;
          bVal = excluded_b ? 'Excluded' : b.status;
          break;
        }
        default: aVal = (a as any)[sortField] ?? 0; bVal = (b as any)[sortField] ?? 0;
      }
      if (typeof aVal === 'string') {
        const cmp = aVal.localeCompare(bVal as string);
        return sortDir === 'asc' ? cmp : -cmp;
      }
      return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
  }, [fullRows, sortField, sortDir, excludedDates]);

  /* ── Computed totals ── */
  const totals = useMemo(() => {
    let cpu = 0, ram = 0, pv = 0, network = 0, total = 0, carbon = 0;
    let inclCpu = 0, inclRam = 0, inclPv = 0, inclNetwork = 0, inclTotal = 0, inclCarbon = 0;
    let adjCpu = 0, adjRam = 0, adjPv = 0, adjNetwork = 0, adjTotal = 0, adjCarbon = 0;
    const included: DayRow[] = [];
    const collectedCount = fullRows.filter(r => r.status === 'collected').length;

    for (const r of fullRows) {
      cpu += r.cpuCost;
      ram += r.ramCost;
      pv += r.pvCost;
      network += r.networkCost;
      total += r.totalCost;
      carbon += r.carbonCost;
      if (!excludedDates.has(r.date)) {
        inclCpu += r.cpuCost;
        inclRam += r.ramCost;
        inclPv += r.pvCost;
        inclNetwork += r.networkCost;
        inclTotal += r.totalCost;
        inclCarbon += r.carbonCost;
        const adj = applyRow(r);
        adjCpu += adj.cpu;
        adjRam += adj.ram;
        adjPv += adj.pv;
        adjNetwork += adj.network;
        adjTotal += adj.total;
        adjCarbon += adj.carbon;
        included.push(r);
      }
    }
    return {
      cpu, ram, pv, network, total, carbon,
      inclCpu, inclRam, inclPv, inclNetwork, inclTotal, inclCarbon,
      adjCpu, adjRam, adjPv, adjNetwork, adjTotal, adjCarbon,
      included, collectedCount, totalDays: fullRows.length,
    };
  }, [fullRows, excludedDates, multipliers]);

  const diffPercent = totals.total > 0
    ? ((totals.adjTotal - totals.total) / totals.total) * 100
    : 0;
  const diffClass = diffPercent > 0.05 ? 'positive' : diffPercent < -0.05 ? 'negative' : 'neutral';

  /* ── Export ── */
  const handleExport = () => {
    const statusLabelMap: Record<DataStatus, string> = { collected: 'Collected', collecting: 'In Progress', missing: 'Missing', pending: 'Pending' };
    const headers = hasAnyAdjustment
      ? ['Date', 'Day', 'Status', 'CPU', 'RAM', 'GPU', 'PV', 'Network', 'Total', 'Adjusted', 'Carbon']
      : ['Date', 'Day', 'Status', 'CPU', 'RAM', 'GPU', 'PV', 'Network', 'Total', 'Carbon'];
    const rows = totals.included.map(r => {
      const adj = applyRow(r);
      const base = [
        r.date,
        r.dayOfWeek,
        statusLabelMap[r.status],
        truncate1(r.cpuCost),
        truncate1(r.ramCost),
        truncate1(r.gpuCost),
        truncate1(r.pvCost),
        truncate1(r.networkCost),
        truncate1(r.totalCost),
      ];
      if (hasAnyAdjustment) base.push(truncate1(adj.total));
      base.push(truncate1(adj.carbon));
      return base;
    });
    const now = new Date();
    const datePart = new Intl.DateTimeFormat('en-CA', { timeZone: billingTz }).format(now).replace(/-/g, '');
    const timePart = new Intl.DateTimeFormat('en-GB', {
      timeZone: billingTz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(now).replace(/:/g, '');
    const tzShort = billingTz.replace(/\//g, '-');
    downloadCsv(headers, rows, `cost-${cluster}-custom-daily-${monthLabel}-${datePart}T${timePart}-${tzShort}.csv`);
  };

  const goBack = () => {
    const params = new URLSearchParams({ cluster, year: String(year), month: String(month) });
    navigate(`/cost-report?${params}`);
  };

  /* ── Calendar helpers ── */
  const statusColor: Record<DataStatus, string> = {
    collected: '#34d399', collecting: '#60a5fa', missing: '#f87171', pending: '#2a2a2a',
  };

  return (
    <>
      <PluginHeader title="Custom Export" />
      <Container my="4">
        <Text variant="body-medium" color="secondary">
          Cloud cost tracking and analysis for EC2 and EKS, powered by <Link href="https://www.opencost.io" target="_blank" rel="noopener noreferrer">OpenCost</Link>
        </Text>

        {/* ── Breadcrumb ── */}
        <Box mt="4" className="oc-breadcrumb">
          <span
            className="oc-crumb-link"
            onClick={() => {
              const p = new URLSearchParams({ cluster, year: String(year) });
              navigate(`/cost-report?${p}`);
            }}
          >
            {year}
          </span>
          <span className="oc-crumb-sep">/</span>
          <span
            className="oc-crumb-link"
            onClick={goBack}
          >
            {monthLabel}
          </span>
          <span className="oc-crumb-sep">/</span>
          <span className="oc-crumb-active">Custom Export</span>
        </Box>

        {loading && (
          <Box mt="4">
            <Skeleton height={200} />
          </Box>
        )}

        {error && (
          <Box mt="4">
            <Alert status="danger" title={`Failed to load cost data: ${String(error)}`} />
          </Box>
        )}

        {!loading && !error && rawData && (
          <>
            {/* ── Summary (same layout as drill-down page) ── */}
            <Box mt="3" p="3" className="oc-section-box">
              <Flex justify="between" align="center" mb="3">
                <Text variant="body-medium" weight="bold">Summary</Text>
                <span />
              </Flex>

              <div className="oc-summary-split">
                {/* Left: summary cards + breakdown */}
                <div className="oc-summary-left">
                  <div className="oc-summary-bar">
                    <div className="oc-summary-card">
                      <Text weight="bold" className="oc-summary-value">
                        {hasAnyAdjustment || excludedDates.size > 0
                          ? <><span className="oc-adjust-prev-cost">{formatCost(totals.inclTotal)}</span> <span className="oc-adjust-arrow">{'\u2192'}</span> {formatCost(totals.adjTotal)}</>
                          : formatCost(totals.inclTotal)}
                      </Text>
                      <Text variant="body-x-small" color="secondary">
                        Total Cost
                        {(hasAnyAdjustment || excludedDates.size > 0) && (
                          <span className={`oc-adjust-summary-diff ${diffClass}`} style={{ marginLeft: 6 }}>
                            {diffPercent >= 0 ? '+' : ''}{truncate1(diffPercent)}%
                          </span>
                        )}
                      </Text>
                    </div>
                    <div className="oc-summary-card">
                      <Text weight="bold" className="oc-summary-value">{formatCost(totals.adjCpu)}</Text>
                      <Text variant="body-x-small" color="secondary">CPU Cost</Text>
                    </div>
                    <div className="oc-summary-card">
                      <Text weight="bold" className="oc-summary-value">{formatCost(totals.adjRam)}</Text>
                      <Text variant="body-x-small" color="secondary">RAM Cost</Text>
                    </div>
                    <div className="oc-summary-card">
                      <Text weight="bold" className="oc-summary-value">{formatCost(totals.adjPv)}</Text>
                      <Text variant="body-x-small" color="secondary">PV Cost</Text>
                    </div>
                    <div className="oc-summary-card">
                      <Text weight="bold" className="oc-summary-value">{formatCost(totals.adjNetwork)}</Text>
                      <Text variant="body-x-small" color="secondary">Network Cost</Text>
                    </div>
                  </div>

                  {/* Cost breakdown bar */}
                  {totals.adjTotal > 0 && (() => {
                    const allSegments = [
                      { label: 'CPU', value: totals.adjCpu, color: '#60a5fa' },
                      { label: 'RAM', value: totals.adjRam, color: '#a78bfa' },
                      { label: 'PV', value: totals.adjPv, color: '#34d399' },
                      { label: 'Network', value: totals.adjNetwork, color: '#fbbf24' },
                    ];
                    const barSegments = allSegments.filter(s => s.value > 0);
                    return (
                      <div className="oc-breakdown">
                        <div className="oc-breakdown-bar">
                          {barSegments.map(s => {
                            const pct = (s.value / totals.adjTotal) * 100;
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
                            const pct = totals.adjTotal > 0 ? (s.value / totals.adjTotal) * 100 : 0;
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
                </div>

                {/* Right: Collection calendar */}
                {(() => {
                  const firstDow = new Date(Date.UTC(year, month - 1, 1, 12)).getDay();
                  return (
                    <div className="oc-summary-right">
                      <div className="oc-calendar-header">
                        <Text variant="body-small" weight="bold">
                          Included {totals.included.length}/{totals.totalDays}
                          <span style={{ fontWeight: 'normal', opacity: 0.6 }}> ({Math.round((totals.included.length / totals.totalDays) * 100)}%)</span>
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
                          cells.push(<div key="w1" className="oc-calendar-week-label">W{weekNum}</div>);
                          for (let i = 0; i < firstDow; i++) {
                            cells.push(<div key={`pad-${i}`} className="oc-calendar-cell" />);
                          }
                          let colIdx = firstDow;
                          for (const row of fullRows) {
                            if (colIdx === 7) {
                              colIdx = 0;
                              weekNum++;
                              cells.push(<div key={`w${weekNum}`} className="oc-calendar-week-label">W{weekNum}</div>);
                            }
                            const excluded = excludedDates.has(row.date);
                            const noData = row.status === 'missing' || row.status === 'pending';
                            let stampClass = 'oc-calendar-stamp';
                            if (row.status === 'missing') stampClass += ' oc-stamp-missing';
                            if (row.status === 'pending') stampClass += ' oc-stamp-pending';
                            if (row.status === 'collecting') stampClass += ' oc-stamp-collecting';
                            if (excluded) stampClass += ' oc-stamp-excluded';
                            const tooltipLabel = excluded ? 'Excluded' : ({ collected: 'Included', collecting: 'In Progress', missing: 'Missing', pending: 'Pending' })[row.status];
                            cells.push(
                              <div
                                key={row.date}
                                className={`oc-calendar-cell oc-has-tooltip oc-calendar-clickable`}
                                onClick={() => toggleDate(row.date)}
                              >
                                <span
                                  className={stampClass}
                                  style={!noData && !excluded ? { background: statusColor[row.status] } : undefined}
                                >
                                  {parseInt(row.date.substring(8, 10), 10)}
                                </span>
                                <span className="oc-tooltip">{`${row.date} (${row.dayOfWeek}): ${tooltipLabel}`}</span>
                              </div>,
                            );
                            colIdx++;
                          }
                          return cells;
                        })()}
                      </div>
                      <div className="oc-adjust-calendar-legend">
                        <span className="oc-adjust-legend-item"><span className="oc-breakdown-dot" style={{ background: '#34d399' }} /> Included</span>
                        <span className="oc-adjust-legend-item"><span className="oc-breakdown-dot" style={{ background: '#555' }} /> Excluded</span>
                        <span className="oc-adjust-legend-item"><span className="oc-breakdown-dot" style={{ background: '#f87171' }} /> Missing</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </Box>

            {/* ── Adjustment Controls ── */}
            <Box mt="3" p="3" className="oc-section-box">
              <Flex align="center" gap="2" mb="3">
                <Text variant="body-medium" weight="bold">Cost Adjustment</Text>
                <TooltipTrigger delay={200}>
                  <ButtonIcon variant="tertiary" size="small" aria-label="info" icon={<span style={{ fontSize: '0.75rem' }}>{'?'}</span>} className="oc-adjust-info-btn" />
                  <Tooltip>
                    Set a +/- percentage per resource type (CPU, RAM, GPU, PV, Network) to adjust costs before export. You can also exclude specific dates or quickly filter out weekends and missing days. All adjustments apply to the exported CSV only — original cost data is never modified.
                  </Tooltip>
                </TooltipTrigger>
              </Flex>
              <div className="oc-adjust-controls">
                {costFields.map(field => (
                  <div key={field} className="oc-adjust-pct-group">
                    <Text variant="body-small" color="secondary">{costFieldLabels[field]}</Text>
                    <div className="oc-adjust-pct-row">
                      <div className="oc-adjust-direction">
                        <button
                          className={fieldDirections[field] === 'markup' ? 'active' : ''}
                          onClick={() => setFieldDirections(prev => ({ ...prev, [field]: 'markup' }))}
                        >
                          +
                        </button>
                        <button
                          className={fieldDirections[field] === 'discount' ? 'active' : ''}
                          onClick={() => setFieldDirections(prev => ({ ...prev, [field]: 'discount' }))}
                        >
                          -
                        </button>
                      </div>
                      <input
                        type="number"
                        className="oc-adjust-pct-input"
                        value={fieldPercents[field] || ''}
                        min={0}
                        max={fieldDirections[field] === 'discount' ? 100 : 999}
                        placeholder="0"
                        onChange={e => {
                          const v = parseFloat(e.target.value);
                          setFieldPercents(prev => ({ ...prev, [field]: Number.isNaN(v) ? 0 : Math.max(0, v) }));
                        }}
                      />
                      <Text variant="body-small" color="secondary">%</Text>
                    </div>
                  </div>
                ))}

                <div className="oc-adjust-pct-group">
                  <Text variant="body-small" color="secondary">Quick Exclude</Text>
                  <div className="oc-adjust-quick-btns">
                    <button className={`oc-adjust-quick-btn${weekendsExcluded ? ' active' : ''}`} onClick={toggleWeekends}>Weekends</button>
                    <button className={`oc-adjust-quick-btn${missingExcluded ? ' active' : ''}`} onClick={toggleMissing}>Missing ($0)</button>
                    <button className="oc-adjust-quick-btn" onClick={clearExclusions}>Clear All</button>
                  </div>
                </div>
              </div>
            </Box>

            {/* ── Daily Cost Breakdown ── */}
            <Box mt="3" p="3" className="oc-section-box">
              <Flex justify="between" align="center" mb="3">
                <Text variant="body-medium" weight="bold">Daily Cost Breakdown</Text>
                <Flex align="center" gap="2">
                  <span className="oc-count-badge">{totals.included.length}</span>
                  <Text variant="body-small" color="secondary">days</Text>
                  <button
                    className="oc-export-btn"
                    onClick={handleExport}
                    disabled={totals.included.length === 0}
                  >
                    {'\u2913'} Export CSV
                  </button>
                </Flex>
              </Flex>
              <div className="oc-table-wrapper">
                <table className="oc-table">
                  <thead>
                    <tr>
                      <th style={{ cursor: 'default' }}></th>
                      <th onClick={() => handleSort('date')}>Date <SortIcon field="date" /></th>
                      <th onClick={() => handleSort('status')}>Status <SortIcon field="status" /></th>
                      <th onClick={() => handleSort('cpuCost')}>CPU <SortIcon field="cpuCost" /></th>
                      <th onClick={() => handleSort('ramCost')}>RAM <SortIcon field="ramCost" /></th>
                      <th onClick={() => handleSort('gpuCost')}>GPU <SortIcon field="gpuCost" /></th>
                      <th onClick={() => handleSort('pvCost')}>PV <SortIcon field="pvCost" /></th>
                      <th onClick={() => handleSort('networkCost')}>Network <SortIcon field="networkCost" /></th>
                      <th onClick={() => handleSort('totalCost')}>Total <SortIcon field="totalCost" /></th>
                      {hasAnyAdjustment && <th style={{ cursor: 'default' }}>Adjusted</th>}
                      <th onClick={() => handleSort('carbonCost')}>Carbon <SortIcon field="carbonCost" /></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map(row => {
                      const excluded = excludedDates.has(row.date);
                      const hasData = row.status === 'collected' || row.status === 'collecting';
                      const statusLabelMap: Record<DataStatus, string> = { collected: 'Collected', collecting: 'In Progress', missing: 'Missing', pending: 'Pending' };
                      const ledColorMap: Record<DataStatus, string> = { collected: '#34d399', collecting: '#60a5fa', missing: '#f87171', pending: '#6b7280' };
                      const ledColor = excluded ? '#6b7280' : ledColorMap[row.status];
                      const statusLabel = excluded ? 'Excluded' : statusLabelMap[row.status];
                      return (
                        <tr key={row.date} className={excluded ? 'oc-adjust-row-excluded' : hasData ? '' : 'oc-row-disabled'}>
                          <td style={{ width: 36, textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              className="oc-adjust-checkbox"
                              checked={!excluded}
                              onChange={() => toggleDate(row.date)}
                            />
                          </td>
                          <td>{row.date} <span className={`oc-day-of-week${row.dayOfWeek === 'Sun' ? ' oc-dow-sun' : row.dayOfWeek === 'Sat' ? ' oc-dow-sat' : ''}`}>({row.dayOfWeek})</span></td>
                          <td title={`${row.date} (${row.dayOfWeek}): ${statusLabel}`}>
                            <span
                              className={`oc-led${!excluded && row.status === 'collecting' ? ' oc-led-pulse' : ''}${!excluded && row.status === 'missing' ? ' oc-led-missing' : ''}`}
                              style={{
                                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                                backgroundColor: ledColor, marginRight: 6, verticalAlign: 'middle',
                              }}
                            />
                            {statusLabel}
                          </td>
                          <td className="oc-cost">{hasData ? formatCost(row.cpuCost) : '-'}</td>
                          <td className="oc-cost">{hasData ? formatCost(row.ramCost) : '-'}</td>
                          <td className="oc-cost">{hasData ? formatCost(row.gpuCost) : '-'}</td>
                          <td className="oc-cost">{hasData ? formatCost(row.pvCost) : '-'}</td>
                          <td className="oc-cost">{hasData ? formatCost(row.networkCost) : '-'}</td>
                          <td className="oc-cost oc-cost-total">{hasData ? formatCost(row.totalCost) : '-'}</td>
                          {hasAnyAdjustment && (
                            <td className={`oc-cost ${excluded ? '' : 'oc-adjust-col-adjusted'}`}>
                              {excluded || !hasData ? '-' : <>{formatCost(row.totalCost)} <span className="oc-adjust-arrow">{'\u2192'}</span> {formatCost(applyRow(row).total)}</>}
                            </td>
                          )}
                          <td className="oc-cost oc-carbon">{hasData ? formatCarbon(row.carbonCost) : '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {totals.included.length > 0 && (() => {
                    const d = totals.included.length;
                    return (
                    <tfoot>
                      <tr className="oc-daily-avg-row">
                        <td></td>
                        <td>Daily Avg</td>
                        <td>{d} days</td>
                        <td className="oc-cost">{formatCost(totals.inclCpu / d)}</td>
                        <td className="oc-cost">{formatCost(totals.inclRam / d)}</td>
                        <td className="oc-cost">-</td>
                        <td className="oc-cost">{formatCost(totals.inclPv / d)}</td>
                        <td className="oc-cost">{formatCost(totals.inclNetwork / d)}</td>
                        <td className="oc-cost oc-cost-total">{formatCost(totals.inclTotal / d)}</td>
                        {hasAnyAdjustment && <td className="oc-cost oc-adjust-col-adjusted">{formatCost(totals.inclTotal / d)} <span className="oc-adjust-arrow">{'\u2192'}</span> {formatCost(totals.adjTotal / d)}</td>}
                        <td className="oc-cost oc-carbon">{formatCarbon(totals.inclCarbon / d)}</td>
                      </tr>
                      <tr>
                        <td></td>
                        <td><strong>Total</strong></td>
                        <td><strong>{totals.collectedCount}/{totals.totalDays} days</strong></td>
                        <td className="oc-cost"><strong>{formatCost(totals.inclCpu)}</strong></td>
                        <td className="oc-cost"><strong>{formatCost(totals.inclRam)}</strong></td>
                        <td className="oc-cost"><strong>-</strong></td>
                        <td className="oc-cost"><strong>{formatCost(totals.inclPv)}</strong></td>
                        <td className="oc-cost"><strong>{formatCost(totals.inclNetwork)}</strong></td>
                        <td className="oc-cost oc-cost-total"><strong>{formatCost(totals.inclTotal)}</strong></td>
                        {hasAnyAdjustment && <td className="oc-cost oc-adjust-col-adjusted"><strong>{formatCost(totals.inclTotal)} <span className="oc-adjust-arrow">{'\u2192'}</span> {formatCost(totals.adjTotal)}</strong></td>}
                        <td className="oc-cost oc-carbon"><strong>{formatCarbon(totals.inclCarbon)}</strong></td>
                      </tr>
                      {fullRows.some(r => r.status === 'collecting' && todayLiveCost) && (
                        <tr>
                          <td colSpan={hasAnyAdjustment ? 12 : 11} className="oc-cost-estimated" style={{ fontStyle: 'italic', fontSize: '0.75rem' }}>
                            Values for in-progress days are from real-time data and may change until the day ends.
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
      </Container>
    </>
  );
};
