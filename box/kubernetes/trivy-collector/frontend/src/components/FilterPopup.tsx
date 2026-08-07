import { useState, useEffect, useRef } from 'react'
import type { ClusterInfo } from '../types'
import styles from './FilterPopup.module.css'

interface FilterPopupProps {
  filterKey: 'cluster' | 'namespace' | 'app'
  currentValue: string
  clusterOptions: ClusterInfo[]
  namespaceOptions: string[]
  anchorRect: DOMRect
  containerRect: DOMRect
  onApply: (key: string, value: string) => void
  onClear: (key: string) => void
  onClose: () => void
}

export default function FilterPopup({
  filterKey,
  currentValue,
  clusterOptions,
  namespaceOptions,
  anchorRect,
  containerRect,
  onApply,
  onClear,
  onClose,
}: FilterPopupProps) {
  const [value, setValue] = useState(currentValue)
  const popupRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (filterKey === 'app' && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [filterKey])

  const popupWidth = 220
  let left = anchorRect.left - containerRect.left
  if (left + popupWidth > containerRect.width) left = containerRect.width - popupWidth - 10
  const top = anchorRect.bottom - containerRect.top + 5

  const titles: Record<string, string> = { cluster: 'Cluster', namespace: 'Namespace', app: 'Application' }

  return (
    <div
      ref={popupRef}
      className={styles.popup}
      style={{ top: `${top}px`, left: `${Math.max(10, left)}px` }}
    >
      <div className={styles.popupHeader}>
        <span className={styles.popupTitle}>{titles[filterKey] || 'Filter'}</span>
        <button className={styles.closeButton} onClick={onClose}><i className="fa-solid fa-xmark" /></button>
      </div>
      <div className={styles.popupBody}>
        {filterKey === 'cluster' && (
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">All Clusters</option>
            {clusterOptions.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.vuln_report_count} vuln, {c.sbom_report_count} sbom)
              </option>
            ))}
          </select>
        )}
        {filterKey === 'namespace' && (
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">All Namespaces</option>
            {namespaceOptions.map((ns) => (
              <option key={ns} value={ns}>{ns}</option>
            ))}
          </select>
        )}
        {filterKey === 'app' && (
          <input
            ref={inputRef}
            type="text"
            placeholder="Search application..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onApply(filterKey, value) }}
          />
        )}
      </div>
      <div className={styles.popupFooter}>
        <button className="btn-primary" onClick={() => onApply(filterKey, value)}>Apply</button>
        <button className="btn-secondary" onClick={() => onClear(filterKey)}>Clear</button>
      </div>
    </div>
  )
}
