import { escapeHtml } from '../utils'
import styles from './VulnDetail.module.css'

interface Vuln {
  vulnerabilityID?: string
  vulnerability_id?: string
  severity: string
  score: number | null
  resource: string
  installedVersion?: string
  installed_version?: string
  fixedVersion?: string
  fixed_version?: string
  title: string
  primaryLink?: string
  primary_link?: string
}

interface VulnDetailProps {
  vulnerabilities: Record<string, unknown>[]
}

const severityOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 }
const severityLabels: Record<string, string> = { CRITICAL: 'C', HIGH: 'H', MEDIUM: 'M', LOW: 'L', UNKNOWN: 'U' }

export default function VulnDetail({ vulnerabilities }: VulnDetailProps) {
  const vulns = (vulnerabilities as unknown as Vuln[]).sort(
    (a, b) => (severityOrder[a.severity] || 5) - (severityOrder[b.severity] || 5),
  )

  return (
    <div className="graph-section" style={{ display: 'block' }}>
      <div className="section-bar">
        <h3 className="graph-title">Vulnerabilities <span className="section-count">({vulns.length})</span></h3>
      </div>
      <div className="detail-table-container">
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.colIndex}>#</th>
              <th className={styles.colSeverity}>Severity</th>
              <th className={styles.colId}>CVE ID</th>
              <th className={styles.colScore}>Score</th>
              <th>Package</th>
              <th>Installed</th>
              <th>Fixed</th>
              <th>Title</th>
            </tr>
          </thead>
          <tbody>
            {vulns.length === 0 ? (
              <tr><td colSpan={8} className="no-data">No vulnerabilities found</td></tr>
            ) : (
              vulns.map((vuln, index) => {
                const vulnId = vuln.vulnerabilityID || vuln.vulnerability_id || '-'
                const link = vuln.primaryLink || vuln.primary_link
                const sev = (vuln.severity || '').toUpperCase()
                const label = severityLabels[sev] || '?'
                const score = vuln.score != null ? vuln.score.toFixed(1) : '-'
                return (
                  <tr key={`${vulnId}-${index}`}>
                    <td className={styles.colIndex}>{index + 1}</td>
                    <td className={styles.colSeverity}>
                      <span className={`severity-badge severity-${sev.toLowerCase()}`}>{label}</span>
                    </td>
                    <td className={styles.colId}>
                      {link ? (
                        <a href={link} target="_blank" rel="noopener noreferrer">{escapeHtml(vulnId)}</a>
                      ) : (
                        escapeHtml(vulnId)
                      )}
                    </td>
                    <td className={styles.colScore}>{score}</td>
                    <td>{escapeHtml(vuln.resource || '-')}</td>
                    <td>{escapeHtml(vuln.installedVersion || vuln.installed_version || '-')}</td>
                    <td>{escapeHtml(vuln.fixedVersion || vuln.fixed_version || '-')}</td>
                    <td className={styles.textWrapBreak}>{escapeHtml(vuln.title || '-')}</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
