import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import type { AuthPermissions } from '../types'

interface Tab {
  to: string
  label: string
  description: string
  /** Predicate over current user permissions; tab is shown when true. */
  visible: (p: AuthPermissions | null | undefined) => boolean
}

const tabs: Tab[] = [
  {
    to: '/admin/clusters',
    label: 'Clusters',
    description:
      'Register edge clusters for hub-pull mode and review their report sync status.',
    visible: (p) => !!p?.can_view_clusters,
  },
  {
    to: '/admin/alerts',
    label: 'Alerts',
    description:
      'Define ConfigMap-backed alert rules and route matching findings to Slack receivers.',
    visible: (p) => !!p?.can_view_alerts,
  },
  {
    to: '/admin/audit',
    label: 'API Audit',
    description:
      'Inspect recent API requests, latency, and error rates for operator-driven actions.',
    visible: (p) => !!p?.can_admin,
  },
]

export default function AdminSubNav() {
  const { pathname } = useLocation()
  const { permissions } = useAuth()
  const visibleTabs = tabs.filter((t) => t.visible(permissions))
  const active = visibleTabs.find((t) => pathname.startsWith(t.to))
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {visibleTabs.map((t) => {
          const isActive = pathname.startsWith(t.to)
          return (
            <Link
              key={t.to}
              to={t.to}
              style={{
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'none',
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                borderBottom: isActive
                  ? '2px solid var(--accent)'
                  : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {t.label}
            </Link>
          )
        })}
      </div>
      {active && (
        <div
          style={{
            padding: '10px 4px 0',
            fontSize: 12,
            color: 'var(--text-muted)',
            lineHeight: 1.5,
          }}
        >
          {active.description}
        </div>
      )}
    </div>
  )
}
