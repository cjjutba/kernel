import { useEffect, useState } from 'react'
import type { AppSettings, TerminalPreset } from '@shared/types'
import { call } from './api'
import { useStore } from './store'

/** What the last answer from `terminal.presets` was, so a screen opens with a list and doesn't flash an empty one. */
let last: TerminalPreset[] | null = null

/**
 * The presets a new big terminal tab can run (KERNEL-248): the built-ins, the CLIs found on the PATH, then the custom commands.
 * Main builds the list, so this asks again whenever the custom commands change and whenever `refresh` changes (a menu opening),
 * which is when a CLI installed since shows up. Null until the first answer.
 */
export function useTerminalPresets(refresh?: unknown): TerminalPreset[] | null {
  const custom = useStore((s) => s.settings?.terminal.custom)
  const [list, setList] = useState(last)
  useEffect(() => {
    let live = true
    void call('terminal.presets', undefined).then((l) => { last = l; if (live) setList(l) }).catch(() => undefined)
    return () => { live = false }
  }, [custom, refresh])
  return list
}

/** The preset a new tab runs: the settings' choice, and the first one when that is gone. Main falls back the same way (KERNEL-248). */
export const selectedPreset = (list: TerminalPreset[], t: AppSettings['terminal']): TerminalPreset | undefined => list.find((p) => p.id === t.preset) ?? list[0]

/**
 * The tab ran without `--dangerously-skip-permissions` although its preset has it: Only in worktrees took it out on a
 * current-branch workspace. Main stores the command that ran, so the tab compares it with the preset's (KERNEL-248).
 */
export const skipWasDropped = (terminal: { preset: string; command: string | null } | undefined, list: TerminalPreset[] | null): boolean => {
  const preset = terminal && list?.find((p) => p.id === terminal.preset)
  return !!preset && preset.skipsPermissions && terminal.command !== preset.command
}
