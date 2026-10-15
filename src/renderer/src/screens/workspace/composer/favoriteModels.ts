import { useMemo } from 'react'
import { readSavedJson, useRemembered, writeSavedJson } from '../../../remember'

// The models you starred in the picker. They stay on this Mac, as a remembered choice (DESIGN.md, Remembered choices).

const KEY = 'kernel.favoriteModels'
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** The ids of the starred models, in the order they were starred. */
export function useFavoriteModels(): readonly string[] {
  const [raw] = useRemembered(KEY, (r) => r ?? '')
  return useMemo(() => { try { return ids(JSON.parse(raw || 'null')) } catch { return [] } }, [raw])
}

export function toggleFavoriteModel(id: string) {
  const now = readSavedJson(KEY, ids)
  writeSavedJson(KEY, now.includes(id) ? now.filter((x) => x !== id) : [...now, id])
}
