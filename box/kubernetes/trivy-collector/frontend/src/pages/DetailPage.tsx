import { useParams, useNavigate } from 'react-router-dom'
import DetailView from '../components/DetailView'
import type { ReportMeta, ReportType } from '../types'

interface DetailPageProps {
  reportType: ReportType
}

export default function DetailPage({ reportType }: DetailPageProps) {
  const { cluster = '', namespace = '', name = '' } = useParams<{ cluster: string; namespace: string; name: string }>()
  const navigate = useNavigate()

  const report: ReportMeta = {
    cluster: decodeURIComponent(cluster),
    namespace: decodeURIComponent(namespace),
    name: decodeURIComponent(name),
    app: '',
    image: '',
    registry: '',
    summary: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    components_count: 0,
    notes: '',
    notes_created_at: null,
    notes_updated_at: null,
    updated_at: '',
  }

  const handleBack = () => {
    const basePath = reportType === 'vulnerabilityreport' ? '/vulnerabilities' : '/sbom'
    navigate(basePath)
  }

  return (
    <DetailView
      report={report}
      reportType={reportType}
      onBack={handleBack}
    />
  )
}
