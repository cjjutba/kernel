import { useEffect } from 'react'
import type { AppSettings, DeepPartial, RoomSettings, RoomSettingsPatch } from '@shared/types'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'
import { remoteOf } from './remote'

/** The app settings, read from the store. Null until the first load. */
export function useSettings(): AppSettings | null {
  return useStore((s) => s.settings)
}

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over) || base === null || typeof base !== 'object') return over as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over)) out[k] = merge((base as Record<string, unknown>)[k], v)
  return out as T
}

/**
 * Save a change. The screen updates at once and main's answer replaces it (main clamps numbers).
 * A failure puts the old settings back and says so, so a control never shows a value that was not saved.
 */
export async function patchSettings(patch: DeepPartial<AppSettings>) {
  const before = getState().settings
  if (!before) return
  actions.settings.set(merge(before, patch))
  try {
    actions.settings.set(await call('settings.set', { patch }))
  } catch (e) {
    actions.settings.set(before)
    actions.ui.toast({ title: 'Could not save the setting', sub: (e as Error).message })
  }
}

/** A room's settings from its .kernel files. Null until the first read. */
export function useRoomSettings(roomId?: string): RoomSettings | null {
  const rs = useStore((s) => (roomId ? s.roomSettings[roomId] ?? null : null))
  useEffect(() => {
    if (!roomId) return
    void call('settings.room', { roomId }).then((r) => actions.settings.setRoom(roomId, r)).catch(() => undefined)
  }, [roomId])
  return rs
}

/**
 * Apply a room patch the way main writes the personal file: a `null` or an empty string removes the key, and `sources` follows.
 * It reads the groups from the patch, so a new setting group needs no change here.
 */
export function applyRoomPatch(rs: RoomSettings, patch: RoomSettingsPatch): RoomSettings {
  const out: Record<string, unknown> = { ...rs }
  const sources = { ...rs.sources }
  for (const [group, values] of Object.entries(patch) as [string, Record<string, unknown> | undefined][]) {
    if (group === 'runScripts') {
      out.runScripts = applyRunScripts(rs.runScripts ?? [], sources, (values ?? {}) as Record<string, string | null>)
      continue
    }
    const next: Record<string, unknown> = { ...(rs as unknown as Record<string, Record<string, unknown> | undefined>)[group] }
    for (const [k, v] of Object.entries(values ?? {})) {
      const path = `${group}.${k}`
      if (v === null || v === '') {
        delete next[k]
        // The personal file stops setting it: an override falls back to settings.toml, and a personal value to the app default.
        if (sources[path] === 'override') sources[path] = 'shared'
        else if (sources[path] === 'local') delete sources[path]
      } else {
        next[k] = v
        sources[path] = sources[path] === 'shared' || sources[path] === 'override' ? 'override' : 'local'
      }
    }
    if (Object.keys(next).length || group in rs) out[group] = next
  }
  return { ...(out as unknown as RoomSettings), sources }
}

/**
 * The run scripts after a patch, by name. `run` stays first. Removing an override keeps the command on screen (settings.toml's
 * is not known here), and the saved settings replace it a moment later.
 */
export function applyRunScripts(list: RoomSettings['runScripts'], sources: RoomSettings['sources'], values: Record<string, string | null>): RoomSettings['runScripts'] {
  let next = [...list]
  for (const [key, v] of Object.entries(values)) {
    const name = key.toLowerCase() === 'run' ? 'run' : key
    const path = `runScripts.${name}`
    if (v === null || v === '') {
      if (sources[path] === 'override') sources[path] = 'shared'
      else if (sources[path] !== 'shared') { next = next.filter((r) => r.name !== name); delete sources[path] }
    } else {
      next = next.some((r) => r.name === name) ? next.map((r) => (r.name === name ? { name, command: v } : r)) : [...next, { name, command: v }]
      sources[path] = sources[path] === 'shared' || sources[path] === 'override' ? 'override' : 'local'
    }
  }
  return [...next.filter((r) => r.name === 'run'), ...next.filter((r) => r.name !== 'run')]
}

/** Save a change to a room's personal settings, `.kernel/settings.local.toml`. Rolls back and says so on a failure. */
export async function patchRoomSettings(roomId: string, patch: RoomSettingsPatch) {
  const before = getState().roomSettings[roomId]
  if (before) actions.settings.setRoom(roomId, applyRoomPatch(before, patch))
  try {
    actions.settings.setRoom(roomId, await call('settings.setRoom', { roomId, patch }))
  } catch (e) {
    if (before) actions.settings.setRoom(roomId, before)
    actions.ui.toast({ title: 'Could not save the setting', sub: (e as Error).message })
  }
}

/** The remote this room uses, from its own settings and the app's. */
export function useRemote(roomId?: string): string {
  const rs = useRoomSettings(roomId)
  return remoteOf(rs, useSettings())
}
