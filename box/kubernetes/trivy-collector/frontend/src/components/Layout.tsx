import { useState, useEffect, useCallback } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import Header from './Header'
import { getStats, getClusters, getNamespaces, getVersion } from '../api'
import { usePolling } from '../hooks/usePolling'
import type { Stats, ClusterInfo, VersionResponse } from '../types'

export default function Layout() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [clusterOptions, setClusterOptions] = useState<ClusterInfo[]>([])
  const [namespaceOptions, setNamespaceOptions] = useState<string[]>([])
  const [version, setVersion] = useState<VersionResponse | null>(null)
  const [filterCluster, setFilterCluster] = useState('')

  const location = useLocation()
  const navigate = useNavigate()

  // Polling for stats
  const statsFetcher = useCallback(() => getStats(), [])
  const { data: polledStats } = usePolling<Stats>(statsFetcher, 5000)

  useEffect(() => {
    if (polledStats) {
      setStats(polledStats)
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
    getNamespaces(filterCluster || undefined)
      .then((data) => setNamespaceOptions(data.items || []))
      .catch(() => {})
  }, [filterCluster])

  // Keyboard shortcut: Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const path = location.pathname
        if (path.startsWith('/vulnerabilities/')) {
          navigate('/vulnerabilities')
        } else if (path.startsWith('/sbom/')) {
          navigate('/sbom')
        } else if (path === '/dashboard' || path === '/version') {
          navigate('/vulnerabilities')
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [location.pathname, navigate])

  return (
    <>
      <Header version={version} />
      <main>
        <Outlet context={{ stats, clusterOptions, namespaceOptions, setFilterCluster }} />
      </main>
      <footer>
        <p>Trivy Collector &mdash; Multi-cluster security report aggregator
          <span style={{ margin: '0 8px' }}>|</span>
          <a href="/swagger-ui/" target="_blank" rel="noopener noreferrer">API Docs</a>
        </p>
      </footer>
    </>
  )
}
