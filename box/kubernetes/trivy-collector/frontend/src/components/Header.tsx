import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { logout } from '../auth'
import styles from './Header.module.css'
import type { VersionResponse } from '../types'

interface HeaderProps {
  version: VersionResponse | null
}

export default function Header({ version }: HeaderProps) {
  const location = useLocation()
  const path = location.pathname
  const { authMode, authenticated, user, permissions } = useAuth()

  const commitShort = version ? version.commit.substring(0, 7) : ''

  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>Trivy Collector</h1>
          {version ? (
            <Link to="/version" className={styles.subtitle} title="Click to view detailed version info">
              v{version.version} ({commitShort})
            </Link>
          ) : (
            <span className={styles.subtitle}>Powered by Trivy Operator</span>
          )}
        </div>
      </div>
      <div className={styles.headerRight}>
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
          <Link
            to="/auth"
            className={`${styles.navButton}${path === '/auth' ? ` ${styles.active}` : ''}`}
          >
            <i className="fa-solid fa-key" /> Auth
          </Link>
          {permissions?.can_admin && (
            <Link
              to="/admin/clusters"
              className={`${styles.navButton}${path.startsWith('/admin') ? ` ${styles.active}` : ''}`}
            >
              <i className="fa-solid fa-shield-halved" /> Admin
            </Link>
          )}
        </nav>
        {authMode === 'keycloak' && authenticated && user && (
          <div className={styles.userInfo}>
            <div className={styles.userDetails}>
              <span className={styles.userName}>
                {user.name ?? user.preferred_username ?? user.email ?? user.sub}
              </span>
              {user.email && (
                <span className={styles.userEmail}>{user.email}</span>
              )}
              <span className={styles.userGroups} title={user.groups.length > 0 ? user.groups.join(', ') : 'No groups assigned'}>
                {user.groups.length > 0 ? user.groups.join(', ') : 'No groups'}
              </span>
            </div>
            <button
              className={styles.logoutButton}
              onClick={logout}
              title="Logout"
            >
              <i className="fa-solid fa-right-from-bracket" />
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
