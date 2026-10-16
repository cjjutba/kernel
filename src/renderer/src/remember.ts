import { useSyncExternalStore } from 'react'
import { fixturePersists, isFixture } from './store'

/**
 * Choices the user makes that outlive the screen they made them on (DESIGN.md, Remembered choices): a tab, a filter, a width, a
 * picked script. This is the one place a screen or component reads and writes localStorage, and `test/remember.test.ts` fails
 * when one touches it directly. localStorage may be missing or blocked, in which case a choice lasts until the window reloads.
 * Fixture mode keeps choices in memory, since it must neither read nor write what a real launch saved, unless KERNEL_FIXTURE_PERSIST=1
 * asks for real storage (the fixture then runs on its own userData folder, so it is still not a real launch's).
 */
const memory = new Map<string, string>()
const listeners = new Set<() => void>()

/** What is stored under `key`, or null. Read through every time, so a value written elsewhere is never stale. */
export function readSaved(key: string): string | null {
  if (isFixture() && !fixturePersists()) return memory.get(key) ?? null
  try { return localStorage.getItem(key) } catch { return memory.get(key) ?? null }
}

/** Stores `value` under `key`, or removes it for null, and tells every `useRemembered` of it. */
export function writeSaved(key: string, value: string | null) {
  if (value === null) memory.delete(key)
  else memory.set(key, value)
  if (!isFixture() || fixturePersists()) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch { /* kept in memory */ }
  }
  for (const fn of [...listeners]) fn()
}

/** What is stored under `key` as JSON, through `parse`, which gets null for nothing or junk and returns a valid value. */
export function readSavedJson<T>(key: string, parse: (v: unknown) => T): T {
  let v: unknown = null
  try { v = JSON.parse(readSaved(key) ?? 'null') } catch { /* junk reads as nothing */ }
  return parse(v)
}

export const writeSavedJson = (key: string, value: unknown) => writeSaved(key, value === undefined ? null : JSON.stringify(value))

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * A remembered string choice: `parse` turns what is stored, or null, into a value the screen accepts, so a stored value from an
 * older build or another screen never reaches it. Every component that uses `key` sees a change at once.
 */
export function useRemembered<T extends string>(key: string, parse: (raw: string | null) => T): [T, (v: T) => void] {
  const raw = useSyncExternalStore(subscribe, () => readSaved(key))
  return [parse(raw), (v: T) => writeSaved(key, v)]
}

/** One of `values`, else `fallback`: the usual `parse` for `useRemembered`. */
export const oneOf = <T extends string>(values: readonly T[], fallback: T) => (raw: string | null): T => (values.includes(raw as T) ? (raw as T) : fallback)
