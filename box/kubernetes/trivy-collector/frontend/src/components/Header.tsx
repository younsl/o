import { Link, useLocation } from 'react-router-dom'
import StatusLed from './StatusLed'
import styles from './Header.module.css'
import type { WatcherStatusResponse, VersionResponse } from '../types'

interface HeaderProps {
  watcherStatus: WatcherStatusResponse | null
  dbOk: boolean
  version: VersionResponse | null
}

export default function Header({
  watcherStatus,
  dbOk,
  version,
}: HeaderProps) {
  const location = useLocation()
  const path = location.pathname

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
          <Link
            to="/version"
            className={`${styles.versionInfo} ${styles.clickable}`}
            title="Click to view detailed version info"
          >
            v{version.version} ({commitShort})
          </Link>
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
        <Link
          to="/dashboard"
          className={`${styles.navButton}${path === '/dashboard' ? ` ${styles.active}` : ''}`}
        >
          <i className="fa-solid fa-chart-line" /> Dashboard
        </Link>
        <Link
          to="/vulnerabilities"
          className={`${styles.navButton}${path.startsWith('/vulnerabilities') ? ` ${styles.active}` : ''}`}
        >
          Vulnerabilities
        </Link>
        <Link
          to="/sbom"
          className={`${styles.navButton}${path.startsWith('/sbom') ? ` ${styles.active}` : ''}`}
        >
          SBOM
        </Link>
      </nav>
    </header>
  )
}
