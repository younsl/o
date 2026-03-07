import { useEffect, useRef, useCallback } from 'react'
import styles from './HelpTooltip.module.css'

interface HelpTooltipProps {
  title: string
  content: string
  anchorRect: DOMRect
  onClose: () => void
}

export default function HelpTooltip({ title, content, anchorRect, onClose }: HelpTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = tooltipRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = anchorRect.left + anchorRect.width / 2 - rect.width / 2
    let top = anchorRect.bottom + 8
    if (left < 10) left = 10
    if (left + rect.width > window.innerWidth - 10) left = window.innerWidth - rect.width - 10
    if (top + rect.height > window.innerHeight - 10) top = anchorRect.top - rect.height - 8
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [anchorRect])

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-help-btn]')) {
      onClose()
    }
  }, [onClose])

  useEffect(() => {
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [handleClickOutside])

  return (
    <div ref={tooltipRef} className={styles.tooltip}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <button className={styles.close} onClick={onClose}>&times;</button>
      </div>
      <div className={styles.body} dangerouslySetInnerHTML={{ __html: content }} />
    </div>
  )
}
