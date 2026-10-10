import { describe, expect, it } from 'vitest'
import { skipWasDropped } from '../src/renderer/src/terminalPresets'
import { SKIP_FLAG, type TerminalPreset } from '../src/shared/types'

const preset = (id: string, command: string | null, skipsPermissions: boolean, builtin = true): TerminalPreset => ({ id, name: id, command, builtin, skipsPermissions })
const skip = preset('claude-skip', `claude ${SKIP_FLAG}`, true)
const list = [preset('claude', 'claude', false), skip, preset('shell', null, false), preset('custom-dev', `my-claude ${SKIP_FLAG}`, true, false)]

describe('the skip notice on a big terminal tab', () => {
  it('shows when the tab ran without the flag its preset has', () => {
    expect(skipWasDropped({ preset: 'claude-skip', command: 'claude' }, list)).toBe(true)
    expect(skipWasDropped({ preset: 'custom-dev', command: 'my-claude' }, list)).toBe(true)
  })

  it('stays off when the flag ran, in a worktree', () => {
    expect(skipWasDropped({ preset: 'claude-skip', command: `claude ${SKIP_FLAG}` }, list)).toBe(false)
  })

  it('stays off for a preset that never had the flag, a plain shell, a preset that is gone and a tab with no preset', () => {
    expect(skipWasDropped({ preset: 'claude', command: 'claude' }, list)).toBe(false)
    expect(skipWasDropped({ preset: 'shell', command: null }, list)).toBe(false)
    expect(skipWasDropped({ preset: 'custom-removed', command: 'claude' }, list)).toBe(false)
    expect(skipWasDropped(undefined, list)).toBe(false)
    expect(skipWasDropped({ preset: 'claude-skip', command: 'claude' }, null)).toBe(false)
  })

  it('follows the command that ran, not the preset as it is now, when the preset is edited while its tab is open', () => {
    // The tab ran the flag in a worktree, then the preset gained --verbose. The commands differ, but the flag was not dropped.
    const edited = [preset('custom-dev', `my-claude ${SKIP_FLAG} --verbose`, true, false)]
    expect(skipWasDropped({ preset: 'custom-dev', command: `my-claude ${SKIP_FLAG}` }, edited)).toBe(false)
    // A tab opened on a current branch after the edit ran without the flag, so it says so.
    expect(skipWasDropped({ preset: 'custom-dev', command: 'my-claude --verbose' }, edited)).toBe(true)
  })
})
