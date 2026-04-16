import { useState, useEffect, useCallback } from 'react'
import { getReportDetail } from '../api'
import Notes from './Notes'
import VulnDetail from './VulnDetail'
import SbomDetail from './SbomDetail'
import { escapeHtml, formatDateForFilename, downloadJson } from '../utils'
import type { ReportMeta, ReportType, FullReport } from '../types'

interface DetailViewProps {
  report: ReportMeta
  reportType: ReportType
  onBack: () => void
}

export default function DetailView({ report, reportType, onBack }: DetailViewProps) {
  const [detail, setDetail] = useState<FullReport | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    getReportDetail(reportType, report.cluster, report.namespace, report.name)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false))
  }, [report, reportType])

  const handleNotesSaved = useCallback((notes: string) => {
    if (detail) {
      setDetail({ ...detail, meta: { ...detail.meta, notes, notes_updated_at: new Date().toISOString() } })
    }
  }, [detail])

  const exportToJson = () => {
    if (!detail) return
    const m = detail.meta
    const filename = `trivy-${reportType === 'vulnerabilityreport' ? 'vuln' : 'sbom'}-${m.cluster}-${m.namespace}-${m.name}-${formatDateForFilename()}.json`
    downloadJson(detail.data, filename)
  }

  const data = detail?.data as Record<string, unknown> | undefined
  const reportData = data?.report as Record<string, unknown> | undefined
  const apiVersion = (data?.apiVersion as string) || 'aquasecurity.github.io/v1alpha1'
  const kind = (data?.kind as string) || (reportType === 'vulnerabilityreport' ? 'VulnerabilityReport' : 'SbomReport')

  return (
    <section className="detail-container">
      <div className="detail-header">
        <button className="btn-back" onClick={onBack}>
          <i className="fa-solid fa-arrow-left" /> Back to List
        </button>
        <h2>{report.cluster} / {report.namespace} / {report.name}</h2>
        <button className="btn-export" onClick={exportToJson} title="Export to JSON">
          <i className="fa-solid fa-arrow-down" /> Export JSON
        </button>
      </div>

      {loading ? (
        <div className="graph-section">
          <div className="detail-summary"><p className="loading">Loading...</p></div>
        </div>
      ) : !detail ? (
        <div className="graph-section">
          <div className="detail-summary"><p className="no-data">Error loading report details</p></div>
        </div>
      ) : (
        <>
          <div className="graph-section">
            <div className="section-bar">
              <h3 className="graph-title">Summary</h3>
            </div>
            <div className="detail-summary">
              <div className="detail-summary-item">
                <span className="detail-summary-label">API Version</span>
                <span className="detail-summary-value">{escapeHtml(apiVersion)}</span>
              </div>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Kind</span>
                <span className="detail-summary-value">{escapeHtml(kind)}</span>
              </div>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Cluster</span>
                <span className="detail-summary-value">{escapeHtml(detail.meta.cluster)}</span>
              </div>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Namespace</span>
                <span className="detail-summary-value">{escapeHtml(detail.meta.namespace)}</span>
              </div>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Image</span>
                <span className="detail-summary-value">{escapeHtml(detail.meta.image)}</span>
              </div>
              {reportType === 'vulnerabilityreport' && reportData && (
                <>
                  {(() => {
                    const vulns = (reportData.vulnerabilities as unknown[]) || []
                    const summary = reportData.summary as Record<string, number> | undefined
                    return (
                      <>
                        <div className="detail-summary-item">
                          <span className="detail-summary-label">Total</span>
                          <span className="detail-summary-value">{vulns.length}</span>
                        </div>
                        {(['critical', 'high', 'medium', 'low', 'unknown'] as const).map((level) => (
                          <div key={level} className="detail-summary-item">
                            <span className="detail-summary-label">{level.charAt(0).toUpperCase() + level.slice(1)}</span>
                            <span className="detail-summary-value" style={{ color: `var(--${level})` }}>
                              {summary?.[`${level}Count`] || 0}
                            </span>
                          </div>
                        ))}
                      </>
                    )
                  })()}
                </>
              )}
              {reportType === 'sbomreport' && reportData && (
                <>
                  {(() => {
                    const components = (reportData.components as Record<string, unknown>)?.components as unknown[] || []
                    const summary = reportData.summary as Record<string, number> | undefined
                    return (
                      <>
                        <div className="detail-summary-item">
                          <span className="detail-summary-label">Components</span>
                          <span className="detail-summary-value">{components.length}</span>
                        </div>
                        <div className="detail-summary-item">
                          <span className="detail-summary-label">Dependencies</span>
                          <span className="detail-summary-value">{summary?.dependenciesCount || 0}</span>
                        </div>
                      </>
                    )
                  })()}
                </>
              )}
            </div>
          </div>

          <div className="graph-section">
            <Notes meta={detail.meta} reportType={reportType} onSaved={handleNotesSaved} />
          </div>

          {reportType === 'vulnerabilityreport' && reportData && (
            <VulnDetail vulnerabilities={(reportData.vulnerabilities as Record<string, unknown>[]) || []} />
          )}

          {reportType === 'sbomreport' && reportData && (
            <SbomDetail reportData={reportData} />
          )}
        </>
      )}
    </section>
  )
}
