import { useSyncExternalStore } from 'react'
import { isFixture } from '../../../store'
import { limitBannerExpired } from './model'

/**
 * The near-limit and 80% banners the user closed, kept by `limitBannerKey` so a closed one stays closed in every workspace until
 * its window resets (KERNEL-595). Renderer only: localStorage keeps it across launches and may be missing or blocked, in which
 * case the banner comes back. Fixture mode keeps it in memory, since it must neither read nor write what a real launch saved.
 */
const KEY = 'kernel.limitBannerDismissed'
let keys: ReadonlySet<string> | undefined
const listeners = new Set<() => void>()

function read(): ReadonlySet<string> {
  if (keys) return keys
  let saved: unknown
  if (!isFixture()) try { saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { /* not restored */ }
  const now = Date.now()
  return (keys = new Set(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string' && !limitBannerExpired(k, now)) : []))
}

export function dismissLimitBanner(key: string) {
  const now = Date.now()
  keys = new Set([...read()].filter((k) => !limitBannerExpired(k, now)).concat(key))
  if (!isFixture()) try { localStorage.setItem(KEY, JSON.stringify([...keys])) } catch { /* not remembered */ }
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The keys of the limit banners closed so far. A new set after each close, so a component re-renders on it. */
export const useLimitDismissed = () => useSyncExternalStore(subscribe, read)
