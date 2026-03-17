import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { getApiLogs, getApiLogStats, cleanupApiLogs } from '../api'
import type { ApiLogEntry, ApiLogStats } from '../types'
import { formatDate } from '../utils'
import styles from './AdminPage.module.css'

const PAGE_SIZE = 50
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const

type FilterKey = 'method' | 'path' | 'status' | 'user'

export default function AdminPage() {
  const { permissions } = useAuth()
  const [logs, setLogs] = useState<ApiLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<ApiLogStats | null>(null)
  const [offset, setOffset] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [showCleanup, setShowCleanup] = useState(false)

  // Filter state
  const [method, setMethod] = useState('')
  const [pathFilter, setPathFilter] = useState('')
  const [statusMin, setStatusMin] = useState('')
  const [statusMax, setStatusMax] = useState('')
  const [userFilter, setUserFilter] = useState('')

  // Popup state
  const [activePopup, setActivePopup] = useState<FilterKey | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const chipRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  // Close popup on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        // Check if click was on a chip button (toggle behavior)
        const isChip = Object.values(chipRefs.current).some(
          (el) => el && el.contains(e.target as Node),
        )
        if (!isChip) setActivePopup(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const fetchLogs = useCallback(async () => {
    try {
      const res = await getApiLogs({
        limit: PAGE_SIZE,
        offset,
        method: method || undefined,
        path: pathFilter || undefined,
        status_min: statusMin ? Number(statusMin) : undefined,
        status_max: statusMax ? Number(statusMax) : undefined,
        user: userFilter || undefined,
      })
      setLogs(res.items)
      setTotal(res.total)
    } catch {
      // silently ignore
    }
  }, [offset, method, pathFilter, statusMin, statusMax, userFilter])

  const fetchStats = useCallback(async () => {
    try {
      setStats(await getApiLogStats())
    } catch {
      // silently ignore
    }
  }, [])

  useEffect(() => {
    fetchLogs()
    fetchStats()
  }, [fetchLogs, fetchStats])

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => { fetchLogs(); fetchStats() }, 10000)
    return () => clearInterval(id)
  }, [autoRefresh, fetchLogs, fetchStats])

  const handleCleanup = async () => {
    try {
      await cleanupApiLogs(7)
      setShowCleanup(false)
      fetchLogs()
      fetchStats()
    } catch {
      // silently ignore
    }
  }

  const clearFilter = (key: FilterKey) => {
    if (key === 'method') setMethod('')
    if (key === 'path') setPathFilter('')
    if (key === 'status') { setStatusMin(''); setStatusMax('') }
    if (key === 'user') setUserFilter('')
    setOffset(0)
  }

  const togglePopup = (key: FilterKey) => {
    setActivePopup((prev) => (prev === key ? null : key))
  }

  // ─── Helpers ───

  const methodClass = (m: string) => {
    switch (m) {
      case 'GET': return styles.methodGet
      case 'POST': return styles.methodPost
      case 'PUT': return styles.methodPut
      case 'DELETE': return styles.methodDelete
      default: return ''
    }
  }

  const statusClass = (code: number) => {
    if (code < 300) return styles.status2xx
    if (code < 400) return styles.status3xx
    if (code < 500) return styles.status4xx
    return styles.status5xx
  }

  const statusLabel = () => {
    if (statusMin && statusMax) return `${statusMin}-${statusMax}`
    if (statusMin) return `>=${statusMin}`
    if (statusMax) return `<=${statusMax}`
    return ''
  }

  // ─── Popup position ───

  const getPopupStyle = (key: FilterKey): React.CSSProperties => {
    const chip = chipRefs.current[key]
    if (!chip) return {}
    const chipRect = chip.getBoundingClientRect()
    const containerEl = chip.closest(`.${styles.tableCard}`) as HTMLElement | null
    if (!containerEl) return {}
    const containerRect = containerEl.getBoundingClientRect()
    return {
      top: `${chipRect.bottom - containerRect.top + 5}px`,
      left: `${Math.max(10, chipRect.left - containerRect.left)}px`,
    }
  }

  if (!permissions?.can_admin) {
    return (
      <div className={styles.container}>
        <div className={styles.emptyState}>Access denied. Admin permissions required.</div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      {/* Stats cards */}
      {stats && (
        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{stats.total_requests.toLocaleString()}</div>
            <div className={styles.statLabel}>Total Requests</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{stats.requests_today.toLocaleString()}</div>
            <div className={styles.statLabel}>Today</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{stats.avg_duration_ms.toFixed(0)}ms</div>
            <div className={styles.statLabel}>Avg Duration</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{stats.error_count.toLocaleString()}</div>
            <div className={styles.statLabel}>Errors (4xx/5xx)</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{stats.unique_users}</div>
            <div className={styles.statLabel}>Unique Users</div>
          </div>
        </div>
      )}

      {/* Log table card */}
      <div className={styles.tableCard}>
        {/* Toolbar */}
        <div className={styles.toolbar}>
          <div className={styles.toolbarLeft}>
            {/* Method chip */}
            {method ? (
              <button
                className={styles.filterChipActive}
                ref={(el) => { chipRefs.current.method = el }}
                onClick={() => togglePopup('method')}
              >
                Method: <span className={styles.filterChipValue}>{method}</span>
                <span className={styles.filterChipClear} onClick={(e) => { e.stopPropagation(); clearFilter('method') }}>
                  <i className="fa-solid fa-xmark" />
                </span>
              </button>
            ) : (
              <button
                className={styles.filterChip}
                ref={(el) => { chipRefs.current.method = el }}
                onClick={() => togglePopup('method')}
              >
                <i className="fa-solid fa-filter" /> Method
              </button>
            )}

            {/* Path chip */}
            {pathFilter ? (
              <button
                className={styles.filterChipActive}
                ref={(el) => { chipRefs.current.path = el }}
                onClick={() => togglePopup('path')}
              >
                Path: <span className={styles.filterChipValue}>{pathFilter}</span>
                <span className={styles.filterChipClear} onClick={(e) => { e.stopPropagation(); clearFilter('path') }}>
                  <i className="fa-solid fa-xmark" />
                </span>
              </button>
            ) : (
              <button
                className={styles.filterChip}
                ref={(el) => { chipRefs.current.path = el }}
                onClick={() => togglePopup('path')}
              >
                <i className="fa-solid fa-filter" /> Path
              </button>
            )}

            {/* Status chip */}
            {(statusMin || statusMax) ? (
              <button
                className={styles.filterChipActive}
                ref={(el) => { chipRefs.current.status = el }}
                onClick={() => togglePopup('status')}
              >
                Status: <span className={styles.filterChipValue}>{statusLabel()}</span>
                <span className={styles.filterChipClear} onClick={(e) => { e.stopPropagation(); clearFilter('status') }}>
                  <i className="fa-solid fa-xmark" />
                </span>
              </button>
            ) : (
              <button
                className={styles.filterChip}
                ref={(el) => { chipRefs.current.status = el }}
                onClick={() => togglePopup('status')}
              >
                <i className="fa-solid fa-filter" /> Status
              </button>
            )}

            {/* User chip */}
            {userFilter ? (
              <button
                className={styles.filterChipActive}
                ref={(el) => { chipRefs.current.user = el }}
                onClick={() => togglePopup('user')}
              >
                User: <span className={styles.filterChipValue}>{userFilter}</span>
                <span className={styles.filterChipClear} onClick={(e) => { e.stopPropagation(); clearFilter('user') }}>
                  <i className="fa-solid fa-xmark" />
                </span>
              </button>
            ) : (
              <button
                className={styles.filterChip}
                ref={(el) => { chipRefs.current.user = el }}
                onClick={() => togglePopup('user')}
              >
                <i className="fa-solid fa-filter" /> User
              </button>
            )}
          </div>

          <div className={styles.toolbarRight}>
            <label className={styles.autoRefresh}>
              <input
                type="checkbox"
                className={styles.toggle}
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Auto (10s)
            </label>
            <button className={styles.toolbarBtn} onClick={() => { fetchLogs(); fetchStats() }}>
              <i className="fa-solid fa-rotate-right" /> Refresh
            </button>
            <button className={styles.toolbarBtnDanger} onClick={() => setShowCleanup(true)}>
              <i className="fa-solid fa-trash" /> Cleanup
            </button>
          </div>
        </div>

        {/* Filter popups */}
        {activePopup === 'method' && (
          <MethodPopup
            ref={popupRef}
            style={getPopupStyle('method')}
            value={method}
            onSelect={(v) => { setMethod(v); setOffset(0); setActivePopup(null) }}
            onClear={() => { clearFilter('method'); setActivePopup(null) }}
            onClose={() => setActivePopup(null)}
          />
        )}
        {activePopup === 'path' && (
          <TextPopup
            ref={popupRef}
            style={getPopupStyle('path')}
            title="Path"
            placeholder="Path prefix (e.g. /api/v1/admin)"
            value={pathFilter}
            onApply={(v) => { setPathFilter(v); setOffset(0); setActivePopup(null) }}
            onClear={() => { clearFilter('path'); setActivePopup(null) }}
            onClose={() => setActivePopup(null)}
          />
        )}
        {activePopup === 'status' && (
          <StatusPopup
            ref={popupRef}
            style={getPopupStyle('status')}
            min={statusMin}
            max={statusMax}
            onApply={(min, max) => { setStatusMin(min); setStatusMax(max); setOffset(0); setActivePopup(null) }}
            onClear={() => { clearFilter('status'); setActivePopup(null) }}
            onClose={() => setActivePopup(null)}
          />
        )}
        {activePopup === 'user' && (
          <TextPopup
            ref={popupRef}
            style={getPopupStyle('user')}
            title="User"
            placeholder="Email or sub..."
            value={userFilter}
            onApply={(v) => { setUserFilter(v); setOffset(0); setActivePopup(null) }}
            onClear={() => { clearFilter('user'); setActivePopup(null) }}
            onClose={() => setActivePopup(null)}
          />
        )}

        {/* Table */}
        {logs.length === 0 ? (
          <div className={styles.emptyState}>No API logs found.</div>
        ) : (
          <>
            <table className={styles.logTable}>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>User</th>
                  <th>Remote</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className={styles.mono}>{formatDate(log.created_at)}</td>
                    <td>
                      <span className={`${styles.methodBadge} ${methodClass(log.method)}`}>
                        {log.method}
                      </span>
                    </td>
                    <td className={styles.pathCell} title={log.path}>{log.path}</td>
                    <td className={`${styles.mono} ${statusClass(log.status_code)}`}>
                      {log.status_code}
                    </td>
                    <td className={styles.mono}>{log.duration_ms}ms</td>
                    <td className={styles.userCell} title={log.user_email || log.user_sub}>
                      {log.user_email || log.user_sub || '-'}
                    </td>
                    <td className={styles.mono}>{log.remote_addr || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className={styles.pagination}>
              <span className={styles.paginationInfo}>
                Showing {offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}
              </span>
              <div className={styles.paginationBtns}>
                <button
                  className={styles.pageBtn}
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </button>
                <button
                  className={styles.pageBtn}
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Top paths */}
      {stats && stats.top_paths.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Top Paths</h3>
          </div>
          <table className={styles.logTable}>
            <thead>
              <tr>
                <th>Path</th>
                <th>Requests</th>
              </tr>
            </thead>
            <tbody>
              {stats.top_paths.map(([path, count]) => (
                <tr key={path}>
                  <td className={styles.mono}>{path}</td>
                  <td className={styles.mono}>{count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Cleanup modal */}
      {showCleanup && (
        <div className={styles.overlay} onClick={() => setShowCleanup(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Cleanup API Logs</h3>
            <p className={styles.modalText}>
              This will delete all API logs older than 7 days. This action cannot be undone.
            </p>
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setShowCleanup(false)}>Cancel</button>
              <button className={styles.dangerBtn} onClick={handleCleanup}>Delete Old Logs</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Filter Popup Components ───

import { forwardRef } from 'react'

interface MethodPopupProps {
  style: React.CSSProperties
  value: string
  onSelect: (v: string) => void
  onClear: () => void
  onClose: () => void
}

const MethodPopup = forwardRef<HTMLDivElement, MethodPopupProps>(
  ({ style, value, onSelect, onClear, onClose }, ref) => (
    <div ref={ref} className={styles.filterPopup} style={style}>
      <div className={styles.filterPopupHeader}>
        <span className={styles.filterPopupTitle}>Method</span>
        <button className={styles.filterPopupClose} onClick={onClose}><i className="fa-solid fa-xmark" /></button>
      </div>
      <div className={styles.filterPopupBody}>
        <div className={styles.filterPopupOptions}>
          {HTTP_METHODS.map((m) => (
            <button
              key={m}
              className={`${styles.filterOption} ${value === m ? styles.filterOptionActive : ''}`}
              onClick={() => onSelect(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.filterPopupFooter}>
        <button className="btn-secondary" onClick={onClear}>Clear</button>
      </div>
    </div>
  ),
)

interface TextPopupProps {
  style: React.CSSProperties
  title: string
  placeholder: string
  value: string
  onApply: (v: string) => void
  onClear: () => void
  onClose: () => void
}

const TextPopup = forwardRef<HTMLDivElement, TextPopupProps>(
  ({ style, title, placeholder, value, onApply, onClear, onClose }, ref) => {
    const [input, setInput] = useState(value)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, [])

    return (
      <div ref={ref} className={styles.filterPopup} style={style}>
        <div className={styles.filterPopupHeader}>
          <span className={styles.filterPopupTitle}>{title}</span>
          <button className={styles.filterPopupClose} onClick={onClose}><i className="fa-solid fa-xmark" /></button>
        </div>
        <div className={styles.filterPopupBody}>
          <input
            ref={inputRef}
            type="text"
            placeholder={placeholder}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onApply(input) }}
          />
        </div>
        <div className={styles.filterPopupFooter}>
          <button className="btn-primary" onClick={() => onApply(input)}>Apply</button>
          <button className="btn-secondary" onClick={onClear}>Clear</button>
        </div>
      </div>
    )
  },
)

interface StatusPopupProps {
  style: React.CSSProperties
  min: string
  max: string
  onApply: (min: string, max: string) => void
  onClear: () => void
  onClose: () => void
}

const StatusPopup = forwardRef<HTMLDivElement, StatusPopupProps>(
  ({ style, min, max, onApply, onClear, onClose }, ref) => {
    const [minVal, setMinVal] = useState(min)
    const [maxVal, setMaxVal] = useState(max)
    const minRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
      minRef.current?.focus()
      minRef.current?.select()
    }, [])

    const handleNumericChange = (value: string, setter: (v: string) => void) => {
      const cleaned = value.replace(/[^0-9]/g, '')
      setter(cleaned)
    }

    return (
      <div ref={ref} className={styles.filterPopup} style={style}>
        <div className={styles.filterPopupHeader}>
          <span className={styles.filterPopupTitle}>Status Code</span>
          <button className={styles.filterPopupClose} onClick={onClose}><i className="fa-solid fa-xmark" /></button>
        </div>
        <div className={styles.filterPopupBody}>
          <div className={styles.statusRange}>
            <input
              ref={minRef}
              type="text"
              inputMode="numeric"
              placeholder="200"
              value={minVal}
              onChange={(e) => handleNumericChange(e.target.value, setMinVal)}
              onKeyDown={(e) => { if (e.key === 'Enter') onApply(minVal, maxVal) }}
            />
            <span className={styles.statusRangeSep}>-</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="599"
              value={maxVal}
              onChange={(e) => handleNumericChange(e.target.value, setMaxVal)}
              onKeyDown={(e) => { if (e.key === 'Enter') onApply(minVal, maxVal) }}
            />
          </div>
        </div>
        <div className={styles.filterPopupFooter}>
          <button className="btn-primary" onClick={() => onApply(minVal, maxVal)}>Apply</button>
          <button className="btn-secondary" onClick={onClear}>Clear</button>
        </div>
      </div>
    )
  },
)
