import { Link, useLocation } from 'react-router-dom'

const tabs: { to: string; label: string }[] = [
  { to: '/admin/clusters', label: 'Clusters' },
  { to: '/admin/audit', label: 'API Audit' },
]

export default function AdminSubNav() {
  const { pathname } = useLocation()
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        borderBottom: '1px solid var(--border)',
        marginBottom: 16,
      }}
    >
      {tabs.map((t) => {
        const active = pathname.startsWith(t.to)
        return (
          <Link
            key={t.to}
            to={t.to}
            style={{
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
              color: active ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
