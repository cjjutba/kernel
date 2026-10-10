import { useEffect } from 'react'
import type { AppSettings, DeepPartial, Room, RoomSettings, RoomSettingsPatch } from '@shared/types'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'

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

/**
 * The room the repo pages (Scripts, Files, Skills, Agents) read. They belong to a repo, and Settings has no room in its route,
 * so it is the room opened last (the store's own "last room" key), or the first one.
 */
export function useProjectRoom(): Room | undefined {
  return useStore((s) => {
    const rooms = s.rooms.filter((r) => !r.archived)
    let last: string | null = null
    try { last = localStorage.getItem('kernel.lastRoom') } catch { /* blocked */ }
    return rooms.find((r) => r.id === last) ?? rooms[0]
  })
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

/** Apply a room patch the way main writes it: a `null` removes the key. */
export function applyRoomPatch(rs: RoomSettings, patch: RoomSettingsPatch): RoomSettings {
  const out: Record<string, Record<string, unknown>> = { scripts: { ...rs.scripts }, files: { ...rs.files }, workspace: { ...rs.workspace }, disabled: { ...(rs.disabled ?? { skills: [], mcp: [] }) }, linear: { ...rs.linear } }
  for (const [group, values] of Object.entries(patch)) for (const [k, v] of Object.entries(values ?? {})) { if (v === null) delete out[group][k]; else out[group][k] = v }
  if (!Object.keys(out.linear).length) delete (out as Record<string, unknown>).linear
  return out as unknown as RoomSettings
}

/** Save a change to a room's .kernel settings (the shared file when `shared`, else the personal one). Rolls back and says so on a failure. */
export async function patchRoomSettings(roomId: string, patch: RoomSettingsPatch, shared = false) {
  const before = getState().roomSettings[roomId]
  if (before) actions.settings.setRoom(roomId, applyRoomPatch(before, patch))
  try {
    actions.settings.setRoom(roomId, await call('settings.setRoom', { roomId, patch, shared }))
  } catch (e) {
    if (before) actions.settings.setRoom(roomId, before)
    actions.ui.toast({ title: 'Could not save the setting', sub: (e as Error).message })
  }
}
