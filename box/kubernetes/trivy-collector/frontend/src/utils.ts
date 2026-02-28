export function escapeHtml(str: string): string {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString()
}

export function formatSeverityBadge(count: number | undefined, level: string): string {
  if (!count || count === 0) return '<span class="severity-zero">0</span>'
  return `<span class="severity-badge severity-${level}">${count}</span>`
}

export function formatSeverityLabel(severity: string): string {
  const sev = (severity || '').toUpperCase()
  const labels: Record<string, string> = { CRITICAL: 'C', HIGH: 'H', MEDIUM: 'M', LOW: 'L', UNKNOWN: 'U' }
  const label = labels[sev] || '?'
  return `<span class="severity-badge severity-${sev.toLowerCase()}">${label}</span>`
}

export function escapeCsvField(field: unknown): string {
  if (field == null) return ''
  const str = String(field)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

export function formatDateForFilename(): string {
  return new Date().toISOString().slice(0, 10)
}

export function randomHash(): string {
  return Math.random().toString(36).substring(2, 8)
}

export function downloadBlob(blob: Blob, filename: string): void {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(link.href)
}

export function downloadCsv(content: string, filename: string): void {
  downloadBlob(new Blob(['\ufeff' + content], { type: 'text/csv;charset=utf-8;' }), filename)
}

export function downloadJson(data: unknown, filename: string): void {
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename)
}
