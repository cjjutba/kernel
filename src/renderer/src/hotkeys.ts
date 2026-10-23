import { comboKeys, comboLabel, comboSpoken, digitOf, hotkeyDef, matches, resolveHotkeys, type HotkeyId, type HotkeyOverrides, type Hotkeys, type KeyLike } from '@shared/hotkeys'
import { getState, useStore } from './store'

let from: HotkeyOverrides | undefined | null = null
let resolved: Hotkeys = resolveHotkeys(undefined)

/** The combos in force, from Settings, Shortcuts. Read at key time, so a change applies at once. */
export function hotkeys(): Hotkeys {
  const o = getState().settings?.hotkeys
  if (o !== from) { from = o; resolved = resolveHotkeys(o) }
  return resolved
}

/** Whether the event presses the shortcut as the user bound it. */
export const pressed = (e: KeyLike, id: HotkeyId): boolean => matches(e, hotkeys()[id], hotkeyDef(id).range)

/** The number a range shortcut (the nth chat, workspace or model) was pressed with, else null. */
export const pressedDigit = (e: KeyLike, id: HotkeyId): number | null => digitOf(e, hotkeys()[id], hotkeyDef(id).range)

/** Every combo in force, re-rendering when Settings changes one. */
export function useHotkeys(): Hotkeys {
  const o = useStore((s) => s.settings?.hotkeys)
  return o === from ? resolved : resolveHotkeys(o)
}

/** A shortcut's tooltip text, `⌘⇧P`, as the user bound it. */
export function useHotkeyLabel(id: HotkeyId): string {
  return comboLabel(useHotkeys()[id], hotkeyDef(id).range)
}

export { comboKeys, comboLabel, comboSpoken }
