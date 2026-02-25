import { escapeHtml } from '../utils'
import DependencyGraph from './DependencyGraph'
import type { SbomComponent, SbomDependency } from '../types'
import styles from './SbomDetail.module.css'

interface SbomDetailProps {
  reportData: Record<string, unknown>
}

export default function SbomDetail({ reportData }: SbomDetailProps) {
  const componentsData = reportData.components as Record<string, unknown> | undefined
  const components = ((componentsData?.components || []) as SbomComponent[])
  const dependencies = (
    componentsData?.dependencies ||
    reportData.dependencies ||
    (reportData as Record<string, unknown>).dependencies ||
    []
  ) as SbomDependency[]

  return (
    <>
      {components.length > 0 && (
        <DependencyGraph components={components} dependencies={dependencies} />
      )}
      <div className="graph-section" style={{ display: 'block' }}>
        <div className="section-bar">
          <h3 className="graph-title">SBOM Components <span className="section-count">({components.length})</span></h3>
        </div>
        <div className="detail-table-container">
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.colIndex}>#</th>
                <th>Name</th>
                <th>Version</th>
                <th>Type</th>
                <th>License</th>
                <th>PURL</th>
              </tr>
            </thead>
            <tbody>
              {components.length === 0 ? (
                <tr><td colSpan={6} className="no-data">No components found</td></tr>
              ) : (
                components.map((comp, index) => {
                  const licenses = (comp.licenses || [])
                    .map((l) => l.license?.name || l.name || '')
                    .filter(Boolean)
                    .join(', ') || '-'
                  return (
                    <tr key={`${comp.name}-${index}`}>
                      <td className={styles.colIndex}>{index + 1}</td>
                      <td>{escapeHtml(comp.name || '-')}</td>
                      <td>{escapeHtml(comp.version || '-')}</td>
                      <td>{escapeHtml(comp.type || comp.component_type || '-')}</td>
                      <td>{escapeHtml(licenses)}</td>
                      <td className={styles.textWrapBreak}>{escapeHtml(comp.purl || '-')}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
