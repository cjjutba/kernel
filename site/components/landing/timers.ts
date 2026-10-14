'use client'

import { useCallback, useEffect, useRef } from 'react'

/** setTimeout calls that all stop at once: on a reset, and when the component unmounts. */
export function useTimers() {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const clear = useCallback(() => {
    timers.current.forEach(clearTimeout)
    timers.current.clear()
  }, [])
  useEffect(() => clear, [clear])
  const later = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t)
      fn()
    }, ms)
    timers.current.add(t)
  }, [])
  return { later, clear }
}
