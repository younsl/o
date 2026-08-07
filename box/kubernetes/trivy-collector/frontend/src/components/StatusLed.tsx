import { useEffect, useRef } from 'react'
import styles from './StatusLed.module.css'
import type { WatcherInfo } from '../types'

interface StatusLedProps {
  status: WatcherInfo | null
  label: string
}

export default function StatusLed({ status, label }: StatusLedProps) {
  const ledRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (status?.running && status?.initial_sync_done && ledRef.current) {
      const el = ledRef.current
      el.classList.remove(styles.blink)
      void el.offsetWidth
      el.classList.add(styles.blink)
      const timer = setTimeout(() => el.classList.remove(styles.blink), 300)
      return () => clearTimeout(timer)
    }
  }, [status])

  const getClassName = () => {
    if (!status?.running) return `${styles.led} ${styles.off}`
    if (!status.initial_sync_done) return `${styles.led} ${styles.syncing}`
    return `${styles.led} ${styles.running}`
  }

  const getTitle = () => {
    if (!status?.running) return 'Watcher not running'
    if (!status.initial_sync_done) return 'Initial sync in progress...'
    return 'Watcher running'
  }

  return (
    <div className={styles.statusItem}>
      <span ref={ledRef} className={getClassName()} title={getTitle()} />
      <span className={styles.statusLabel}>{label}</span>
    </div>
  )
}
