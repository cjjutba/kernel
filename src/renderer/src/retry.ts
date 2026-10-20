import { useEffect, useRef } from 'react'
import { actions } from './store'

const handlers = new Map<string, () => unknown>()

/** Presses the Try again of a toast: the screen that registered `key` reads its list again. A screen that is gone leaves it doing nothing. */
export function runRetry(key: string) {
  void handlers.get(key)?.()
}

/** A screen registers how it reads its list again, so a toast's Try again can press it. The newest registration for a key wins. */
export function useRetryKey(key: string, retry: () => unknown) {
  const latest = useRef(retry)
  latest.current = retry
  useEffect(() => {
    const run = () => latest.current()
    handlers.set(key, run)
    return () => { if (handlers.get(key) === run) handlers.delete(key) }
  }, [key])
}

/** A list that failed to load: the empty state stays calm and this toast carries the error and its way to try again (DESIGN.md, State kinds). */
export function failToast(title: string, sub: string | undefined, retry: string) {
  return actions.ui.toast({ title, sub, glyph: 'error', action: { label: 'Try again', retry, primary: true } })
}
