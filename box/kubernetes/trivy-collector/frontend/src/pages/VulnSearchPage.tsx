import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { searchVulnerabilities, suggestVulnerabilities } from '../api'
import { formatDate } from '../utils'
import type { VulnSearchResult } from '../types'
import styles from './ComponentSearchPage.module.css'

export default function VulnSearchPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const [input, setInput] = useState(searchParams.get('q') || '')
  const [results, setResults] = useState<VulnSearchResult[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  // Autocomplete state
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [inputError, setInputError] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const query = searchParams.get('q') || ''

  const doSearch = useCallback((q: string) => {
    if (!q.trim()) {
      setResults([])
      return
    }
    setLoading(true)
    searchVulnerabilities(q.trim())
      .then((data) => {
        setResults(data.items || [])
        setTotal(data.total || 0)
      })
      .catch(() => {
        setResults([])
        setTotal(0)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    doSearch(query)
  }, [query, doSearch])

  const fetchSuggestions = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.trim().length < 2) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    debounceRef.current = setTimeout(() => {
      suggestVulnerabilities(value.trim(), 20)
        .then((names) => {
          setSuggestions(names)
          setShowSuggestions(names.length > 0)
          setSelectedIdx(-1)
        })
        .catch(() => {
          setSuggestions([])
          setShowSuggestions(false)
        })
    }, 300)
  }, [])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const ALLOWED = /^[a-zA-Z0-9_\-./@:+]*$/

  const handleInputChange = (value: string) => {
    setInput(value)
    const valid = ALLOWED.test(value)
    setInputError(!valid)
    if (valid) fetchSuggestions(value)
  }

  const submitSearch = (value: string) => {
    const trimmed = value.trim()
    if (trimmed && ALLOWED.test(trimmed)) {
      setSearchParams({ q: trimmed })
      setShowSuggestions(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    submitSearch(input)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1))
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault()
      const selected = suggestions[selectedIdx]
      setInput(selected)
      submitSearch(selected)
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
    }
  }

  const handleSuggestionClick = (name: string) => {
    setInput(name)
    submitSearch(name)
  }

  const handleRowClick = (r: VulnSearchResult) => {
    navigate(`/vulnerabilities/${encodeURIComponent(r.cluster)}/${encodeURIComponent(r.namespace)}/${encodeURIComponent(r.name)}`)
    window.scrollTo(0, 0)
  }

  const severityClass = (severity: string) => {
    switch (severity.toUpperCase()) {
      case 'CRITICAL': return 'severity-critical'
      case 'HIGH': return 'severity-high'
      case 'MEDIUM': return 'severity-medium'
      case 'LOW': return 'severity-low'
      default: return 'severity-unknown'
    }
  }

  return (
    <section className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/vulnerabilities')}>
            <i className="fa-solid fa-arrow-left" /> Back to Vuln List
          </button>
          <div ref={wrapperRef} className={styles.searchWrapper}>
            <form className={styles.searchForm} onSubmit={handleSubmit}>
              <input
                ref={inputRef}
                type="text"
                className={`${styles.searchInput} ${inputError ? styles.searchInputError : ''}`}
                placeholder="Search CVE ID or package (e.g. CVE-2024)"
                size={"Search CVE ID or package (e.g. CVE-2024)".length}
                value={input}
                onChange={(e) => handleInputChange(e.target.value)}
                onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true) }}
                onKeyDown={handleKeyDown}
                autoFocus
              />
              <button type="submit" className={styles.searchBtn} disabled={inputError}>
                <i className="fa-solid fa-magnifying-glass" /> Search
              </button>
            </form>
            {showSuggestions && suggestions.length > 0 && inputRef.current && (() => {
              const rect = inputRef.current!.getBoundingClientRect()
              return (
                <ul
                  className={styles.suggestions}
                  style={{
                    top: rect.bottom + 4,
                    left: rect.left,
                    width: rect.width,
                  }}
                >
                  {suggestions.map((name, i) => (
                    <li
                      key={name}
                      className={`${styles.suggestionItem} ${i === selectedIdx ? styles.suggestionActive : ''}`}
                      onMouseDown={() => handleSuggestionClick(name)}
                      onMouseEnter={() => setSelectedIdx(i)}
                    >
                      {name}
                    </li>
                  ))}
                </ul>
              )
            })()}
          </div>
          {query && !loading && (() => {
            const reportCount = new Set(results.map((r) => `${r.cluster}/${r.namespace}/${r.name}`)).size
            const countLabel = results.length < total
              ? `${results.length.toLocaleString()} of ${total.toLocaleString()}`
              : `${total.toLocaleString()}`
            return (
              <span className={styles.resultCount}>
                <span className={styles.resultCountNum}>{countLabel}</span> match{total !== 1 ? 'es' : ''} in <span className={styles.resultCountNum}>{reportCount}</span> report{reportCount !== 1 ? 's' : ''}
              </span>
            )
          })()}
        </div>
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Cluster</th>
            <th>Namespace</th>
            <th>Image</th>
            <th>CVE</th>
            <th>Severity</th>
            <th>Score</th>
            <th>Package</th>
            <th>Installed</th>
            <th>Fixed</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={10} className={styles.emptyState}>Searching...</td>
            </tr>
          ) : results.length === 0 ? (
            <tr>
              <td colSpan={10} className={styles.emptyState}>
                {query ? 'No matching vulnerabilities found' : 'Enter a CVE ID or package name to search across all vulnerability reports'}
              </td>
            </tr>
          ) : (
            results.map((r, i) => (
              <tr key={`${r.cluster}/${r.namespace}/${r.name}/${r.vulnerability_id}/${r.resource}/${i}`} onClick={() => handleRowClick(r)}>
                <td>{r.cluster}</td>
                <td>{r.namespace}</td>
                <td>{r.image}</td>
                <td className={styles.componentCell}>{r.vulnerability_id}</td>
                <td><span className={`severity-badge ${severityClass(r.severity)}`}>{r.severity}</span></td>
                <td className={styles.versionCell}>{r.score != null ? r.score.toFixed(1) : '-'}</td>
                <td className={styles.componentCell}>{r.resource}</td>
                <td className={styles.versionCell}>{r.installed_version || '-'}</td>
                <td className={styles.versionCell}>{r.fixed_version || '-'}</td>
                <td>{formatDate(r.updated_at)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  )
}
