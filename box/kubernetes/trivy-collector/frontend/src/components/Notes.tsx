import { useState, useCallback } from 'react'
import { updateNotes } from '../api'
import { escapeHtml, formatDate } from '../utils'
import type { ReportMeta, ReportType } from '../types'
import styles from './Notes.module.css'

interface NotesProps {
  meta: ReportMeta
  reportType: ReportType
  onSaved: (notes: string) => void
}

export default function Notes({ meta, reportType, onSaved }: NotesProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meta.notes || '')
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const ok = await updateNotes(meta.cluster, reportType, meta.namespace, meta.name, draft)
      if (ok) {
        onSaved(draft)
        setEditing(false)
      }
    } catch {
      // error handled silently
    } finally {
      setSaving(false)
    }
  }, [draft, meta, reportType, onSaved])

  const handleCancel = () => {
    setDraft(meta.notes || '')
    setEditing(false)
  }

  return (
    <>
      <div className="section-bar">
        <h3 className="graph-title">Notes</h3>
        <div className={styles.actions}>
          {editing ? (
            <>
              <button className="btn-secondary btn-sm" onClick={handleCancel}>
                <i className="fa-solid fa-xmark" /> Cancel
              </button>
              <button className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
                <i className={`fa-solid ${saving ? 'fa-spinner fa-spin' : 'fa-save'}`} />
                {saving ? ' Saving...' : ' Save'}
              </button>
            </>
          ) : (
            <button className="btn-secondary btn-sm" onClick={() => { setDraft(meta.notes || ''); setEditing(true) }}>
              <i className="fa-solid fa-pen" /> Edit
            </button>
          )}
        </div>
      </div>
      <div className={styles.content}>
        {editing ? (
          <textarea
            className={styles.textarea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add notes about this report..."
            autoFocus
          />
        ) : (
          <div>
            {meta.notes?.trim() ? (
              <div className={styles.text} dangerouslySetInnerHTML={{ __html: escapeHtml(meta.notes).replace(/\n/g, '<br>') }} />
            ) : (
              <div className={styles.empty}>No notes added</div>
            )}
          </div>
        )}
        {(meta.notes_created_at || meta.notes_updated_at) && (
          <div className={styles.footer}>
            <div className={styles.timestampsInline}>
              {meta.notes_created_at && <span>Created: {formatDate(meta.notes_created_at)}</span>}
              {meta.notes_updated_at && meta.notes_updated_at !== meta.notes_created_at && (
                <span>Updated: {formatDate(meta.notes_updated_at)}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
