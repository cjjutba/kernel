import { PROVIDERS, type ChatRunMode, type ModeReason, type PermissionMode, type Provider } from '@shared/types'
import { MODE_INFO, unavailable, type ModeAvailabilities } from '../../../permissionModes'
import type { IconName } from '../../../icons'

/** A stop in the composer's mode cycle: Plan sits among the four permission modes, though a chat plans with `plan` and keeps its own `mode`. */
export type ComposerMode = PermissionMode | 'plan'

/** The order of the menu and of Shift+Tab (ComposerModes.png, KERNEL-435). */
export const MODE_ORDER: readonly ComposerMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']

export const MODE_ICON: Record<ComposerMode, IconName> = { default: 'shield', acceptEdits: 'pen', plan: 'plan', auto: 'sparkle', bypassPermissions: 'forward' }

/** One line a mode, shorter than Settings' sentences (ComposerModeMenu.png). */
export const MODE_DESC: Record<ComposerMode, string> = {
  default: 'Asks before every edit and command',
  acceptEdits: 'Edits files without asking',
  plan: 'Plans first and changes nothing until you approve',
  auto: 'A classifier approves routine work',
  bypassPermissions: 'Skips every prompt, Always ask included'
}

export const modeName = (mode: ComposerMode) => (mode === 'plan' ? 'Plan' : MODE_INFO[mode].label)

/** The dropdown is the width of a model button, so Bypass permissions is Bypass there (ComposerModes.png). */
export const buttonName = (mode: ComposerMode) => (mode === 'bypassPermissions' ? 'Bypass' : modeName(mode))

/**
 * What a chat shows of its mode. `runs` is the mode it runs in, which the label names. `picked` is the mode its pick sits on, which the menu
 * checks: Plan while the chat plans, else the pick of the chat, its room or Settings. `why` is what keeps `runs` off the pick.
 */
export interface Shown { runs: ComposerMode; picked: ComposerMode; why?: Exclude<ModeReason, 'plan'> }

/**
 * Main's answer (KERNEL-572), or `fallback` until it comes: the mode the chat follows when main hasn't said. A chat that plans shows Plan
 * from its own `plan`, which arrives with the chat itself, so the label doesn't wait for a second event.
 */
export function shownMode(planning: boolean, run: ChatRunMode | undefined, fallback: PermissionMode): Shown {
  if (planning) return { runs: 'plan', picked: 'plan' }
  const picked = run?.picked ?? fallback
  const why = run?.why && run.why !== 'plan' ? run.why : undefined
  return { runs: !run || run.mode === 'plan' ? picked : run.mode, picked, ...(why ? { why } : {}) }
}

/**
 * Why the chat's own provider can't run `mode`, as the line under its row, or nothing when it can. `unavailable` words the answer for
 * every provider and ends each line with what the others use instead, so it is asked about this provider alone and the last sentence is cut.
 */
export function offLine(mode: ComposerMode, provider: Provider, availability: ModeAvailabilities | null): string | undefined {
  if (mode === 'plan' || !availability) return undefined
  const only = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.id === provider ? availability[p.id] : { auto: true, bypass: true }])) as ModeAvailabilities
  const line = unavailable(mode, only).lines[0]
  if (!line) return undefined
  const end = line.lastIndexOf('. ')
  return end > 0 ? line.slice(0, end) : line
}

/** What `chats.configure` is given for a pick: Plan sets `plan` and leaves the chat's own `mode` where it is, so leaving Plan returns to it. The others set `mode` and clear `plan`. */
export const modePatch = (mode: ComposerMode): { plan: true } | { mode: PermissionMode; plan: false } => (mode === 'plan' ? { plan: true } : { mode, plan: false })

/** The mode Shift+Tab goes to from `from`: the next in the order that `can` run, round to the start. It stays put when nothing else can run. */
export function nextMode(from: ComposerMode, can: (mode: ComposerMode) => boolean): ComposerMode {
  const at = MODE_ORDER.indexOf(from)
  for (let i = 1; i <= MODE_ORDER.length; i++) {
    const mode = MODE_ORDER[(at + i) % MODE_ORDER.length]
    if (can(mode)) return mode
  }
  return from
}

/** What replaces the picked row's description when the chat runs in another mode (ComposerModeMenu.png). `off` is the provider's own line for a mode it can't run. */
export function whyLine(why: Shown['why'], runs: ComposerMode, off?: string): string | undefined {
  if (!why) return undefined
  const as = `Runs as ${modeName(runs)}`
  if (why === 'turnRunning') return `${as} until the turn ends`
  const because = {
    worktreesOnly: 'Only in worktrees is on',
    noAuto: off ?? 'Auto isn’t available for this chat',
    noBypass: off ?? 'Claude Code’s settings turn Bypass permissions off',
    agentFile: 'the agent file sets a stricter mode'
  }[why]
  return `${as}, ${because}`
}

/** A row of the mode menu. `off` is a mode the chat's provider can't run, which is dimmed and does nothing. */
export interface ModeRow { mode: ComposerMode; name: string; desc: string; icon: IconName; checked: boolean; off: boolean; why: boolean }

export function modeRows(shown: Shown, provider: Provider, availability: ModeAvailabilities | null): ModeRow[] {
  return MODE_ORDER.map((mode) => {
    const off = offLine(mode, provider, availability)
    const checked = mode === shown.picked
    const why = checked ? whyLine(shown.why, shown.runs, off) : undefined
    return { mode, name: modeName(mode), desc: why ?? off ?? MODE_DESC[mode], icon: MODE_ICON[mode], checked, off: !!off, why: !!why }
  })
}

/** The dropdown's name for screen readers: the mode the chat runs in, and the pick when it can't run (ComposerModeMenu.png). */
export function modeAria(shown: Shown): string {
  const said = shown.picked !== shown.runs && shown.why
    ? ` ${modeName(shown.picked)} ${shown.why === 'turnRunning' ? 'starts when the turn ends.' : 'is picked but can’t run here.'}`
    : ''
  return `Permission mode: ${modeName(shown.runs)}.${said} Shift+Tab to change`
}
