import { useEffect, useRef, useState, useCallback } from 'react'

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled = true,
): { data: T | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(() => {
    fetcher()
      .then((result) => {
        if (mountedRef.current) setData(result)
      })
      .catch(() => {})
  }, [fetcher])

  useEffect(() => {
    mountedRef.current = true
    refresh()

    if (!enabled) return
    const id = setInterval(refresh, intervalMs)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [refresh, intervalMs, enabled])

  return { data, refresh }
}
