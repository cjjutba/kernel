/**
 * The keys Kernel listens for, which Settings, Shortcuts lets the user rebind (configurable-hotkeys). One list for the page, the
 * renderer's key handlers, main's window keys and the keys a preview hands back to Kernel.
 *
 * A combo is a string of modifiers and a physical key code, `ctrl+meta+alt+shift+Code` in that order: `meta+KeyK`,
 * `meta+shift+Slash`. A range shortcut (the nth chat, workspace or model) holds `Digit#` for its number key, and answers
 * every digit in its range. settings.json keeps only the combos the user changed (`hotkeys`), so a default that changes later
 * still reaches everyone who never set it.
 */

export type HotkeyGroup = 'Workspaces' | 'Agents' | 'App'

export interface HotkeyDef {
  id: string
  label: string
  group: HotkeyGroup
  combo: string
  /** A range shortcut: its `Digit#` stands for 1 to `range`. */
  range?: number
  /** Also handed back to Kernel when it is typed in a shared HTML preview. */
  forward?: boolean
}

export const HOTKEYS = [
  { id: 'newChat', label: 'New chat', group: 'Workspaces', combo: 'meta+KeyN', forward: true },
  { id: 'newTab', label: 'New tab', group: 'Workspaces', combo: 'meta+KeyT', forward: true },
  { id: 'closeTab', label: 'Close tab', group: 'Workspaces', combo: 'meta+KeyW', forward: true },
  { id: 'terminalTab', label: 'Big terminal tab', group: 'Workspaces', combo: 'meta+shift+KeyT', forward: true },
  { id: 'createPr', label: 'Create PR or mark ready', group: 'Workspaces', combo: 'meta+shift+KeyP', forward: true },
  { id: 'mergePr', label: 'Merge PR', group: 'Workspaces', combo: 'meta+shift+KeyM', forward: true },
  { id: 'fixPr', label: 'Fix conflicts, checks or review', group: 'Workspaces', combo: 'meta+shift+KeyF', forward: true },
  { id: 'archivePr', label: 'Archive merged or closed', group: 'Workspaces', combo: 'meta+shift+KeyA', forward: true },
  { id: 'openDiff', label: 'Open diff', group: 'Workspaces', combo: 'meta+shift+KeyD' },
  { id: 'runScript', label: 'Run dev script', group: 'Workspaces', combo: 'meta+KeyR' },
  { id: 'openIn', label: 'Open in default app', group: 'Workspaces', combo: 'meta+KeyO' },
  { id: 'approve', label: 'Approve request', group: 'Agents', combo: 'meta+Enter' },
  { id: 'deny', label: 'Deny request', group: 'Agents', combo: 'meta+Backspace' },
  { id: 'planMode', label: 'Toggle plan mode', group: 'Agents', combo: 'shift+Tab' },
  { id: 'focusComposer', label: 'Focus composer', group: 'Agents', combo: 'meta+KeyL', forward: true },
  { id: 'openLead', label: 'Open Kernel chat', group: 'Agents', combo: 'meta+shift+KeyL', forward: true },
  { id: 'nthChat', label: 'Open the nth Kernel chat', group: 'Agents', combo: 'meta+Digit#', range: 9, forward: true },
  { id: 'nthWorkspace', label: 'Open the nth workspace of this chat', group: 'Agents', combo: 'ctrl+Digit#', range: 9 },
  { id: 'linkIssue', label: 'Link issue', group: 'Agents', combo: 'meta+KeyI' },
  { id: 'attach', label: 'Add attachment', group: 'Agents', combo: 'meta+KeyU' },
  { id: 'pickModel', label: 'Pick model 1 to 4', group: 'Agents', combo: 'ctrl+meta+Digit#', range: 4, forward: true },
  { id: 'cycleEffort', label: 'Cycle effort', group: 'Agents', combo: 'meta+shift+Slash', forward: true },
  { id: 'palette', label: 'Command palette', group: 'App', combo: 'meta+KeyK', forward: true },
  { id: 'settings', label: 'Settings', group: 'App', combo: 'meta+Comma', forward: true },
  { id: 'sidebar', label: 'Toggle sidebar', group: 'App', combo: 'meta+KeyB', forward: true },
  { id: 'rightPanel', label: 'Toggle right panel', group: 'App', combo: 'meta+alt+KeyB', forward: true },
  { id: 'rightPanelAlt', label: 'Toggle right panel, second key', group: 'App', combo: 'meta+shift+KeyB', forward: true },
  { id: 'bottomPanel', label: 'Toggle bottom panel', group: 'App', combo: 'meta+KeyJ' },
  { id: 'focusMode', label: 'Focus mode', group: 'App', combo: 'meta+Backslash', forward: true },
  { id: 'newChatAlt', label: 'New chat, second key', group: 'App', combo: 'meta+shift+KeyN', forward: true },
  { id: 'back', label: 'Back', group: 'App', combo: 'meta+BracketLeft', forward: true },
  { id: 'forward', label: 'Forward', group: 'App', combo: 'meta+BracketRight', forward: true },
  { id: 'toastAction', label: 'Press the newest toast’s button, like Undo', group: 'App', combo: 'meta+alt+KeyZ' }
] as const satisfies readonly HotkeyDef[]

