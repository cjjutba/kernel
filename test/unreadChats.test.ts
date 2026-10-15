import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, freePort } from './helpers'
import { Kernel } from '../src/main/kernel'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { sessionDeps } from '../src/main/features/sessionDeps'
import type { Chat } from '../src/shared/types'
import type { PushEvent } from '../src/shared/ipc'

// KERNEL-507: a finished turn marks its chat unread, and the renderer clears it with chats.markRead.

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
}

/** Kai's workspace on a temp repo, with GitHub, naming and sends stubbed. `pushed` collects the chat pushes for Kai's chat. */
async function setup() {
  const repo = await tempRepo(REPO)
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop())
  k.sessions.send = async () => ({ queued: false })
  k.chats.titleFor = async () => undefined
  k.github = { info: async () => null, merge: async () => undefined, ready: async () => undefined, reopen: async () => undefined }
  const project = await k.addProject(repo)
  const ws = await k.createWorkspace(project.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
  const chatId = k.store.chats(ws.id)[0].id
  const pushed: Chat[] = []
  const onPush = (e: PushEvent) => { if (e.type === 'chat' && e.chat.id === chatId) pushed.push(e.chat) }
  bus.on('push', onPush)
  onTestFinished(() => { bus.off('push', onPush) })
  const chat = () => k.store.chat(chatId)!
  /** A turn ends the way Sessions reports it. The reactions that run git and read the PR finish before the test goes on. */
  const turnDone = async (interrupted = false) => {
    sessionDeps(k).onTurnDone!(k.store.workspace(ws.id)!, chat(), { ok: !interrupted, interrupted, by: 'user' })
    await new Promise((r) => setTimeout(r, 200))
  }
  return { k, dataDir, chatId, chat, pushed, turnDone, markRead: () => k.handlers()['chats.markRead']({ chatId }) }
}

describe('unread chats (KERNEL-507)', () => {
  it('a finished turn marks its chat unread and pushes it, and markRead clears it and pushes it', async () => {
    const s = await setup()
    expect(s.chat().unreadAt).toBeUndefined()
    const before = Date.now()
    await s.turnDone()
    expect(s.chat().unreadAt).toBeGreaterThanOrEqual(before)
    expect(s.pushed.at(-1)?.unreadAt).toBe(s.chat().unreadAt)

    s.pushed.length = 0
    expect(await s.markRead()).toEqual({ ok: true })
    expect(s.chat().unreadAt).toBeUndefined()
    expect(s.pushed).toHaveLength(1)
    expect(s.pushed[0].unreadAt).toBeUndefined()
  }, 30_000)

  it('markRead on a chat that is already read changes nothing and pushes nothing', async () => {
    const s = await setup()
    const read = s.chat()
    expect(read.unreadAt).toBeUndefined()
    s.pushed.length = 0
    expect(await s.markRead()).toEqual({ ok: true })
    expect(s.chat()).toEqual(read)
    expect(s.pushed).toEqual([])
  }, 30_000)

  it('a turn the user stopped leaves the chat as it was', async () => {
    const s = await setup()
    await s.turnDone(true)
    expect(s.chat().unreadAt).toBeUndefined()
    expect(s.pushed.some((c) => c.unreadAt !== undefined)).toBe(false)

    // A stop doesn't clear what an earlier turn marked either: only markRead does.
    await s.turnDone()
    const unreadAt = s.chat().unreadAt
    expect(unreadAt).toBeDefined()
    await s.turnDone(true)
    expect(s.chat().unreadAt).toBe(unreadAt)
  }, 30_000)

  it('the flag survives a store reload, and a chat saved without it reads as read', async () => {
    const s = await setup()
    await s.turnDone()
    const unreadAt = s.chat().unreadAt
    expect(unreadAt).toBeDefined()
    // A second chat stored the way chats were before KERNEL-507, with no flag.
    const { unreadAt: _, ...old } = s.chat()
    s.k.store.saveChat({ ...old, id: 'old-chat' })
    await s.k.stop()

    const again = new Store(join(s.dataDir, 'kernel.db'))
    expect(again.chat(s.chatId)?.unreadAt).toBe(unreadAt)
    expect(again.chat('old-chat')).toBeDefined()
    expect(again.chat('old-chat')?.unreadAt).toBeUndefined()
  }, 30_000)
})
