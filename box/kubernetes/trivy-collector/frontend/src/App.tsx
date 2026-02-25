import { useState, useEffect, useCallback, useMemo } from 'react'
import Header from './components/Header'
import ReportsView from './components/ReportsView'
import DetailView from './components/DetailView'
import DashboardView from './components/DashboardView'
import VersionView from './components/VersionView'
import { getReports, getStats, getClusters, getNamespaces, getWatcherStatus, getVersion } from './api'
import { usePolling } from './hooks/usePolling'
import type { ReportMeta, ReportType, ViewType, Filters, Stats, ClusterInfo, VersionResponse, WatcherStatusResponse } from './types'

export default function App() {
  const [currentView, setCurrentView] = useState<ViewType>('reports')
  const [reportType, setReportType] = useState<ReportType>('vulnerabilityreport')
  const [reports, setReports] = useState<ReportMeta[]>([])
  const [selectedReport, setSelectedReport] = useState<ReportMeta | null>(null)
  const [filters, setFilters] = useState<Filters>({ cluster: '', namespace: '', app: '' })
  const [stats, setStats] = useState<Stats | null>(null)
  const [clusterOptions, setClusterOptions] = useState<ClusterInfo[]>([])
  const [namespaceOptions, setNamespaceOptions] = useState<string[]>([])
  const [version, setVersion] = useState<VersionResponse | null>(null)
  const [dbOk, setDbOk] = useState(false)

  // Polling for watcher status
  const watcherStatusFetcher = useCallback(() => getWatcherStatus(), [])
  const { data: watcherStatus } = usePolling<WatcherStatusResponse>(watcherStatusFetcher, 5000)

  // Polling for stats
  const statsFetcher = useCallback(() => getStats(), [])
  const { data: polledStats } = usePolling<Stats>(statsFetcher, 5000)

  useEffect(() => {
    if (polledStats) {
      setStats(polledStats)
      setDbOk(true)
    }
  }, [polledStats])

  // Load version once
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {})
  }, [])

  // Load clusters once
  useEffect(() => {
    getClusters().then((data) => setClusterOptions(data.items || [])).catch(() => {})
  }, [])

  // Load namespaces when cluster filter changes
  useEffect(() => {
    getNamespaces(filters.cluster || undefined)
      .then((data) => setNamespaceOptions(data.items || []))
      .catch(() => {})
  }, [filters.cluster])

  // Load reports when filters or report type change
  const loadReports = useCallback(() => {
    getReports(reportType, filters)
      .then((data) => setReports(data.items || []))
      .catch(() => setReports([]))
  }, [reportType, filters])

  useEffect(() => {
    loadReports()
  }, [loadReports])

  const handleFilterChange = useCallback((key: string, value: string) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'cluster') next.namespace = ''
      return next
    })
  }, [])

  const handleFilterClear = useCallback((key: string) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: '' }
      if (key === 'cluster') next.namespace = ''
      return next
    })
  }, [])

  const handleSelectReport = useCallback((report: ReportMeta) => {
    setSelectedReport(report)
    setCurrentView('detail')
    window.scrollTo(0, 0)
  }, [])

  const handleNavigate = useCallback((view: ViewType) => {
    setCurrentView(view)
    window.scrollTo(0, 0)
  }, [])

  const handleSwitchReportType = useCallback((type: ReportType) => {
    setReportType(type)
  }, [])

  const handleBackToList = useCallback(() => {
    setCurrentView('reports')
    setSelectedReport(null)
  }, [])

  // Keyboard shortcut: Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (currentView === 'detail' || currentView === 'dashboard' || currentView === 'version') {
          handleBackToList()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [currentView, handleBackToList])

  const memoizedReports = useMemo(() => reports, [reports])

  return (
    <>
      <Header
        watcherStatus={watcherStatus}
        dbOk={dbOk}
        version={version}
        currentView={currentView}
        reportType={reportType}
        onNavigate={handleNavigate}
        onSwitchReportType={handleSwitchReportType}
      />
      <main>
        {currentView === 'reports' && (
          <ReportsView
            reports={memoizedReports}
            reportType={reportType}
            filters={filters}
            stats={stats}
            clusterOptions={clusterOptions}
            namespaceOptions={namespaceOptions}
            onFilterChange={handleFilterChange}
            onFilterClear={handleFilterClear}
            onSelectReport={handleSelectReport}
          />
        )}
        {currentView === 'detail' && selectedReport && (
          <DetailView
            report={selectedReport}
            reportType={reportType}
            onBack={handleBackToList}
          />
        )}
        {currentView === 'dashboard' && (
          <DashboardView onBack={handleBackToList} />
        )}
        {currentView === 'version' && (
          <VersionView onBack={handleBackToList} />
        )}
      </main>
      <footer>
        <p>Trivy Collector &mdash; Multi-cluster security report aggregator</p>
      </footer>
    </>
  )
}
