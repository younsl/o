import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  getRegisteredClusters,
  deleteRegisteredCluster,
  registerCluster,
  getClusters,
  type RegisteredCluster,
} from '../api'
import type { ClusterInfo } from '../types'

interface LayoutContext {
  clusterOptions: ClusterInfo[]
}
import { SyntaxHighlight } from '../components/SyntaxHighlight'
import AdminSubNav from '../components/AdminSubNav'
import styles from './AdminPage.module.css'

const CODE_BLOCK_STYLE: React.CSSProperties = {
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: 12,
  maxHeight: 420,
  overflow: 'auto',
  fontSize: 12,
  lineHeight: 1.5,
  fontFamily: "'SF Mono', Monaco, Consolas, monospace",
  margin: 0,
  whiteSpace: 'pre',
  color: 'var(--text-primary)',
}

const INPUT_STYLE: React.CSSProperties = {
  fontSize: 13,
  padding: '6px 10px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  fontFamily: "'SF Mono', Monaco, Consolas, monospace",
}

// Kubernetes DNS-1123 label sanitisation:
//   - lowercase a-z, 0-9, '-'
//   - must start and end with an alphanumeric
//   - max 63 chars
// We coerce uppercase → lowercase, drop anything else, and trim a leading '-'.
function sanitizeDnsLabel(raw: string): string {
  const lowered = raw.toLowerCase()
  const filtered = lowered.replace(/[^a-z0-9-]/g, '')
  const noLead = filtered.replace(/^-+/, '')
  return noLead.slice(0, 63)
}


