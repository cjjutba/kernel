import { useSyncExternalStore } from 'react'

// The models you starred in the picker. They stay on this Mac, like a picker's remembered tab, so they live in localStorage.

const KEY = 'kernel.favoriteModels'
const listeners = new Set<() => void>()
let cached: string[] | null = null

function read(): string[] {
  if (cached) return cached
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    cached = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { cached = [] }
  return cached
}

/** The ids of the starred models, in the order they were starred. */
export const useFavoriteModels = (): readonly string[] => useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn) }, read)

export function toggleFavoriteModel(id: string) {
  const now = read()
  cached = now.includes(id) ? now.filter((x) => x !== id) : [...now, id]
  try { localStorage.setItem(KEY, JSON.stringify(cached)) } catch { /* private window: the star holds until the app closes */ }
  listeners.forEach((fn) => fn())
}