export type HotkeyId = (typeof HOTKEYS)[number]['id']
/** Every shortcut's combo in force. */
export type Hotkeys = Record<HotkeyId, string>
/** What settings.json holds: the combos the user changed. A `null` in a patch puts one back to its default. */
export type HotkeyOverrides = Partial<Record<HotkeyId, string | null>>

/** Keys Kernel lists but doesn't let anyone change, since every dialog and menu shares them. */
export const FIXED_HOTKEYS: { label: string; group: HotkeyGroup; keys: string[] }[] = [
  { label: 'Dismiss the newest toast', group: 'App', keys: ['Esc'] }
]

const DEFS = new Map<string, HotkeyDef>(HOTKEYS.map((d) => [d.id, d]))
export const hotkeyDef = (id: HotkeyId): HotkeyDef => DEFS.get(id)!
export const DEFAULT_HOTKEYS = Object.fromEntries(HOTKEYS.map((d) => [d.id, d.combo])) as Hotkeys

const MODS = ['ctrl', 'meta', 'alt', 'shift'] as const
type Mod = (typeof MODS)[number]
export interface Combo { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; code: string }

export function parseCombo(s: string): Combo | null {
  const parts = s.split('+')
  const code = parts.pop()
  if (!code || !/^(Key[A-Z]|Digit[0-9#]|F([1-9]|1[0-2])|Arrow(Up|Down|Left|Right)|Enter|Backspace|Delete|Tab|Space|Escape|Comma|Period|Slash|Backslash|BracketLeft|BracketRight|Semicolon|Quote|Minus|Equal|Backquote)$/.test(code)) return null
  const c: Combo = { ctrl: false, meta: false, alt: false, shift: false, code }
  for (const p of parts) { if (!MODS.includes(p as Mod) || c[p as Mod]) return null; c[p as Mod] = true }
  return c
}

export const formatCombo = (c: Combo): string => [...MODS.filter((m) => c[m]), c.code].join('+')

/** A combo the user may bind: it needs ⌘, ⌃ or ⌥, except ⇧Tab and the function keys. Esc stays with dialogs. */
export function bindable(c: Combo): boolean {
  if (c.code === 'Escape') return false
  if (/^F\d+$/.test(c.code)) return true
  if (c.meta || c.ctrl || c.alt) return true
  return c.shift && c.code === 'Tab'
}

/** ⌘ and a key macOS and every text field own: copy, paste, undo, quit, hide and the rest. They can't be bound. */
const RESERVED = new Set(['meta+KeyC', 'meta+KeyV', 'meta+KeyX', 'meta+KeyA', 'meta+KeyZ', 'meta+shift+KeyZ', 'meta+KeyQ', 'meta+KeyH', 'meta+alt+KeyH', 'meta+KeyM', 'meta+Tab', 'meta+Space', 'ctrl+Space', 'meta+Backquote', 'meta+Digit0', 'meta+Equal', 'meta+Minus'])
export const reserved = (combo: string): boolean => RESERVED.has(combo)

/** Each shortcut's combo: the user's where it is valid, else the default. */
export function resolveHotkeys(overrides: HotkeyOverrides | undefined | null): Hotkeys {
  const out = { ...DEFAULT_HOTKEYS }
  for (const d of HOTKEYS) {
    const v = overrides?.[d.id]
    if (typeof v === 'string' && validFor(d, v)) out[d.id] = v
  }
  return out
}

function validFor(d: HotkeyDef, combo: string): boolean {
  const c = parseCombo(combo)
  if (!c || formatCombo(c) !== combo || !bindable(c) || reserved(combo)) return false
  return d.range ? c.code === 'Digit#' : c.code !== 'Digit#'
}

/** What settings.json keeps: the valid combos that differ from their default. Unknown ids, nulls and defaults go. */
export function hotkeyOverrides(v: unknown): Partial<Hotkeys> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Partial<Hotkeys> = {}
  for (const d of HOTKEYS) {
    const c = (v as Record<string, unknown>)[d.id]
    if (typeof c === 'string' && c !== d.combo && validFor(d, c)) out[d.id] = c
  }
  return out
}

/** The concrete combos a binding answers: a range's `Digit#` becomes each of its digits. */
export function expand(id: HotkeyId, combo: string): string[] {
  const d = hotkeyDef(id)
  if (!d.range || !combo.endsWith('Digit#')) return [combo]
  return Array.from({ length: d.range }, (_, i) => combo.replace('Digit#', `Digit${i + 1}`))
}

/** The shortcut other than `id` that already answers `combo`, if any. A range counts for each of its digits. */
export function conflictOf(keys: Hotkeys, id: HotkeyId, combo: string): HotkeyId | undefined {
  const mine = new Set(expand(id, combo))
  return HOTKEYS.find((d) => d.id !== id && expand(d.id, keys[d.id]).some((c) => mine.has(c)))?.id
}

/** The combos a preview hands back to Kernel. */
export function forwardedCombos(keys: Hotkeys): Set<string> {
  return new Set(HOTKEYS.filter((d) => 'forward' in d && d.forward).flatMap((d) => expand(d.id, keys[d.id])))
}

const GLYPH: Record<Mod, string> = { ctrl: '⌃', meta: '⌘', alt: '⌥', shift: '⇧' }
const KEY_NAME: Record<string, string> = {
  Enter: '↵', Backspace: '⌫', Delete: '⌦', Tab: 'Tab', Space: 'Space', Escape: 'Esc', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=', Backquote: '`', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→'
}

/** The caps a combo draws as, one string per key: `['⌘', '⇧', 'P']`. A range's number reads "1 to 9". */
export function comboKeys(combo: string, range?: number): string[] {
  const c = parseCombo(combo)
  if (!c) return []
  const key = c.code === 'Digit#' ? `1 to ${range ?? 9}` : c.code.startsWith('Key') || c.code.startsWith('Digit') ? c.code.slice(c.code.startsWith('Key') ? 3 : 5) : KEY_NAME[c.code] ?? c.code
  return [...MODS.filter((m) => c[m]).map((m) => GLYPH[m]), key]
}

/** The combo as one tooltip string: `⌘⇧P`. */
export const comboLabel = (combo: string, range?: number): string => comboKeys(combo, range).join('')

const SPOKEN: Record<string, string> = { '⌘': 'Command', '⇧': 'Shift', '⌥': 'Option', '⌃': 'Control', '↵': 'Return', '⌫': 'Delete', '⌦': 'Forward delete' }
/** The combo for a screen reader: "Command Shift P". */
export const comboSpoken = (combo: string, range?: number): string => comboKeys(combo, range).map((k) => SPOKEN[k] ?? k).join(' ')

/** A key event, from the page (`KeyboardEvent`) or from main's `before-input-event` after `fromInput`. */
export interface KeyLike { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/**
 * The key an event pressed, as a combo code. A letter goes by what the layout typed, as Kernel's handlers always did, unless Option
 * turned it into another character (⌥B is ∫), when the physical key counts. Enter on the number pad is Enter.
 */
export function codeOf(e: Pick<KeyLike, 'key' | 'code'>): string {
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) return `Key${e.key.toUpperCase()}`
  if (e.code === 'NumpadEnter') return 'Enter'
  return e.code
}

/** The combo an event pressed, or null for a modifier alone. */
export function eventCombo(e: KeyLike): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn'].includes(e.key)) return null
  return formatCombo({ ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, code: codeOf(e) })
}

/** Whether the event presses `combo` exactly, modifiers included. A range combo matches any of its digits. */
export function matches(e: KeyLike, combo: string, range?: number): boolean {
  return digitOf(e, combo, range) !== null || eventCombo(e) === combo
}

/** The digit a range combo was pressed with, 1 to `range`, else null. */
export function digitOf(e: KeyLike, combo: string, range = 9): number | null {
  if (!combo.endsWith('Digit#')) return null
  const m = /^Digit([1-9])$/.exec(e.code)
  if (!m || Number(m[1]) > range) return null
  const c = formatCombo({ ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, code: 'Digit#' })
  return c === combo ? Number(m[1]) : null
}

/** main's `before-input-event` input as a key event. */
export const fromInput = (i: { key: string; code: string; meta: boolean; control: boolean; alt: boolean; shift: boolean }): KeyLike =>
  ({ key: i.key, code: i.code, metaKey: i.meta, ctrlKey: i.control, altKey: i.alt, shiftKey: i.shift })

/** What recording a key for `id` gives: the combo to save, or why it can't be used. */
export function recorded(keys: Hotkeys, id: HotkeyId, e: KeyLike): { combo: string } | { error: string } | null {
  const d = hotkeyDef(id)
  let combo = eventCombo(e)
  if (!combo) return null
  if (d.range) {
    if (!/^Digit[1-9]$/.test(e.code)) return { error: 'Hold the modifier keys and press a number' }
    combo = combo.replace(/Digit[1-9]$/, 'Digit#')
  }
  const c = parseCombo(combo)
  if (!c) return { error: 'That key can’t be used for a shortcut' }
  if (!bindable(c)) return { error: 'Add ⌘, ⌃ or ⌥ to the key' }
  if (reserved(combo)) return { error: `${comboLabel(combo)} belongs to macOS or text editing` }
  const other = conflictOf(keys, id, combo)
  if (other) return { error: `${comboLabel(combo, d.range)} is already ${hotkeyDef(other).label}` }
  return { combo }
}
