import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import {
  createAlert,
  deleteAlert,
  getRegisteredClusters,
  listAlerts,
  previewAlert,
  testAlertDraft,
  updateAlert,
  type AlertListResponse,
  type RegisteredCluster,
} from '../api'
import type {
  AlertMatchers,
  AlertPreviewResult,
  AlertRule,
  AlertRuleInput,
} from '../types'
import AdminSubNav from '../components/AdminSubNav'
import { formatDate } from '../utils'
import styles from './AlertsPage.module.css'

interface FormState {
  name: string
  description: string
  enabled: boolean
  packageName: string
  versionExpr: string
  clusters: string[]
  namespace: string
  receiverName: string
  webhookUrl: string
  channel: string
  cooldownSecs: string
}

const emptyForm = (): FormState => ({
  name: '',
  description: '',
  enabled: true,
  packageName: '',
  versionExpr: '',
  clusters: [],
  namespace: '',
  receiverName: 'slack-default',
  webhookUrl: '',
  channel: '',
  cooldownSecs: '3600',
})

const fromRule = (rule: AlertRule): FormState => {
  const slack = rule.receivers[0]?.slack
  return {
    name: rule.name,
    description: rule.description ?? '',
    enabled: rule.enabled,
    packageName: rule.matchers.package_name ?? '',
    versionExpr: rule.matchers.version_expr ?? '',
    clusters: rule.matchers.clusters ?? [],
    namespace: rule.matchers.namespace ?? '',
    receiverName: rule.receivers[0]?.name ?? 'slack-default',
    webhookUrl: slack?.webhook_url ?? '',
    channel: slack?.channel ?? '',
    cooldownSecs: rule.cooldown_secs?.toString() ?? '',
  }
}

const trimmed = (s: string) => (s.trim() === '' ? null : s.trim())

const toMatchers = (form: FormState): AlertMatchers => ({
  package_name: trimmed(form.packageName),
  version_expr: trimmed(form.versionExpr),
  clusters: form.clusters,
  namespace: trimmed(form.namespace),
})

const toInput = (form: FormState): AlertRuleInput => ({
  name: form.name.trim(),
  description: form.description,
  enabled: form.enabled,
  matchers: toMatchers(form),
  receivers: [
    {
      name: form.receiverName.trim() || 'slack-default',
      slack: {
        webhook_url: form.webhookUrl.trim(),
        channel: trimmed(form.channel),
        title: null,
      },
    },
  ],
  cooldown_secs:
    form.cooldownSecs.trim() === '' ? null : Number(form.cooldownSecs),
})

