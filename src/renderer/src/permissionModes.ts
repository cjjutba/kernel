import { useEffect, useState } from 'react'
import { PROVIDERS, type ModeAvailability, type PermissionMode, type Provider } from '@shared/types'
import { call, cleanError } from './api'
import { bypassConfirmed } from './bypassConfirm'
import { patchSettings } from './screens/settings/useSettings'
import { actions, getState } from './store'

/** What each mode is called and does, as Settings, Permissions and the onboarding step say it (KERNEL-435). */
export const MODE_INFO: Record<PermissionMode, { label: string; desc: string; note?: string }> = {
  default: { label: 'Manual', desc: 'Asks before every edit and command.' },
  acceptEdits: { label: 'Accept edits', desc: 'Edits files without asking. Commands still ask unless a rule allows them.' },
  auto: { label: 'Auto', desc: 'A classifier approves routine work and asks you about anything else. Commands on your Always ask list still come to you.' },
  bypassPermissions: {
    label: 'Bypass permissions', desc: 'Skips every prompt, including your Always ask list.',
    note: 'It still stops for Never allow, pushes to protected branches, network off, questions and plan approval.'
  }
}

export type ModeAvailabilities = Record<Provider, ModeAvailability>

/**
 * Which modes each provider can run now, from main. Null until the first answer and after a failed one, and a page reads null as
 * every mode being available, since main still holds a chat in the safer mode.
 */
export function useModeAvailability(): ModeAvailabilities | null {
  const [availability, setAvailability] = useState<ModeAvailabilities | null>(null)
  useEffect(() => {
    let live = true
    void call('permissions.availability', undefined).then((a) => { if (live) setAvailability(a) }).catch(() => undefined)
    return () => { live = false }
  }, [])
  return availability
}

/**
 * The lines under a mode that some provider can't run, one for each that can't. A provider's line names it and says what its chats
 * use instead. Main's `reason` replaces the first sentence when it speaks for this mode alone: it joins the Auto and Bypass reasons into
 * one string, and Codex's Auto has a line of its own (SettingsPermissions.png). `dim` is a mode no provider can run.
 */
export function unavailable(mode: PermissionMode, availability: ModeAvailabilities | null): { lines: string[]; dim: boolean } {
  const key = mode === 'auto' ? 'auto' : mode === 'bypassPermissions' ? 'bypass' : null
  if (!availability || !key) return { lines: [], dim: false }
  const other = key === 'auto' ? 'bypass' : 'auto'
  const off = PROVIDERS.filter((p) => !availability[p.id][key])
  const lines = off.map((p) => {
    if (key === 'auto' && p.id === 'codex') return 'Auto isn’t available for Codex agents yet. They use Accept edits instead.'
    const why = availability[p.id][other] ? availability[p.id].reason : undefined
    return why ? `${why} ${p.label} agents use Accept edits instead.` : `${MODE_INFO[mode].label} isn’t available for ${p.label} agents. They use Accept edits instead.`
  })
  return { lines, dim: off.length === PROVIDERS.length }
}

/** Save the app's permission mode. True when it was saved: `patchSettings` has already said so when it wasn't. */
export async function saveAppMode(mode: PermissionMode): Promise<boolean> {
  await patchSettings({ permissions: { mode } })
  return getState().settings?.permissions.mode === mode
}

/** Save a room's mode override, or drop it with no mode (Use app default). True when it was saved. */
export async function saveRoomMode(roomId: string, mode?: PermissionMode): Promise<boolean> {
  try {
    actions.rooms.upsert(await call('rooms.update', { roomId, patch: { permissionMode: mode } }))
    return true
  } catch (e) {
    actions.ui.toast({ title: 'Could not save the mode', sub: cleanError(e) })
    return false
  }
}

/** Set one chat's own mode and take it out of plan mode, as the composer does. Nothing in Settings or the room changes. True when it was saved (KERNEL-456). */
export async function saveChatMode(chatId: string, mode: PermissionMode): Promise<boolean> {
  try {
    actions.chats.upsert(await call('chats.configure', { chatId, mode, plan: false }))
    return true
  } catch (e) {
    actions.ui.toast({ title: 'Could not save the mode', sub: cleanError(e) })
    return false
  }
}

/** Pick a mode for the app, or for `roomId`. Bypass permissions opens ConfirmBypass first the one time the user hasn't seen it. */
export async function pickMode(mode: PermissionMode | undefined, roomId?: string): Promise<void> {
  if (mode === 'bypassPermissions' && !bypassConfirmed()) return actions.ui.openModal({ name: 'confirm', kind: 'bypass', roomId })
  if (roomId) await saveRoomMode(roomId, mode)
  else if (mode) await saveAppMode(mode)
}
