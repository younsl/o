import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { listTokens, createToken, deleteToken } from '../api'
import { formatDate } from '../utils'
import type { TokenInfo } from '../types'
import styles from './AuthPage.module.css'

const TOKEN_NAME_RE = /^[A-Za-z0-9_-]{4,64}$/

const EXPIRY_OPTIONS = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: '1 year' },
] as const

function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt) <= new Date()
}

export default function AuthPage() {
  const { authMode, authenticated, user, loginAt } = useAuth()
  const [tokens, setTokens] = useState<TokenInfo[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [tokenName, setTokenName] = useState('')
  const [tokenDescription, setTokenDescription] = useState('')
  const [expiresDays, setExpiresDays] = useState(30)
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [snippetTool, setSnippetTool] = useState<'curl' | 'wget'>('curl')
  const [snippetCopied, setSnippetCopied] = useState(false)
  const [showBestPractices, setShowBestPractices] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TokenInfo | null>(null)
  const [deleteConfirmName, setDeleteConfirmName] = useState('')
  const [expiryOpen, setExpiryOpen] = useState(false)
  const expiryRef = useRef<HTMLDivElement>(null)

  const loadTokens = useCallback(async () => {
    if (authMode !== 'keycloak' || !authenticated) return
    try {
      const data = await listTokens()
      setTokens(data.tokens)
    } catch {
      // ignore
    }
  }, [authMode, authenticated])

  useEffect(() => {
    loadTokens()
  }, [loadTokens])

  useEffect(() => {
    if (showCreateModal || deleteTarget) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [showCreateModal, deleteTarget])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (expiryRef.current && !expiryRef.current.contains(e.target as Node)) {
        setExpiryOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  if (authMode !== 'keycloak') {
    return (
      <div className={styles.container}>
        <div className={styles.noAuth}>
          Authentication is not enabled. Set <code>AUTH_MODE=keycloak</code> to use this page.
        </div>
      </div>
    )
  }

  if (!authenticated || !user) {
    return (
      <div className={styles.container}>
        <div className={styles.noAuth}>Loading user info...</div>
      </div>
    )
  }

  const handleCreate = async () => {
    if (!TOKEN_NAME_RE.test(tokenName.trim())) return
    setCreating(true)
    setError(null)
    try {
      const result = await createToken(tokenName.trim(), tokenDescription.trim(), expiresDays)
      setCreatedToken(result.token)
      loadTokens()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create token')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    await deleteToken(deleteTarget.id)
    setDeleteTarget(null)
    setDeleteConfirmName('')
    loadTokens()
  }

  const closeDeleteModal = () => {
    setDeleteTarget(null)
    setDeleteConfirmName('')
  }

  const handleCopy = async () => {
    if (!createdToken) return
    await navigator.clipboard.writeText(createdToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const closeModal = () => {
    setShowCreateModal(false)
    setTokenName('')
    setTokenDescription('')
    setExpiresDays(30)
    setCreatedToken(null)
    setError(null)
    setCopied(false)
    setSnippetCopied(false)
    setShowBestPractices(false)
    setExpiryOpen(false)
  }

  return (
    <div className={styles.container}>
      {/* User Info Section */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>User Information</h3>
        <div className={styles.infoGrid}>
          <span className={styles.infoLabel}>Subject ID</span>
          <span className={`${styles.infoValue} ${styles.mono}`}>{user.sub}</span>

          {user.name && (
            <>
              <span className={styles.infoLabel}>Name</span>
              <span className={styles.infoValue}>{user.name}</span>
            </>
          )}

          {user.email && (
            <>
              <span className={styles.infoLabel}>Email</span>
              <span className={styles.infoValue}>{user.email}</span>
            </>
          )}

          {user.preferred_username && (
            <>
              <span className={styles.infoLabel}>Username</span>
              <span className={styles.infoValue}>{user.preferred_username}</span>
            </>
          )}

          <span className={styles.infoLabel}>Groups</span>
          <span className={`${styles.infoValue}${user.groups.length === 0 ? ` ${styles.muted}` : ''}`}>
            {user.groups.length > 0 ? user.groups.join(', ') : 'No groups assigned'}
          </span>

          {loginAt && (
            <>
              <span className={styles.infoLabel}>Session Started</span>
              <span className={styles.infoValue}>{formatDate(loginAt)}</span>
            </>
          )}
        </div>
      </div>

      {/* API Tokens Section */}
      <div className={styles.section}>
        <div className={styles.tokenHeader}>
          <h3 className={styles.sectionTitle} style={{ marginBottom: 0 }}>API Tokens</h3>
          <button
            className={styles.createBtn}
            onClick={() => setShowCreateModal(true)}
            disabled={tokens.length >= 5}
            title={tokens.length >= 5 ? 'Maximum 5 tokens per user' : undefined}
          >
            <i className="fa-solid fa-plus" /> Create Token ({tokens.length}/5)
          </button>
        </div>

        {tokens.length > 0 ? (
          <table className={styles.tokenTable}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Last Used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div>{t.name}</div>
                    {t.description && (
                      <div className={styles.tokenDesc}>{t.description}</div>
                    )}
                  </td>
                  <td className={styles.tokenPrefix}>{t.token_prefix}...</td>
                  <td>{formatDate(t.created_at)}</td>
                  <td className={isExpired(t.expires_at) ? styles.expired : ''}>
                    {formatDate(t.expires_at)}
                    {isExpired(t.expires_at) && ' (expired)'}
                  </td>
                  <td>{t.last_used_at ? formatDate(t.last_used_at) : 'Never'}</td>
                  <td>
                    <button
                      className={styles.deleteBtn}
                      onClick={() => setDeleteTarget(t)}
                      title="Delete token"
                    >
                      <i className="fa-solid fa-trash" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className={styles.emptyState}>
            No API tokens yet. Create one to authenticate API requests.
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className={styles.overlay} onClick={closeDeleteModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Delete Token</h3>
            <p className={styles.deleteWarning}>
              This action cannot be undone. Any applications using this token will lose access.
            </p>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>
                Token Name <span className={styles.required}>Required</span>
              </label>
              <p className={styles.formHint}>
                Type <strong>{deleteTarget.name}</strong> to confirm deletion
              </p>
              <input
                className={styles.formInput}
                type="text"
                placeholder={deleteTarget.name}
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && deleteConfirmName === deleteTarget.name) handleDelete()
                }}
              />
            </div>
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={closeDeleteModal}>
                Cancel
              </button>
              <button
                className={styles.deleteBtnConfirm}
                onClick={handleDelete}
                disabled={deleteConfirmName !== deleteTarget.name}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Token Modal */}
      {showCreateModal && (
        <div className={styles.overlay} onClick={closeModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>
              {createdToken ? 'Token Created' : 'Create API Token'}
            </h3>

            {!createdToken ? (
              <>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>
                    Token Name <span className={styles.required}>Required</span>
                  </label>
                  <input
                    className={`${styles.formInput}${error ? ` ${styles.formInputError}` : ''}`}
                    type="text"
                    placeholder="e.g. my-ci-token"
                    value={tokenName}
                    onChange={(e) => { setTokenName(e.target.value); setError(null) }}
                    minLength={4}
                    maxLength={64}
                    autoFocus
                  />
                  {error ? (
                    <span className={styles.formHintError}>
                      <i className="fa-solid fa-circle-exclamation" /> {error}
                    </span>
                  ) : (
                    <span className={tokenName.length > 0 && !TOKEN_NAME_RE.test(tokenName.trim()) ? styles.formHintError : styles.formHint}>
                      4-64 characters, only letters, digits, hyphens, underscores
                    </span>
                  )}
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Description</label>
                  <input
                    className={styles.formInput}
                    type="text"
                    placeholder="e.g. CI/CD pipeline token for GitHub Actions"
                    value={tokenDescription}
                    onChange={(e) => setTokenDescription(e.target.value)}
                    maxLength={256}
                  />
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>
                    Expiration <span className={styles.required}>Required</span>
                  </label>
                  <div className={styles.dropdown} ref={expiryRef}>
                    <button
                      type="button"
                      className={`${styles.dropdownToggle}${expiryOpen ? ` ${styles.dropdownOpen}` : ''}`}
                      onClick={() => setExpiryOpen((v) => !v)}
                    >
                      <span>{EXPIRY_OPTIONS.find((o) => o.days === expiresDays)?.label}</span>
                      <i className={`fa-solid fa-chevron-down ${styles.dropdownIcon}${expiryOpen ? ` ${styles.dropdownIconOpen}` : ''}`} />
                    </button>
                    {expiryOpen && (
                      <ul className={styles.dropdownMenu}>
                        {EXPIRY_OPTIONS.map((opt) => (
                          <li key={opt.days}>
                            <button
                              type="button"
                              className={`${styles.dropdownItem}${opt.days === expiresDays ? ` ${styles.dropdownItemActive}` : ''}`}
                              onClick={() => { setExpiresDays(opt.days); setExpiryOpen(false) }}
                            >
                              {opt.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <span className={styles.formHint}>Perpetual tokens are not supported for security reasons</span>
                </div>

                <div className={styles.modalActions}>
                  <button className={styles.cancelBtn} onClick={closeModal}>
                    Cancel
                  </button>
                  <button
                    className={styles.createBtn}
                    onClick={handleCreate}
                    disabled={creating || !TOKEN_NAME_RE.test(tokenName.trim())}
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </>
            ) : (
              <div className={styles.tokenReveal}>
                <div className={styles.tokenWarning}>
                  <i className="fa-solid fa-triangle-exclamation" /> Copy this token now. You won't be able to see it again.
                </div>
                <div className={styles.tokenDisplay}>
                  <span className={styles.tokenText}>{createdToken}</span>
                  <button className={styles.copyBtn} onClick={handleCopy}>
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div className={styles.snippetSection}>
                  <div className={styles.snippetHeader}>
                    <span className={styles.snippetLabel}>Test command</span>
                    <div className={styles.snippetToggle}>
                      <button
                        type="button"
                        className={`${styles.snippetToggleBtn}${snippetTool === 'curl' ? ` ${styles.snippetToggleActive}` : ''}`}
                        onClick={() => setSnippetTool('curl')}
                      >
                        curl
                      </button>
                      <button
                        type="button"
                        className={`${styles.snippetToggleBtn}${snippetTool === 'wget' ? ` ${styles.snippetToggleActive}` : ''}`}
                        onClick={() => setSnippetTool('wget')}
                      >
                        wget
                      </button>
                    </div>
                  </div>
                  <div className={styles.snippetDisplay}>
                    <code className={styles.snippetText}>
                      {snippetTool === 'curl'
                        ? `curl -H "Authorization: Bearer ${createdToken}" ${window.location.origin}/api/v1/stats`
                        : `wget -qO- --header="Authorization: Bearer ${createdToken}" ${window.location.origin}/api/v1/stats`}
                    </code>
                    <button
                      className={styles.copyBtn}
                      onClick={() => {
                        const cmd = snippetTool === 'curl'
                          ? `curl -H "Authorization: Bearer ${createdToken}" ${window.location.origin}/api/v1/stats`
                          : `wget -qO- --header="Authorization: Bearer ${createdToken}" ${window.location.origin}/api/v1/stats`
                        navigator.clipboard.writeText(cmd)
                        setSnippetCopied(true)
                        setTimeout(() => setSnippetCopied(false), 2000)
                      }}
                    >
                      {snippetCopied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
                <div className={styles.bestPractices}>
                  <label className={styles.bestPracticesLabel}>
                    <span><i className="fa-solid fa-shield-halved" /> Best practices</span>
                    <input
                      type="checkbox"
                      className={styles.toggle}
                      checked={showBestPractices}
                      onChange={(e) => setShowBestPractices(e.target.checked)}
                    />
                  </label>
                  {showBestPractices && (
                    <ul className={styles.bestPracticesList}>
                      <li>Store tokens in environment variables or secret managers, never in source code</li>
                      <li>Do not share tokens via chat or email — use a secrets vault instead</li>
                      <li>Set the shortest expiration that meets your needs</li>
                      <li>Revoke tokens immediately when no longer needed</li>
                    </ul>
                  )}
                </div>
                <div className={styles.modalActions}>
                  <button className={styles.createBtn} onClick={closeModal}>
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