function CopyableBlock({
  title,
  lang,
  body,
  highlights = [],
}: {
  title: string
  lang: 'yaml' | 'bash'
  body: string
  highlights?: string[]
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
        <span style={{
          fontSize: 10, padding: '2px 6px', borderRadius: 4,
          background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
          fontFamily: "'SF Mono', Monaco, Consolas, monospace",
        }}>{lang}</span>
        <div style={{ flex: 1 }} />
        <button type="button" className={styles.toolbarBtn} onClick={copy}>
          <i className="fa-solid fa-copy" /> {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre style={CODE_BLOCK_STYLE}>
        <SyntaxHighlight body={body} lang={lang} highlights={highlights} />
      </pre>
    </div>
  )
}

// ── Step 1: bootstrap manifest generation ──────────────────────────────────

function buildBootstrapManifest(clusterName: string, edgeNs: string): string {
  return `---
apiVersion: v1
kind: Namespace
metadata:
  name: ${edgeNs}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: trivy-collector-reader
  namespace: ${edgeNs}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: trivy-collector-reader
rules:
  - apiGroups: ["aquasecurity.github.io"]
    resources: ["vulnerabilityreports", "sbomreports"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: trivy-collector-reader
subjects:
  - kind: ServiceAccount
    name: trivy-collector-reader
    namespace: ${edgeNs}
roleRef:
  kind: ClusterRole
  name: trivy-collector-reader
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: v1
kind: Secret
metadata:
  name: trivy-collector-reader-token
  namespace: ${edgeNs}
  annotations:
    kubernetes.io/service-account.name: trivy-collector-reader
type: kubernetes.io/service-account-token
# Cluster display name on Hub: ${clusterName}
`
}

function buildExtractCommands(edgeContext: string, edgeNs: string): string {
  const ctx = edgeContext || 'EDGE_CONTEXT'
  return `# Run on your workstation after Step 1 has been applied on Edge.
TOKEN=$(kubectl --context ${ctx} -n ${edgeNs} \\
  get secret trivy-collector-reader-token -o jsonpath='{.data.token}' | base64 -d)

CA=$(kubectl --context ${ctx} -n ${edgeNs} \\
  get secret trivy-collector-reader-token -o jsonpath='{.data.ca\\.crt}')

SERVER=$(kubectl --context ${ctx} config view --minify \\
  -o jsonpath='{.clusters[0].cluster.server}')

# Paste these three values into Step 2.
echo "server:  $SERVER"
echo "ca:      $CA"
echo "token:   $TOKEN"

# Verify the SA can read Trivy reports before registering:
kubectl --context ${ctx} --token "$TOKEN" \\
  auth can-i list vulnerabilityreports --all-namespaces`
}

function Step1Bootstrap({
  clusterName, edgeNamespace, edgeContext,
  setClusterName, setEdgeNamespace, setEdgeContext,
  onNext,
}: {
  clusterName: string
  edgeNamespace: string
  edgeContext: string
  setClusterName: (v: string) => void
  setEdgeNamespace: (v: string) => void
  setEdgeContext: (v: string) => void
  onNext: () => void
}) {
  const manifest = buildBootstrapManifest(clusterName || 'CLUSTER', edgeNamespace || 'trivy-system')
  const extract = buildExtractCommands(edgeContext, edgeNamespace || 'trivy-system')

  return (
    <div style={{ padding: 16 }}>
      <p style={{ marginTop: 0, color: 'var(--text-secondary)', fontSize: 13 }}>
        Apply the manifest on the Edge cluster with an admin kubeconfig. It
        creates a read-only ServiceAccount and a long-lived token Secret — no
        write permissions, no wildcards, no exec-plugin dependency.
      </p>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
        marginBottom: 8,
      }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Cluster name *</span>
          <input
            value={clusterName}
            onChange={(e) => setClusterName(sanitizeDnsLabel(e.target.value))}
            placeholder="edge-a" maxLength={63} style={INPUT_STYLE}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Edge namespace</span>
          <input
            value={edgeNamespace}
            onChange={(e) => setEdgeNamespace(sanitizeDnsLabel(e.target.value))}
            placeholder="trivy-system" maxLength={63} style={INPUT_STYLE}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Context</span>
          <input
            value={edgeContext}
            onChange={(e) => setEdgeContext(e.target.value)}
            placeholder="edge-a" style={INPUT_STYLE}
          />
        </label>
      </div>

      <CopyableBlock
        title="1-a · Apply on Edge with admin kubeconfig"
        lang="yaml"
        body={manifest}
        highlights={[clusterName, edgeNamespace].filter(Boolean)}
      />

      <CopyableBlock
        title="1-b · Extract token, CA, and API server URL from Edge"
        lang="bash"
        body={extract}
        highlights={[edgeNamespace, edgeContext].filter(Boolean)}
      />

      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className={styles.toolbarBtn} onClick={onNext}
          disabled={!clusterName}>
          Next: Register →
        </button>
      </div>
    </div>
  )
}

// ── Step 2: register with extracted credentials ────────────────────────────

