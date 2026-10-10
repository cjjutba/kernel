import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { QuitGuard, quitDialog, quitStep, type QuitDialog, type QuitReason } from '../src/main/quit'
import type { Chat } from '../src/shared/types'
import type { PushEvent } from '../src/shared/ipc'

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

  it('never asks again once the quit is confirmed', () => {
    for (const reason of reasons) for (const working of [0, 1, 3]) expect(quitStep(working, reason, true)).toBe('quit')
  })
})

describe('quitDialog', () => {
  it('counts agents and makes Cancel the default', () => {
    expect(quitDialog(3, 'user')).toEqual({
      message: '3 agents are working',
      detail: 'Quitting stops them partway through their work.',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    expect(quitDialog(1, 'user').message).toBe('1 agent is working')
    expect(quitDialog(2, 'update').buttons).toEqual(['Restart', 'Cancel'])
  })
})

/** A guard with recorded calls. `answer` is what the dialog returns; `stop` defaults to one that ends at once. */
function guard(o: { working?: number; answer?: boolean | Promise<boolean>; stop?: () => Promise<void>; quiet?: boolean; capMs?: number } = {}) {
  const calls = { asked: [] as QuitDialog[], stops: 0, quits: 0 }
  const g = new QuitGuard({
    working: () => o.working ?? 0,
    ask: async (d) => { calls.asked.push(d); return o.answer ?? false },
    stop: async () => { calls.stops++; await o.stop?.() },
    quit: () => { calls.quits++ },
    quiet: o.quiet,
    capMs: o.capMs
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
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt') }))
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
