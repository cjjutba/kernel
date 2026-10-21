import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTogether, getState, setState } from '../src/renderer/src/store'
import type { AgentDef, Chat, Project, Workspace } from '../src/shared/types'

const calls: [string, unknown][] = []
vi.mock('../src/renderer/src/api', () => ({
  cleanError: (e: unknown) => String(e),
  onPush: () => () => undefined,
  call: async (channel: string, req: unknown) => { calls.push([channel, req]); return [] }
}))

const { runToastAction } = await import('../src/renderer/src/components/toastAction')

const project = { id: 'r1', name: 'r1', path: '/r/r1', defaultBranch: 'main', paused: false, createdAt: 1 } as Project
const ivy = { id: 'ivy', name: 'Ivy' } as AgentDef
const ws = { id: 'w1', projectId: 'r1', name: 'w1', branch: 'b', baseRef: 'main', path: '/w/w1', mode: 'worktree', agentId: 'ivy', port: 0, status: 'ready', prState: 'none', createdAt: 1, setupRun: { startedAt: 1_000, endedAt: 32_000, end: null } } as Workspace
const chat = { id: 'c1', workspaceId: 'w1', title: 'Clean-account journey', kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1 } as Chat

beforeEach(() => {
  calls.length = 0
  setState({ projects: [project], agents: { r1: [ivy] }, workspaces: [ws], chats: { w1: [chat] } })
  setState((s) => ({ ui: { ...s.ui, toasts: [] } }))
})

const toasts = () => getState().ui.toasts
/** `setup.failed` waits for the team when the window has not loaded it, so let that settle. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('setup.failed and worktree.failed', () => {
  it('raises a toast with Open Setup tab and Rerun setup for a run that failed, and the agent keeps working', async () => {
    applyTogether({ type: 'setup.failed', workspaceId: 'w1', chatId: 'c1', kind: 'failed', code: 1 })
    await settle()
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]).toMatchObject({ title: 'Setup script failed', sub: 'Ivy keeps working. Check the Setup tab for logs.', detail: 'Clean-account journey', glyph: 'error', other: { label: 'Open Setup tab', openSetup: 'w1' }, action: { label: 'Rerun setup', rerunSetup: 'w1', primary: true } })
  })

  it('says how long a stopped run went and offers only Rerun setup', async () => {
    applyTogether({ type: 'setup.failed', workspaceId: 'w1', chatId: 'c1', kind: 'stopped' })
    await settle()
    expect(toasts()[0]).toMatchObject({ title: 'Setup stopped', sub: 'You stopped setup after 0:31. Ivy keeps working.', action: { label: 'Rerun setup' } })
    expect(toasts()[0].other).toBeUndefined()
  })

  it('names a timeout, and a worktree git could not make carries git\'s line with Try again', async () => {
    applyTogether({ type: 'setup.failed', workspaceId: 'w1', kind: 'timeout' })
    applyTogether({ type: 'worktree.failed', workspaceId: 'w1', chatId: 'c1', error: "fatal: 'x' already exists" })
    await settle()
    expect(toasts().map((t) => t.title)).toEqual(["Couldn't create the worktree", 'Setup script timed out'])
    expect(toasts()[0]).toMatchObject({ sub: "fatal: 'x' already exists", detail: 'Clean-account journey', action: { label: 'Try again', retryWorktree: 'w1' } })
  })

  it('runs the toast actions through main', () => {
    runToastAction({ label: 'Rerun setup', rerunSetup: 'w1' })
    runToastAction({ label: 'Try again', retryWorktree: 'w1' })
    expect(calls).toEqual([['scripts.run', { workspaceId: 'w1', kind: 'setup' }], ['workspaces.retryWorktree', { workspaceId: 'w1' }]])
  })
})
