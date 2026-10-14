import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { QuitGuard, quitDialog, quitStep, SHUTDOWN_GRACE_MS, type QuitDialog, type QuitReason } from '../src/main/quit'
import type { Chat } from '../src/shared/types'
import type { PushEvent } from '../src/shared/ipc'
import { freePort } from './helpers'

const settle = () => new Promise((r) => setTimeout(r, 10))

describe('quitStep', () => {
  const reasons: QuitReason[] = ['user', 'update', 'shutdown', 'bootFailed']

  it('asks only when the user quits or restarts with an agent working', () => {
    for (const reason of reasons) {
      const asks = reason === 'user' || reason === 'update'
      expect(quitStep(0, reason, false), `${reason}, nothing working`).toBe('quit')
      expect(quitStep(1, reason, false), `${reason}, one working`).toBe(asks ? 'ask' : 'quit')
      expect(quitStep(3, reason, false), `${reason}, three working`).toBe(asks ? 'ask' : 'quit')
    }
  })

  it('never asks in a quiet run', () => {
    for (const reason of reasons) for (const working of [0, 1, 3]) expect(quitStep(working, reason, true)).toBe('quit')
  })
})

describe('quitDialog', () => {
  it('counts agents and makes Cancel the default', () => {
    expect(quitDialog(3, 'user')).toEqual({
      message: '3 agents are working',
      detail: 'Quitting stops them. They carry on where they left off when Kernel opens again.',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    expect(quitDialog(1, 'user').message).toBe('1 agent is working')
    expect(quitDialog(2, 'update').buttons).toEqual(['Restart', 'Cancel'])
  })
})

/** A guard with recorded calls. `answer` is what the dialog returns; `stop` defaults to one that ends at once. */
function guard(o: { working?: number; answer?: boolean | Promise<boolean>; stop?: () => Promise<void>; quiet?: boolean; capMs?: number; shutdownGraceMs?: number } = {}) {
  const calls = { asked: [] as QuitDialog[], stops: 0, quits: 0 }
  const g = new QuitGuard({
    working: () => o.working ?? 0,
    ask: async (d) => { calls.asked.push(d); return o.answer ?? false },
    stop: async () => { calls.stops++; await o.stop?.() },
    quit: () => { calls.quits++ },
    quiet: o.quiet,
    capMs: o.capMs,
    shutdownGraceMs: o.shutdownGraceMs
  })
  const event = () => { const e = { prevented: false, preventDefault() { e.prevented = true } }; return e }
  return { g, calls, event }
}

describe('QuitGuard', () => {
  it('asks with an agent working, and Cancel keeps Kernel running', async () => {
    const { g, calls, event } = guard({ working: 2, answer: false })
    const e = event()
    g.beforeQuit(e)
    await settle()
    expect(e.prevented).toBe(true)
    expect(calls.asked.map((d) => d.message)).toEqual(['2 agents are working'])
    expect(calls).toMatchObject({ stops: 0, quits: 0 })
  })

  it('stops Kernel on Quit, then lets the next before-quit through', async () => {
    const { g, calls, event } = guard({ working: 1, answer: true })
    g.beforeQuit(event())
    await settle()
    expect(calls).toMatchObject({ stops: 1, quits: 1 })
    const again = event()
    g.beforeQuit(again)
    expect(again.prevented).toBe(false)
  })

  it('quits without a dialog when nothing is working, after the stop', async () => {
    const { g, calls, event } = guard({ working: 0 })
    g.beforeQuit(event())
    await settle()
    expect(calls).toMatchObject({ asked: [], stops: 1, quits: 1 })
  })

  it('never asks on a Mac shutdown or after a failed boot', async () => {
    for (const mark of ['shutdown', 'bootFailed'] as const) {
      const { g, calls, event } = guard({ working: 3 })
      g[mark]()
      g.beforeQuit(event())
      await settle()
      expect(calls, mark).toMatchObject({ asked: [], stops: 1, quits: 1 })
    }
  })

  describe('a logout another app cancels', () => {
    afterEach(() => { vi.useRealTimers() })

    it('asks again on the next Cmd+Q once no quit followed the shutdown', async () => {
      vi.useFakeTimers()
      const { g, calls, event } = guard({ working: 2, answer: false })
      g.shutdown()
      await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS)
      g.beforeQuit(event())
      await vi.advanceTimersByTimeAsync(0)
      expect(calls.asked.map((d) => d.message)).toEqual(['2 agents are working'])
      expect(calls).toMatchObject({ stops: 0, quits: 0 })
    })

    it('stays a shutdown when its quit comes in time, and clears the timer', async () => {
      vi.useFakeTimers()
      const { g, calls, event } = guard({ working: 2 })
      g.shutdown()
      await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1)
      g.beforeQuit(event())
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toMatchObject({ asked: [], stops: 1, quits: 1 })
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('never asks in a headless run', async () => {
    const { g, calls, event } = guard({ working: 3, quiet: true })
    g.beforeQuit(event())
    await settle()
    expect(calls).toMatchObject({ asked: [], stops: 1, quits: 1 })
  })

  it('ignores a second Cmd+Q while the dialog is up', async () => {
    let answer!: (yes: boolean) => void
    const { g, calls, event } = guard({ working: 1, answer: new Promise<boolean>((r) => { answer = r }) })
    g.beforeQuit(event())
    const second = event()
    g.beforeQuit(second)
    await settle()
    expect(second.prevented).toBe(true)
    expect(calls.asked).toHaveLength(1)
    answer(true)
    await settle()
    expect(calls).toMatchObject({ stops: 1, quits: 1 })
  })

  it('quits after the cap when the stop hangs or fails', async () => {
    const hangs = guard({ stop: () => new Promise(() => undefined), capMs: 30 })
    hangs.g.beforeQuit(hangs.event())
    await settle()
    expect(hangs.calls.quits).toBe(0)
    await new Promise((r) => setTimeout(r, 40))
    expect(hangs.calls.quits).toBe(1)

    const fails = guard({ stop: async () => { throw new Error('closed') } })
    fails.g.beforeQuit(fails.event())
    await settle()
    expect(fails.calls.quits).toBe(1)
  })

  it('asks before Restart to update, and on Restart stops first so before-quit passes', async () => {
    const no = guard({ working: 1, answer: false })
    expect(await no.g.confirmUpdate()).toBe(false)
    expect(no.calls.asked[0].buttons[0]).toBe('Restart')
    expect(no.calls.stops).toBe(0)

    const yes = guard({ working: 1, answer: true })
    expect(await yes.g.confirmUpdate()).toBe(true)
    expect(yes.calls).toMatchObject({ stops: 1, quits: 0 })
    const e = yes.event()
    yes.g.beforeQuit(e)
    expect(e.prevented).toBe(false)
    expect(yes.calls.asked).toHaveLength(1)
  })
})

async function kernel(o: Partial<ConstructorParameters<typeof Kernel>[0]> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt') }))
  return new Kernel({ dataDir, home, ...o })
}

const chat = (id: string, workspaceId: string): Chat => ({ id, workspaceId, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'medium', plan: false, createdAt: Date.now() } as Chat)

describe('Kernel on quit', () => {
  it('counts workspaces with a running chat, not chats', async () => {
    const k = await kernel()
    for (const c of [chat('a1', 'wsA'), chat('a2', 'wsA'), chat('b1', 'wsB')]) k.store.saveChat(c)
    const running = (chatId: string, on: boolean) => bus.push({ type: 'chat.running', chatId, running: on })
    expect(k.workingAgents()).toBe(0)
    running('a1', true)
    running('a2', true)
    expect(k.workingAgents()).toBe(1)
    running('b1', true)
    expect(k.workingAgents()).toBe(2)
    running('a1', false)
    expect(k.workingAgents()).toBe(2)
    running('a2', false)
    running('b1', false)
    expect(k.workingAgents()).toBe(0)
    await k.stop()
  })

  /** A kernel with these chats saved and running, one per id, in the workspace named after its first letter. */
  async function busy(ids: string[]) {
    const k = await kernel()
    for (const id of ids) {
      k.store.saveChat(chat(id, `ws${id[0].toUpperCase()}`))
      bus.push({ type: 'chat.running', chatId: id, running: true })
    }
    const wait = (chatId: string, kind: 'plan' | 'tool' | 'question') =>
      k.approvals.request({ kind, source: 'sdk', roomId: 'r', workspaceId: `ws${chatId[0].toUpperCase()}`, chatId, title: kind })
    const done = async () => { for (const id of ids) bus.push({ type: 'chat.running', chatId: id, running: false }); await k.stop({ budgetMs: 0 }) }
    return { k, wait, done }
  }

  it('quits at once when every busy agent only waits on a plan approval', async () => {
    const { k, wait, done } = await busy(['a1', 'b1'])
    wait('a1', 'plan')
    wait('b1', 'plan')
    expect(k.chats.workingAgents()).toBe(0)
    expect(quitStep(k.chats.workingAgents(), 'user', false)).toBe('quit')
    await done()
  })

  it('counts only the agents really working when some wait on a plan approval', async () => {
    const { k, wait, done } = await busy(['a1', 'b1', 'c1', 'd1'])
    wait('a1', 'plan')
    wait('c1', 'plan')
    expect(k.chats.workingAgents()).toBe(2)
    expect(quitDialog(k.chats.workingAgents(), 'user').message).toBe('2 agents are working')
    await done()
  })

  it('still counts an agent waiting on a tool permission or a question, and one with a plan and a permission up', async () => {
    const { k, wait, done } = await busy(['a1', 'b1', 'c1'])
    wait('a1', 'tool')
    wait('b1', 'question')
    wait('c1', 'plan')
    wait('c1', 'tool')
    expect(k.chats.workingAgents()).toBe(3)
    await done()
  })

  it('counts a Lead with one chat on a plan approval and one working as one agent', async () => {
    const { k, wait, done } = await busy(['a1', 'a2'])
    wait('a1', 'plan')
    expect(k.chats.workingAgents()).toBe(1)
    bus.push({ type: 'chat.running', chatId: 'a2', running: false })
    expect(k.chats.workingAgents()).toBe(0)
    await done()
  })

  it('reads no database when a chat starts or stops, so a push never throws from the counting', async () => {
    const k = await kernel()
    // Every Store query prepares its statement, so this fails any read. Closing the database would prove the same, but
    // stop() writes on the way out (the working journal and cleanExit, KERNEL-215), so it needs the database back after.
    const prepare = vi.spyOn(k.store.db, 'prepare').mockImplementation(() => { throw new Error('The database was read') })
    expect(() => bus.push({ type: 'chat.running', chatId: 'c1', running: true })).not.toThrow()
    expect(() => bus.push({ type: 'chat.running', chatId: 'c1', running: false })).not.toThrow()
    expect(prepare).not.toHaveBeenCalled()
    prepare.mockRestore()
    await k.stop()
  })

  it('asks before Restart to update, and Cancel leaves the update uninstalled', async () => {
    let installs = 0
    let answer = false
    const updater = { get: () => ({ status: 'ready', current: '1.0.0' }) as const, check: async () => ({ status: 'ready', current: '1.0.0' }) as const, install: () => { installs++ } }
    const k = await kernel({ updater, confirmQuit: async () => answer })
    const h = k.handlers()
    expect(await h['update.install'](undefined)).toEqual({ ok: true, canceled: true })
    expect(installs).toBe(0)
    answer = true
    expect(await h['update.install'](undefined)).toEqual({ ok: true })
    expect(installs).toBe(1)
    await k.stop()
  })

  it('refuses Restart to update with no update ready, before asking or stopping', async () => {
    let asked = 0
    const updater = { get: () => ({ status: 'downloading', current: '1.0.0' }) as const, check: async () => ({ status: 'downloading', current: '1.0.0' }) as const, install: () => { throw new Error('No update is ready') } }
    const k = await kernel({ updater, confirmQuit: async () => { asked++; return true } })
    await expect(k.handlers()['update.install'](undefined)).rejects.toThrow('No update is ready')
    expect(asked).toBe(0)
    // Kernel didn't stop, so its database still answers.
    expect(k.store.chat('none')).toBeUndefined()
    await k.stop()
  })

  it('pushes no hooks status while it stops, so the window never shows Hooks are disconnected', async () => {
    const k = await kernel()
    await k.start()
    const hooks: PushEvent[] = []
    const on = (e: PushEvent) => { if (e.type === 'hooks') hooks.push(e) }
    bus.on('push', on)
    await k.stop()
    await settle()
    bus.off('push', on)
    expect(hooks).toEqual([])
  })
})