export default function AlertsPage() {
  const { permissions } = useAuth()
  const canManage = !!permissions?.can_manage_alerts
  const [meta, setMeta] = useState<AlertListResponse | null>(null)
  const [rules, setRules] = useState<AlertRule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<AlertRule | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [clusterOptions, setClusterOptions] = useState<RegisteredCluster[]>([])

  useEffect(() => {
    let cancelled = false
    getRegisteredClusters()
      .then((cs) => {
        if (!cancelled) setClusterOptions(cs)
      })
      .catch(() => {
        if (!cancelled) setClusterOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listAlerts()
      setMeta(res)
      setRules(res.items)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const startCreate = () => {
    setEditing(null)
    setForm(emptyForm())
  }
  const startEdit = (rule: AlertRule) => {
    setEditing(rule)
    setForm(fromRule(rule))
  }
  const cancel = () => {
    setEditing(null)
    setForm(null)
    setError(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form) return
    setError(null)
    const input = toInput(form)
    if (!input.name) return setError('Name is required')
    if (!input.matchers.package_name)
      return setError('Package name is required')
    if (input.matchers.clusters.length === 0)
      return setError('At least one cluster must be selected')
    const webhookUrl = input.receivers[0]?.slack?.webhook_url ?? ''
    if (!webhookUrl) return setError('Slack webhook URL is required')
    if (!webhookUrl.startsWith('https://hooks.slack.com/'))
      return setError(
        'Webhook URL must start with https://hooks.slack.com/ — only the canonical Slack endpoint is allowed.',
      )
    try {
      if (editing) {
        await updateAlert(editing.name, input)
      } else {
        await createAlert(input)
      }
      cancel()
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const remove = async (rule: AlertRule) => {
    if (!confirm(`Delete alert rule "${rule.name}"?`)) return
    try {
      await deleteAlert(rule.name)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const showForm = form !== null

  return (
    <div className={styles.container}>
      <AdminSubNav />

      <div className={styles.header}>
        <div>
          <h2 className={styles.headerTitle}>Alert Rules</h2>
          {meta && (
            <div className={styles.headerMeta}>
              ConfigMap <code>{meta.configmap}</code> in namespace <code>{meta.namespace}</code> · {meta.total} rule(s)
            </div>
          )}
        </div>
        {canManage && !showForm && (
          <div className={styles.headerActions}>
            <button className="btn-secondary" onClick={startCreate}>
              New rule
            </button>
          </div>
        )}
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {form && (
        <RuleForm
          form={form}
          setForm={setForm}
          onCancel={cancel}
          onSubmit={submit}
          editing={!!editing}
          canManage={canManage}
          clusterOptions={clusterOptions}
        />
      )}

      {loading ? (
        <div className={styles.loadingState}>Loading…</div>
      ) : rules.length === 0 ? (
        showForm ? null : (
          <div className={styles.empty}>No alert rules configured.</div>
        )
      ) : (
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Package</th>
                <th>Version</th>
                <th>Receivers</th>
                <th>Updated</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.name}>
                  <td>
                    <div className={styles.ruleName}>{r.name}</div>
                    {r.description && <div className={styles.ruleDescription}>{r.description}</div>}
                  </td>
                  <td>{r.matchers.package_name ?? '—'}</td>
                  <td className={styles.codeCell}>
                    {r.matchers.version_expr ? <code>{r.matchers.version_expr}</code> : '—'}
                  </td>
                  <td>
                    {r.receivers.map((rc) => (
                      <div key={rc.name} className={styles.receiverLine}>
                        {rc.name}{rc.slack?.channel ? ` → ${rc.slack.channel}` : ''}
                      </div>
                    ))}
                  </td>
                  <td>{formatDate(r.updated_at ?? r.created_at)}</td>
                  <td>
                    <span className={r.enabled ? styles.statusOn : styles.statusOff}>
                      {r.enabled ? 'on' : 'off'}
                    </span>
                  </td>
                  <td>
                    {canManage ? (
                      <div className={styles.actionsCell}>
                        <button className="btn-secondary btn-sm" onClick={() => startEdit(r)}>Edit</button>
                        <button className="btn-secondary btn-sm" onClick={() => remove(r)}>Delete</button>
                      </div>
                    ) : (
                      <span className={styles.readonlyTag}>read-only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

interface RuleFormProps {
  form: FormState
  setForm: (f: FormState) => void
  onCancel: () => void
  onSubmit: (e: React.FormEvent) => void
  editing: boolean
  canManage: boolean
  clusterOptions: RegisteredCluster[]
}

function RuleForm({
  form,
  setForm,
  onCancel,
  onSubmit,
  editing,
  canManage,
  clusterOptions,
}: RuleFormProps) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm({ ...form, [k]: v })

  const [testing, setTesting] = useState(false)
  const [testStatus, setTestStatus] = useState<
    | { kind: 'ok' | 'partial' | 'error'; message: string }
    | null
  >(null)

  // Mirror the submit-time required-field check so the Test button can't
  // dispatch a half-filled draft. Reasons surfaced via tooltip.
  const missingRequired: string[] = []
  if (!form.name.trim()) missingRequired.push('Name')
  if (!form.packageName.trim()) missingRequired.push('Package name')
  if (form.clusters.length === 0) missingRequired.push('Clusters')
  if (!form.webhookUrl.trim()) missingRequired.push('Webhook URL')
  const canTest = canManage && !testing && missingRequired.length === 0
  const testDisabledReason =
    missingRequired.length > 0
      ? `Required to send a test: ${missingRequired.join(', ')}`
      : 'Send a test alert to the configured Slack receiver without saving'

  const handleTest = async () => {
    setTestStatus(null)
    setTesting(true)
    try {
      const input = toInput(form)
      const res = await testAlertDraft(input)
      const failed = res.results.filter((r) => !r.success)
      if (failed.length === 0) {
        setTestStatus({
          kind: 'ok',
          message: `Test alert delivered to ${res.succeeded}/${res.total} receiver(s).`,
        })
      } else if (res.succeeded > 0) {
        setTestStatus({
          kind: 'partial',
          message: `Delivered to ${res.succeeded}/${res.total}. Failed: ${failed
            .map((f) => `${f.receiver_name}${f.error ? ` (${f.error})` : ''}`)
            .join('; ')}`,
        })
      } else {
        setTestStatus({
          kind: 'error',
          message: `All ${res.total} receiver(s) failed: ${failed
            .map((f) => `${f.receiver_name}${f.error ? ` (${f.error})` : ''}`)
            .join('; ')}`,
        })
      }
    } catch (err) {
      setTestStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.formBadgeSbom}>
        SBOM component rule — fires when a matching package/version lands in a workload's SBOM
      </div>

      <div className={styles.formSectionTitle}>Identity</div>
      <div className={styles.grid}>
        <Field label="Name" required>
          <input
            className={styles.input}
            value={form.name}
            disabled={editing}
            onChange={(e) => set('name', e.target.value)}
            placeholder="deprecated-crypto"
            required
          />
        </Field>
        <Field label="Description">
          <input
            className={styles.input}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Detects use of deprecated component"
          />
        </Field>
        <Field label="Enabled">
          <div className={styles.toggleRow}>
            <button
              type="button"
              role="switch"
              aria-checked={form.enabled}
              className={`${styles.toggleSwitch} ${form.enabled ? styles.toggleSwitchOn : ''}`}
              onClick={() => set('enabled', !form.enabled)}
            />
            <span
              className={`${styles.toggleLabel} ${form.enabled ? styles.toggleLabelOn : styles.toggleLabelOff}`}
            >
              {form.enabled ? 'Active' : 'Paused'}
            </span>
          </div>
        </Field>
      </div>

      <div className={styles.formSectionTitle}>Matchers</div>
      <div className={styles.grid}>
        <Field label="Package name" required>
          <input
            className={styles.input}
            value={form.packageName}
            onChange={(e) => set('packageName', e.target.value)}
            placeholder="log4j-core"
            required
          />
        </Field>
        <Field label="Version expression" hint="<2.17.0  or  >=1.0.0,<2.0.0">
          <input
            className={styles.input}
            value={form.versionExpr}
            onChange={(e) => set('versionExpr', e.target.value)}
            placeholder="<1.0.0"
          />
        </Field>
        <Field
          label="Clusters"
          hint="Click to toggle. At least one cluster must be selected."
          required
          wide
        >
          <ClusterMultiSelect
            value={form.clusters}
            options={clusterOptions}
            onChange={(next) => setForm({ ...form, clusters: next })}
          />
        </Field>
        <Field label="Namespace (optional)">
          <input
            className={styles.input}
            value={form.namespace}
            onChange={(e) => set('namespace', e.target.value)}
            placeholder="default"
          />
        </Field>
        <Field label="Cooldown (seconds)" hint="Per-target re-fire interval">
          <input
            className={styles.input}
            value={form.cooldownSecs}
            onChange={(e) => set('cooldownSecs', e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="3600"
          />
        </Field>
      </div>

      <div className={styles.formSectionTitle}>Slack receiver</div>
      <div className={styles.grid}>
        <Field label="Receiver name">
          <input
            className={styles.input}
            value={form.receiverName}
            onChange={(e) => set('receiverName', e.target.value)}
            placeholder="sec-team"
          />
        </Field>
        <Field label="Webhook URL" required>
          <input
            className={styles.input}
            type="url"
            value={form.webhookUrl}
            onChange={(e) => set('webhookUrl', e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            required
          />
        </Field>
        <Field
          label="Channel override"
          hint="Sends to this channel instead of the webhook default. Leave blank to use the webhook's preset channel. Only legacy / custom-app webhooks honor this; standard incoming webhooks ignore it."
        >
          <input
            className={styles.input}
            value={form.channel}
            onChange={(e) => set('channel', e.target.value)}
            placeholder="#sec-alerts (optional)"
          />
        </Field>
      </div>

      <PreviewSection form={form} />

      {testStatus && (
        <div
          className={
            testStatus.kind === 'ok'
              ? styles.testBannerOk
              : testStatus.kind === 'partial'
                ? styles.testBannerPartial
                : styles.testBannerError
          }
        >
          {testStatus.message}
          <button
            type="button"
            className={styles.testBannerDismiss}
            onClick={() => setTestStatus(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div className={styles.formActions}>
        <button type="submit" className="btn-primary" disabled={!canManage}>
          {editing ? 'Save changes' : 'Create rule'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleTest}
          disabled={!canTest}
          title={testDisabledReason}
        >
          {testing ? 'Sending…' : 'Send test alert'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function hasNarrowingMatcher(form: FormState): boolean {
  return form.packageName.trim() !== '' || form.versionExpr.trim() !== ''
}

function PreviewSection({ form }: { form: FormState }) {
  const [result, setResult] = useState<AlertPreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const ready = hasNarrowingMatcher(form)
  const matchers = toMatchers(form)
  const matchersKey = JSON.stringify(matchers)

  useEffect(() => {
    if (!ready) {
      setResult(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    const handle = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const r = await previewAlert(matchers)
        if (!cancelled) setResult(r)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setResult(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchersKey, ready])

  return (
    <div className={styles.previewSection}>
      <div className={styles.previewHeader}>
        <span className={styles.previewTitle}>Preview · matches in current data</span>
        <span className={styles.previewMeta}>
          {!ready
            ? 'awaiting input'
            : loading
              ? 'evaluating…'
              : result
                ? `${result.total} match(es) across ${result.scanned_reports} scanned report(s)`
                : '—'}
        </span>
      </div>

      {!ready && (
        <div className={styles.previewEmpty}>
          Enter a package name or version expression to see which workloads would fire.
        </div>
      )}

      {ready && error && <div className={styles.previewError}>{error}</div>}

      {ready && !error && result && result.items.length === 0 && (
        <div className={styles.previewEmpty}>
          No current SBOM reports match these matchers. The rule will start firing once a matching
          report is received.
        </div>
      )}

      {ready && !error && result && result.items.length > 0 && (
        <>
          <table className={styles.previewTable}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Cluster</th>
                <th>Namespace</th>
                <th>Workload</th>
                <th>Package</th>
                <th>Version</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((m, i) => (
                <tr key={`${m.cluster}|${m.namespace}|${m.name}|${m.package}|${m.version}|${i}`}>
                  <td>
                    <span className={styles.firingBadge}>FIRING</span>
                  </td>
                  <td>{m.cluster}</td>
                  <td>{m.namespace}</td>
                  <td>{m.name}</td>
                  <td>{m.package}</td>
                  <td>{m.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.truncated && (
            <div className={styles.truncatedNotice}>
              Showing the first {result.items.length} of {result.total} matches.
            </div>
          )}
        </>
      )}
    </div>
  )
}

interface ClusterMultiSelectProps {
  value: string[]
  options: RegisteredCluster[]
  onChange: (v: string[]) => void
}

function ClusterMultiSelect({ value, options, onChange }: ClusterMultiSelectProps) {
  const [search, setSearch] = useState('')

  const known = new Set(options.map((c) => c.name))
  const orphaned = value.filter((n) => !known.has(n))
  const merged: { name: string; server: string | null }[] = [
    ...options.map((c) => ({ name: c.name, server: c.server })),
    ...orphaned.map((n) => ({ name: n, server: null })),
  ]

  if (merged.length === 0) {
    return (
      <div className={styles.clusterSelectEmpty}>
        No registered clusters yet — add one in <strong>Admin → Clusters</strong>.
      </div>
    )
  }

  const q = search.trim().toLowerCase()
  const visible = q
    ? merged.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.server ?? '').toLowerCase().includes(q),
      )
    : merged

  const visibleNames = visible.map((c) => c.name)
  const visibleSelectedCount = visibleNames.filter((n) => value.includes(n)).length
  const allVisibleSelected =
    visibleNames.length > 0 && visibleSelectedCount === visibleNames.length

  const toggle = (name: string) => {
    onChange(value.includes(name) ? value.filter((n) => n !== name) : [...value, name])
  }

  const selectAllVisible = () => {
    const next = new Set(value)
    visibleNames.forEach((n) => next.add(n))
    onChange(Array.from(next))
  }

  const clearVisible = () => {
    if (q) {
      onChange(value.filter((n) => !visibleNames.includes(n)))
    } else {
      onChange([])
    }
  }

  return (
    <div className={styles.clusterPicker}>
      <div className={styles.clusterPickerToolbar}>
        <input
          type="text"
          className={styles.clusterPickerSearch}
          placeholder="Search clusters…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          className={
            allVisibleSelected
              ? styles.clusterPickerToolbarBtnDanger
              : styles.clusterPickerToolbarBtn
          }
          onClick={allVisibleSelected ? clearVisible : selectAllVisible}
          disabled={visible.length === 0}
        >
          {allVisibleSelected ? 'Clear' : 'Select all'}
        </button>
      </div>

      <div className={styles.clusterPickerList}>
        {visible.length === 0 ? (
          <div className={styles.clusterPickerNoResults}>No clusters match "{search}"</div>
        ) : (
          visible.map((c) => {
            const checked = value.includes(c.name)
            return (
              <label
                key={c.name}
                className={
                  checked ? styles.clusterPickerRowSelected : styles.clusterPickerRow
                }
              >
                <input
                  type="checkbox"
                  className={styles.clusterPickerCheckbox}
                  checked={checked}
                  onChange={() => toggle(c.name)}
                />
                <div className={styles.clusterPickerInfo}>
                  <span className={styles.clusterPickerName}>
                    {c.name}
                    {c.server === null && (
                      <span className={styles.clusterPickerOrphanTag}>unregistered</span>
                    )}
                  </span>
                  {c.server && <span className={styles.clusterPickerServer}>{c.server}</span>}
                </div>
              </label>
            )
          })
        )}
      </div>

      <div className={styles.clusterPickerFooter}>
        <span>
          {value.length} of {merged.length} selected
        </span>
        <span>{value.length === 0 ? 'matching all clusters' : null}</span>
      </div>
    </div>
  )
}

function Field({
  label,
  required,
  hint,
  wide,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <label className={wide ? styles.fieldFull : styles.field}>
      <span className={styles.fieldLabel}>
        {label}
        {required && <span className={styles.fieldRequired}>*</span>}
      </span>
      {children}
      {hint && <span className={styles.fieldHint}>{hint}</span>}
    </label>
  )
}
