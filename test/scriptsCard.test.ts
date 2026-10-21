import { describe, expect, it } from 'vitest'
import { parseScriptsCard, SAVE_SCRIPTS_QUESTION } from '../src/shared/scriptsCard'
import { SAVE_SCRIPTS_QUESTION as MAIN_QUESTION } from '../src/main/services/kernelMcp'

describe('the scripts card (KERNEL-1094)', () => {
  it('asks the question main asks', () => {
    expect(SAVE_SCRIPTS_QUESTION).toBe(MAIN_QUESTION)
  })

  it('reads every section main writes, each script whole', () => {
    const detail = 'Setup script\npnpm install\ncp "$KERNEL_ROOT_PATH/.env" .env\n\nRun script\npnpm dev --port $KERNEL_PORT\n\nRun script "storybook"\npnpm storybook\n\nArchive script\nrm -rf shots/\n\nRun mode\nOne at a time'
    expect(parseScriptsCard(detail)).toEqual([
      { kind: 'setup', label: 'Setup', hint: 'Runs alongside the agent in each new worktree', text: 'pnpm install\ncp "$KERNEL_ROOT_PATH/.env" .env' },
      { kind: 'run', label: 'Run', hint: 'Runs from the Run button', text: 'pnpm dev --port $KERNEL_PORT' },
      { kind: 'run', label: 'Run "storybook"', hint: 'Runs from the Run button', text: 'pnpm storybook' },
      { kind: 'archive', label: 'Archive', hint: 'Runs before a chat is archived', text: 'rm -rf shots/' },
      { kind: 'mode', label: 'Run mode', hint: '', text: 'One at a time' }
    ])
  })

  it('keeps a blank line inside a script, and drops what comes before the first heading', () => {
    expect(parseScriptsCard('Intro.\nSetup script\nline one\n\nline two')).toEqual([{ kind: 'setup', label: 'Setup', hint: 'Runs alongside the agent in each new worktree', text: 'line one\n\nline two' }])
    expect(parseScriptsCard('no headings here')).toEqual([])
  })
})