function Step2Register({
  clusterName, edgeNamespace, onBack, onSuccess,
}: {
  clusterName: string
  edgeNamespace: string
  onBack: () => void
  onSuccess: () => void
}) {
  const [server, setServer] = useState('')
  const [caData, setCaData] = useState('')
  const [bearerToken, setBearerToken] = useState('')
  const [insecure, setInsecure] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await registerCluster({
        name: clusterName,
        server,
        bearer_token: bearerToken,
        ca_data: caData || undefined,
        insecure,
        namespaces: [],
      })
      setMessage({ kind: 'ok', text: 'Registered. The scraper will attach within a few seconds.' })
      onSuccess()
    } catch (err) {
      setMessage({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ padding: 16 }}>
      <p style={{ marginTop: 0, color: 'var(--text-secondary)', fontSize: 13 }}>
        Paste the three values from <code>Step 1-b</code> below. Registering
        creates the cluster-registration Secret on the Hub; the scraper's
        Secret watcher picks it up within seconds.
      </p>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
        marginBottom: 12,
      }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Cluster name</span>
          <input
            value={clusterName}
            disabled
            style={{ ...INPUT_STYLE, opacity: 0.7, cursor: 'not-allowed' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Edge namespace</span>
          <input
            value={edgeNamespace || 'trivy-system'}
            disabled
            style={{ ...INPUT_STYLE, opacity: 0.7, cursor: 'not-allowed' }}
          />
        </label>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
        To change these, go back to Step 1.
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>API server URL *</span>
        <input
          required value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="https://xxxx.eks.amazonaws.com"
          style={INPUT_STYLE}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>CA certificate</span>
        <textarea
          rows={4} value={caData}
          onChange={(e) => setCaData(e.target.value)}
          placeholder="LS0tLS1CRUdJTi..."
          style={{ ...INPUT_STYLE, fontSize: 12, padding: 10, resize: 'vertical' }}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Bearer token *</span>
        <textarea
          required rows={4} value={bearerToken}
          onChange={(e) => setBearerToken(e.target.value)}
          placeholder="eyJhbGci..."
          style={{ ...INPUT_STYLE, fontSize: 12, padding: 10, resize: 'vertical' }}
        />
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, fontSize: 12 }}>
        <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />
        Skip TLS verify
      </label>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <button type="button" className={styles.toolbarBtn} onClick={onBack}>
          ← Back
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {message && (
            <span style={{
              fontSize: 12,
              color: message.kind === 'ok' ? 'var(--accent)' : 'var(--text-error, #ef4444)',
            }}>
              {message.text}
            </span>
          )}
          <button type="submit" className={styles.toolbarBtn} disabled={busy}>
            {busy ? 'Registering…' : 'Register cluster'}
          </button>
        </div>
      </div>
    </form>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function ClustersPage() {
  const { permissions } = useAuth()
  // Seed initial state from the Layout-level clusterOptions cache (fetched
  // once at app entry and shared across routes via Outlet context). On page
  // re-entry this gives us immediate Synced/Reports display instead of a
  // "—" flash until our own poll completes.
  const { clusterOptions } = useOutletContext<LayoutContext>()
  const seed: Record<string, ClusterInfo> = {}
  for (const c of clusterOptions ?? []) seed[c.name] = c
  const [clusters, setClusters] = useState<RegisteredCluster[]>([])
  const [dbClusters, setDbClusters] = useState<Record<string, ClusterInfo>>(seed)
  const [dbLoaded, setDbLoaded] = useState(Object.keys(seed).length > 0)

  const [step, setStep] = useState<1 | 2>(1)
  const [clusterName, setClusterName] = useState('')
  const [edgeNamespace, setEdgeNamespace] = useState('trivy-system')
  const [edgeContext, setEdgeContext] = useState('')

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const fetchClusters = useCallback(async () => {
    // Fetch both endpoints in parallel; /api/v1/hub/clusters can take ~1.5s
    // when the server's Kubernetes client is hitting a remote API server
    // (e.g. local dev with an EKS kubeconfig), and waiting for it before
    // refreshing dbClusters caused a visible Awaiting flash.
    const [regRes, dbRes] = await Promise.allSettled([
      getRegisteredClusters(),
      getClusters(),
    ])

    if (regRes.status === 'fulfilled') {
      setClusters(Array.isArray(regRes.value) ? regRes.value : [])
    } else {
      setClusters([])
    }

    if (dbRes.status === 'fulfilled') {
      const map: Record<string, ClusterInfo> = {}
      for (const c of dbRes.value.items ?? []) map[c.name] = c
      setDbClusters(map)
      setDbLoaded(true)
    }
    // On failure keep the previous dbClusters snapshot so one flaky poll
    // doesn't flip every Synced row back to Awaiting.
  }, [])

  useEffect(() => {
    fetchClusters()
    // Poll every 10s so newly-synced clusters flip to "Synced" without manual reload
    const id = setInterval(fetchClusters, 10000)
    return () => clearInterval(id)
  }, [fetchClusters])

  if (!permissions?.can_admin) {
    return (
      <div className={styles.container}>
        <AdminSubNav />
        <div className={styles.emptyState}>Access denied. Admin permissions required.</div>
      </div>
    )
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      await deleteRegisteredCluster(deleteTarget)
      setDeleteTarget(null)
      fetchClusters()
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className={styles.container}>
      <AdminSubNav />

      {/* Registered clusters */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Registered Clusters ({clusters.length})</h3>
        </div>
        <div style={{ padding: 16 }}>
          {clusters.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              No clusters registered yet.
            </div>
          ) : (
            <table className={styles.logTable}>
              <thead>
                <tr>
                  <th>Name</th><th>API Server</th><th>TLS</th><th>Reports</th>
                  <th>Reachable</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {clusters.map((c) => {
                  const info = dbClusters[c.name]
                  const synced = !!info
                    && (info.vuln_report_count > 0 || info.sbom_report_count > 0)
                  const isLocal = c.in_cluster === true
                  return (
                    <tr key={c.name}>
                      <td>
                        {c.name}
                        {isLocal && (
                          <span style={{
                            marginLeft: 8,
                            fontSize: 10,
                            fontWeight: 600,
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: 'var(--bg-tertiary)',
                            color: 'var(--accent)',
                            verticalAlign: 'middle',
                          }}>
                            LOCAL
                          </span>
                        )}
                      </td>
                      <td className={styles.mono}>{c.server}</td>
                      <td>{c.insecure ? 'insecure' : 'verified'}</td>
                      <td className={styles.mono}>
                        {info ? (
                          <span style={{ color: 'var(--text-secondary)' }}>
                            {info.vuln_report_count} vuln
                            {' / '}
                            {info.sbom_report_count} sbom
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td title={c.reachability_message || undefined}>
                        {c.reachable === true ? (
                          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                            Reachable
                          </span>
                        ) : c.reachable === false ? (
                          <span style={{ color: 'var(--text-error, #ef4444)', fontWeight: 600 }}>
                            Unreachable
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td>
                        {!dbLoaded
                          ? '—'
                          : synced
                            ? 'Synced'
                            : 'Awaiting first sync'}
                      </td>
                      <td>
                        <button
                          className={styles.toolbarBtnDanger}
                          disabled={isLocal}
                          title={isLocal
                            ? 'The Hub\'s own cluster is auto-managed and cannot be deleted'
                            : undefined}
                          style={isLocal ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                          onClick={() => !isLocal && setDeleteTarget(c.name)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 2-step wizard */}
      <div className={styles.section}>
        <div className={styles.sectionHeader} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h3 className={styles.sectionTitle} style={{ margin: 0 }}>Register a new cluster</h3>
          <div style={{ flex: 1 }} />
          <div style={{
            fontSize: 11, color: 'var(--text-secondary)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ fontWeight: step === 1 ? 700 : 400, color: step === 1 ? 'var(--accent)' : undefined }}>
              Step 1 · Bootstrap
            </span>
            <span>›</span>
            <span style={{ fontWeight: step === 2 ? 700 : 400, color: step === 2 ? 'var(--accent)' : undefined }}>
              Step 2 · Register
            </span>
          </div>
        </div>
        {step === 1 ? (
          <Step1Bootstrap
            clusterName={clusterName}
            edgeNamespace={edgeNamespace}
            edgeContext={edgeContext}
            setClusterName={setClusterName}
            setEdgeNamespace={setEdgeNamespace}
            setEdgeContext={setEdgeContext}
            onNext={() => setStep(2)}
          />
        ) : (
          <Step2Register
            clusterName={clusterName}
            edgeNamespace={edgeNamespace}
            onBack={() => setStep(1)}
            onSuccess={() => {
              fetchClusters()
              setStep(1)
            }}
          />
        )}
      </div>

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className={styles.overlay} onClick={() => !deleteBusy && setDeleteTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Delete cluster</h3>
            <p className={styles.modalText}>
              Delete cluster <strong>{deleteTarget}</strong>?
              <br />
              This removes the Hub Secret <em>and</em> deletes all reports for
              this cluster from the Dashboard / Vulnerabilities / SBOM views.
              The read-only ServiceAccount on the Edge cluster is unchanged.
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.cancelBtn}
                disabled={deleteBusy}
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.dangerBtn}
                disabled={deleteBusy}
                onClick={confirmDelete}
              >
                {deleteBusy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
