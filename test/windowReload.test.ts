import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushEvent } from '@shared/ipc'

// KERNEL-340: a window that loads while agents, scripts and terminals work gets their state back from main. Pushes only
// report changes, so without it every working agent looked stopped after a reload.

const bridge = vi.hoisted(() => {
  const b = {
    push: undefined as undefined | ((e: unknown) => void),
    calls: [] as { channel: string; req: unknown }[],
    answer: (_v: unknown) => {},
    fail: () => {}
  }
  return b
})
vi.mock('../src/renderer/src/api', () => ({
  call: async (channel: string, req: unknown) => {
    bridge.calls.push({ channel, req })
    if (channel === 'chats.live') return new Promise((resolve, reject) => { bridge.answer = resolve; bridge.fail = () => reject(new Error('No handler registered for chats.live')) })
    if (channel === 'terminal.replay' && (req as { chatId: string }).chatId === 'gone') throw new Error('Kernel is starting')
    if (['settings.get', 'system.fixture', 'preflight.run', 'account.get', 'hooks.status', 'update.get'].includes(channel)) return null
    if (channel === 'scripts.replay' || channel === 'terminal.replay') return { ok: true }
    return []
  },
  onPush: (listener: (e: unknown) => void) => { bridge.push = listener; return () => undefined }
}))
const { apply, boot, getState, loadWorkspace, replayTerminal, setState } = await import('../src/renderer/src/store')
const { runningRuns } = await import('../src/renderer/src/screens/workspace/runScripts')

const flush = () => new Promise((r) => setTimeout(r, 0))
const push = (e: PushEvent) => bridge.push!(e)
const asked = (channel: string) => bridge.calls.filter((c) => c.channel === channel).map((c) => c.req)
const retry = { attempt: 2, of: 5, nextAt: 9 }

beforeEach(() => {
  bridge.calls.length = 0
  setState({ running: {}, retry: {}, scripts: {}, scriptExit: {}, scriptUrl: {}, terminal: {}, terminalReplays: {} })
})

describe('working chats after a reload', () => {
  it('marks the chats main says are working, and the ones retrying', async () => {
    const booted = boot()
    bridge.answer({ running: ['c1', 'c2'], retry: { c2: retry } })
    await booted
    await flush()
    expect(getState().running).toEqual({ c1: true, c2: true })
    expect(getState().retry).toEqual({ c2: retry })
  })

  it('keeps what a push said while the answer was on its way, since the push is newer', async () => {
    const booted = boot()
    push({ type: 'chat.running', chatId: 'c1', running: false })
    push({ type: 'retry', chatId: 'c2', retry: null })
    push({ type: 'chat.running', chatId: 'c4', running: true })
    bridge.answer({ running: ['c1', 'c2', 'c3'], retry: { c2: retry } })
    await booted
    await flush()
    expect(getState().running).toEqual({ c1: false, c2: true, c3: true, c4: true })
    expect(getState().retry).toEqual({})
  })

  it('still boots when main has no such channel, as a dev build mid-pull may not', async () => {
    const booted = boot()
    bridge.fail()
    await booted
    await flush()
    expect(getState().system.booted).toBe(true)
    expect(getState().running).toEqual({})
    // Pushes after a failed load still count.
    push({ type: 'chat.running', chatId: 'c1', running: true })
    expect(getState().running).toEqual({ c1: true })
  })
})

describe('scripts after a reload', () => {
  const line = (name: string, text: string) => ({ kind: 'run' as const, name, line: text, stream: 'stdout' as const })

  it("takes main's copy for that workspace only, so a running dev server shows as running with its URL", () => {
    setState({ scripts: { w1: [line('run', 'partial')], w2: [line('run', 'other')] }, scriptExit: { w1: { run: 0 }, w2: { run: 1 } }, scriptUrl: { w2: { run: 'http://localhost:4310' } } })
    apply({ type: 'script.state', workspaceId: 'w1', lines: [line('run', '$ pnpm dev'), line('run', 'partial')], exit: {}, url: { run: 'http://localhost:4300' } })
    expect(getState().scripts.w1.map((l) => l.line)).toEqual(['$ pnpm dev', 'partial'])
    expect(getState().scriptUrl.w1).toEqual({ run: 'http://localhost:4300' })
    expect(runningRuns(getState(), 'w1')).toEqual(['run'])
    expect(getState().scripts.w2.map((l) => l.line)).toEqual(['other'])
    expect(getState().scriptExit.w2).toEqual({ run: 1 })
    expect(getState().scriptUrl.w2).toEqual({ run: 'http://localhost:4310' })
  })

  it('asks main once per workspace, since every line after that reaches the window as it is printed', async () => {
    await loadWorkspace('w9')
    await loadWorkspace('w9')
    await loadWorkspace('w8')
    expect(asked('scripts.replay')).toEqual([{ workspaceId: 'w9' }, { workspaceId: 'w8' }])
  })
})

describe('terminals after a reload', () => {
  it("takes main's copy in place of the buffer, counts the replay, and appends what comes after", () => {
    apply({ type: 'terminal.data', chatId: 't1', data: 'partial' })
    apply({ type: 'terminal.data', chatId: 't1', data: 'everything so far, partial', replace: true })
    expect(getState().terminal.t1).toBe('everything so far, partial')
    expect(getState().terminalReplays.t1).toBe(1)
    apply({ type: 'terminal.data', chatId: 't1', data: ' and more' })
    expect(getState().terminal.t1).toBe('everything so far, partial and more')
    expect(getState().terminalReplays.t1).toBe(1)
  })

  it('asks main once per terminal, and again next time when the ask failed', async () => {
    replayTerminal('t7')
    replayTerminal('t7')
    replayTerminal('gone')
    await flush()
    replayTerminal('gone')
    expect(asked('terminal.replay')).toEqual([{ chatId: 't7' }, { chatId: 'gone' }, { chatId: 'gone' }])
  })
})
