import { useState, useEffect, useRef, useCallback } from 'react'
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, Filler, Legend, Tooltip } from 'chart.js'
import { Line, Bar } from 'react-chartjs-2'
import { getDashboardTrends, getStats, getClusters } from '../api'
import type { TrendResponse, Stats, ClusterInfo } from '../types'
import styles from './DashboardView.module.css'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Filler, Legend, Tooltip)

const REFRESH_INTERVAL = 30

interface DashboardViewProps {
  onBack: () => void
}

export default function DashboardView({ onBack }: DashboardViewProps) {
  const [range, setRange] = useState('1d')
  const [cluster, setCluster] = useState('')
  const [clusters, setClusters] = useState<ClusterInfo[]>([])
  const [trendData, setTrendData] = useState<TrendResponse | null>(null)
  const [statsData, setStatsData] = useState<Stats | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL)
  const [rangeOpen, setRangeOpen] = useState(false)
  const [clusterOpen, setClusterOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  const loadData = useCallback(async () => {
    try {
      const [trends, stats] = await Promise.all([
        getDashboardTrends(range, cluster || undefined),
        getStats(),
      ])
      setTrendData(trends)
      setStatsData(stats)
    } catch { /* silent */ }
  }, [range, cluster])

  useEffect(() => {
    loadData()
    getClusters().then((data) => setClusters(data.items || [])).catch(() => {})
  }, [loadData])

  // Auto-refresh countdown
  useEffect(() => {
    if (!autoRefresh) return
    setCountdown(REFRESH_INTERVAL)
    const id = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          loadData()
          return REFRESH_INTERVAL
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [autoRefresh, loadData])

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(`.${styles.dropdown}`)) {
        setRangeOpen(false)
        setClusterOpen(false)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  const handleRefresh = async () => {
    await loadData()
    if (autoRefresh) setCountdown(REFRESH_INTERVAL)
  }

  const exportPng = async () => {
    if (!contentRef.current) return
    const html2canvas = (await import('html2canvas')).default
    const canvas = await html2canvas(contentRef.current, {
      backgroundColor: '#0d0d0d',
      scale: 2,
      useCORS: true,
      logging: false,
    })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const link = document.createElement('a')
    link.download = `trivy-dashboard_${range}_${cluster || 'all'}_${timestamp}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  const rangeOptions = [
    { value: '1d', label: 'Last 1 Day' },
    { value: '2d', label: 'Last 2 Days' },
    { value: '7d', label: 'Last 7 Days' },
    { value: '30d', label: 'Last 30 Days' },
  ]

  const formatLabels = (series: TrendResponse['series'], granularity: string) =>
    series.map((s) => {
      if (granularity === 'hourly' && s.date.includes(' ')) return s.date.split(' ')[1]
      if (s.date.length === 10) return s.date.substring(5)
      return s.date
    })

  const chartOpts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { position: 'bottom' as const, align: 'start' as const, labels: { color: '#9ca3af', font: { size: 11 }, padding: 16, usePointStyle: true, pointStyle: 'line' as const, boxWidth: 16, boxHeight: 2 } },
      tooltip: { backgroundColor: 'rgba(24,24,27,0.95)', titleColor: '#f4f4f5', bodyColor: '#a1a1aa', borderColor: '#3f3f46', borderWidth: 1, padding: 12, cornerRadius: 6 },
    },
    scales: {
      x: { grid: { color: '#2a2a2a' }, ticks: { color: '#808080', font: { size: 10 } } },
      y: { grid: { color: '#2a2a2a' }, ticks: { color: '#808080', font: { size: 10 } }, beginAtZero: true },
    },
  }

  const series = trendData?.series || []
  const granularity = trendData?.meta?.granularity || 'daily'
  const labels = formatLabels(series, granularity)

  const dataFrom = trendData?.meta?.data_from
  const dataTo = trendData?.meta?.data_to
  const retentionText = dataFrom && dataTo && dataFrom !== 'null' && dataTo !== 'null'
    ? `Retention: ${dataFrom} ~ ${dataTo}`
    : series.length > 0
      ? `Retention: ${series[0]?.date} ~ ${series[series.length - 1]?.date}`
      : 'Collecting data...'

  return (
    <section className="detail-container">
      <div className={styles.header}>
        <button className="btn-back" onClick={onBack}>
          <i className="fa-solid fa-arrow-left" /> Back to List
        </button>
        <div className={styles.title}><h2 className={styles.titleHeading}>Security Trends Dashboard</h2></div>
        <div className={styles.controls}>
          {/* Range dropdown */}
          <div className={`${styles.dropdown}${rangeOpen ? ` ${styles.open}` : ''}`}>
            <button className={styles.dropdownToggle} onClick={(e) => { e.stopPropagation(); setRangeOpen(!rangeOpen); setClusterOpen(false) }}>
              <span className={styles.dropdownText}>{rangeOptions.find((o) => o.value === range)?.label}</span>
              <i className="fa-solid fa-chevron-down" />
            </button>
            {rangeOpen && (
              <div className={styles.dropdownMenu}>
                {rangeOptions.map((o) => (
                  <div key={o.value} className={`${styles.dropdownItem}${range === o.value ? ` ${styles.selected}` : ''}`} onClick={() => { setRange(o.value); setRangeOpen(false) }}>
                    {o.label}
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* Cluster dropdown */}
          <div className={`${styles.dropdown}${clusterOpen ? ` ${styles.open}` : ''}`}>
            <button className={styles.dropdownToggle} onClick={(e) => { e.stopPropagation(); setClusterOpen(!clusterOpen); setRangeOpen(false) }}>
              <span className={styles.dropdownText}>{cluster || 'All Clusters'}</span>
              <i className="fa-solid fa-chevron-down" />
            </button>
            {clusterOpen && (
              <div className={styles.dropdownMenu}>
                <div className={`${styles.dropdownItem}${!cluster ? ` ${styles.selected}` : ''}`} onClick={() => { setCluster(''); setClusterOpen(false) }}>All Clusters</div>
                {clusters.map((c) => (
                  <div key={c.name} className={`${styles.dropdownItem}${cluster === c.name ? ` ${styles.selected}` : ''}`} onClick={() => { setCluster(c.name); setClusterOpen(false) }}>
                    {c.name}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className={styles.refreshControls}>
            <button className={styles.btnRefresh} title="Refresh now" onClick={handleRefresh}>
              <i className="fa-solid fa-sync-alt" /><span>Refresh</span>
            </button>
            <button className={`${styles.btnRefreshInterval}${autoRefresh ? ` ${styles.active}` : ''}`} onClick={() => setAutoRefresh(!autoRefresh)}>
              <span className={styles.refreshIntervalText}>{autoRefresh ? `${countdown}s` : `${REFRESH_INTERVAL}s`}</span>
            </button>
          </div>
          <button className="btn-export" title="Export dashboard as PNG" onClick={exportPng}>
            <i className="fa-solid fa-camera" /> Export PNG
          </button>
        </div>
      </div>

      <div ref={contentRef} className={styles.content}>
        <div className={styles.contentHeader}>
          <span className={styles.dataRange}><i className="fa-solid fa-database" /> {retentionText}</span>
        </div>
        <div className={styles.summaryWrapper}>
          <div className={styles.overviewBar}>
            <div className={styles.overviewHeader}><span className={styles.overviewTitle}>Overview</span></div>
            <div className={styles.overviewSegments}>
              <div className={styles.overviewSegment}>
                <span className={styles.overviewSegmentLabel}>Collectors</span>
                <span className={styles.overviewSegmentValue}>{(statsData?.total_clusters || 0).toLocaleString()}</span>
              </div>
              <div className={styles.overviewSegment}>
                <span className={styles.overviewSegmentLabel}>Vuln Reports</span>
                <span className={styles.overviewSegmentValue}>{(statsData?.total_vuln_reports || 0).toLocaleString()}</span>
              </div>
              <div className={styles.overviewSegment}>
                <span className={styles.overviewSegmentLabel}>SBOM Reports</span>
                <span className={styles.overviewSegmentValue}>{(statsData?.total_sbom_reports || 0).toLocaleString()}</span>
              </div>
            </div>
          </div>
          <div className={styles.cvssScoreBar}>
            <div className={styles.cvssHeader}><span className={styles.cvssTitle}>CVSS Score</span></div>
            <div className={styles.cvssBar}>
              {(['low', 'medium', 'high', 'critical'] as const).map((level) => {
                const ranges: Record<string, [string, string]> = { low: ['0.1', '3.9'], medium: ['4.0', '6.9'], high: ['7.0', '8.9'], critical: ['9.0', '10.0'] }
                const val = statsData ? (statsData[`total_${level}` as keyof Stats] as number) || 0 : 0
                return (
                  <div key={level} className={`${styles.cvssSegment} ${styles[level]}`}>
                    <span className={styles.cvssSegmentLabel}>{level.charAt(0).toUpperCase() + level.slice(1)}</span>
                    <span className={styles.cvssSegmentValue}>{val.toLocaleString()}</span>
                    <div className={styles.cvssSegmentScores}><span>{ranges[level][0]}</span><span>{ranges[level][1]}</span></div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className={styles.grid}>
          <div className={styles.chartSection}>
            <div className="section-bar"><h3 className="graph-title">Report Count Trends</h3></div>
            <div className={styles.chartContainer}>
              <Line
                data={{
                  labels,
                  datasets: [
                    { label: 'Collectors', data: series.map((s) => s.clusters_count || 0), borderColor: '#6b7280', backgroundColor: 'transparent', borderDash: [4, 4], borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'y1' },
                    { label: 'Vulnerability Reports', data: series.map((s) => s.vuln_reports), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3 },
                    { label: 'SBOM Reports', data: series.map((s) => s.sbom_reports), borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.1)', fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3 },
                  ],
                }}
                options={{
                  ...chartOpts,
                  scales: {
                    ...chartOpts.scales,
                    y1: { type: 'linear' as const, display: true, position: 'right' as const, title: { display: true, text: 'Collectors', color: '#9ca3af' }, ticks: { color: '#9ca3af', stepSize: 1 }, grid: { display: false } },
                  },
                }}
              />
            </div>
          </div>
          <div className={styles.chartSection}>
            <div className="section-bar"><h3 className="graph-title">Severity Distribution Over Time</h3></div>
            <div className={styles.chartContainer}>
              <Line
                data={{
                  labels,
                  datasets: [
                    { label: 'Critical', data: series.map((s) => s.critical), borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.15)', fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3 },
                    { label: 'High', data: series.map((s) => s.high), borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.15)', fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3 },
                    { label: 'Medium', data: series.map((s) => s.medium), borderColor: '#eab308', backgroundColor: 'rgba(234,179,8,0.15)', fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3 },
                    { label: 'Low', data: series.map((s) => s.low), borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.15)', fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3 },
                  ],
                }}
                options={chartOpts}
              />
            </div>
          </div>
          <div className={`${styles.chartSection} ${styles.fullWidth}`}>
            <div className="section-bar"><h3 className="graph-title">Vulnerabilities by Severity</h3></div>
            <div className={styles.chartContainer}>
              <Bar
                data={{
                  labels: ['Critical', 'High', 'Medium', 'Low', 'Unknown'],
                  datasets: [{
                    label: 'Current Vulnerabilities',
                    data: [statsData?.total_critical || 0, statsData?.total_high || 0, statsData?.total_medium || 0, statsData?.total_low || 0, statsData?.total_unknown || 0],
                    backgroundColor: ['rgba(239,68,68,0.8)', 'rgba(249,115,22,0.8)', 'rgba(234,179,8,0.8)', 'rgba(34,197,94,0.8)', 'rgba(107,114,128,0.8)'],
                    borderColor: ['#ef4444', '#f97316', '#eab308', '#22c55e', '#6b7280'],
                    borderWidth: 1,
                  }],
                }}
                options={{ ...chartOpts, plugins: { ...chartOpts.plugins, legend: { display: false } } }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
