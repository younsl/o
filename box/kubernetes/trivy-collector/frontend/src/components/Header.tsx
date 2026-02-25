import { useCallback } from 'react'
import StatusLed from './StatusLed'
import styles from './Header.module.css'
import type { WatcherStatusResponse, VersionResponse, ReportType, ViewType } from '../types'

interface HeaderProps {
  watcherStatus: WatcherStatusResponse | null
  dbOk: boolean
  version: VersionResponse | null
  currentView: ViewType
  reportType: ReportType
  onNavigate: (view: ViewType) => void
  onSwitchReportType: (type: ReportType) => void
}

export default function Header({
  watcherStatus,
  dbOk,
  version,
  currentView,
  reportType,
  onNavigate,
  onSwitchReportType,
}: HeaderProps) {
  const handleVersionClick = useCallback(() => {
    onNavigate('version')
  }, [onNavigate])

  const commitShort = version ? version.commit.substring(0, 7) : ''

  const getDbLedStatus = () => {
    if (!dbOk) return { running: false, initial_sync_done: false, reports_count: 0 }
    return { running: true, initial_sync_done: true, reports_count: 0 }
  }

  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>Trivy Collector</h1>
          <span className={styles.subtitle}>Powered by Trivy Operator</span>
        </div>
        {version && (
          <span
            className={`${styles.versionInfo} ${styles.clickable}`}
            title="Click to view detailed version info"
            onClick={handleVersionClick}
          >
            v{version.version} ({commitShort})
          </span>
        )}
        <div className={styles.watcherStatus}>
          <span className={styles.watcherTitle}>Status</span>
          <StatusLed status={watcherStatus?.vuln_watcher ?? null} label="VULN" />
          <StatusLed status={watcherStatus?.sbom_watcher ?? null} label="SBOM" />
          <div className={styles.statusItem} id="db-status">
            <StatusLed status={getDbLedStatus()} label="DB" />
          </div>
        </div>
      </div>
      <nav className={styles.nav}>
        <button
          className={`${styles.navButton}${currentView === 'dashboard' ? ` ${styles.active}` : ''}`}
          onClick={() => onNavigate('dashboard')}
        >
          <i className="fa-solid fa-chart-line" /> Dashboard
        </button>
        <button
          className={`${styles.navButton}${currentView === 'reports' && reportType === 'vulnerabilityreport' ? ` ${styles.active}` : ''}`}
          onClick={() => {
            onSwitchReportType('vulnerabilityreport')
            onNavigate('reports')
          }}
        >
          Vulnerabilities
        </button>
        <button
          className={`${styles.navButton}${currentView === 'reports' && reportType === 'sbomreport' ? ` ${styles.active}` : ''}`}
          onClick={() => {
            onSwitchReportType('sbomreport')
            onNavigate('reports')
          }}
        >
          SBOM
        </button>
      </nav>
    </header>
  )
}
