import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import type { SessionDeps } from '../src/main/services/sessions'
import { cleanTitle, titleText } from '../src/main/services/titles'
import type { Chat, ChatItem, Workspace } from '../src/shared/types'

const settle = () => new Promise((r) => setTimeout(r, 60))
const until = async (ok: () => boolean, ms = 8000) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) } }

const AGENTS = {
  'README.md': '# x\n',
  '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
}

/** A kernel on a temp repo with the SDK calls stubbed. `answer` is what the naming request returns; `customTitle` is Claude Code's. */
async function setup(o: { dataDir?: string; home?: string; repo?: string; answer?: (text: string, current?: string) => Promise<string | undefined> } = {}) {
  const repo = o.repo ?? await tempRepo(AGENTS)
  const dataDir = o.dataDir ?? await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = o.home ?? await mkdtemp(join(tmpdir(), 'kernel-home-'))
  if (!o.dataDir) await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  const t = {
    k, repo, dataDir, home,
    asked: [] as { text: string; current?: string }[],
    answer: o.answer ?? (async (_text: string, _current?: string): Promise<string | undefined> => 'Named by Kernel'),
    customTitle: undefined as string | undefined,
    infoAsked: [] as string[]
  }
  k.titleFor = async (text, x) => { t.asked.push({ text, current: x.current }); return t.answer(text, x.current) }
  k.sessionInfo = (async (id: string) => { t.infoAsked.push(id); return t.customTitle ? { customTitle: t.customTitle } : undefined }) as typeof k.sessionInfo
  k.refreshPr = (async (id: string) => k.store.workspace(id)!) as typeof k.refreshPr
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  const d = (k.sessions as unknown as { d: SessionDeps }).d
  let n = 0
  const ws = (chatId: string): Workspace => k.store.workspace(k.store.chat(chatId)!.workspaceId)!
  /** One finished turn: the user's message, a reply and the result row, then the turn end Sessions reports. */
  const turn = async (chatId: string, text = `message ${n}`) => {
    n++
    k.store.saveItem(chatId, { kind: 'user', id: `u${n}`, ts: n, parts: [{ type: 'text', text }] })
    k.store.saveItem(chatId, { kind: 'text', id: `m${n}:0`, ts: n, text: `reply ${n}` })
    k.store.saveItem(chatId, { kind: 'result', id: `r${n}`, ts: n, durationMs: 10, ok: true })
    d.onTurnDone!(ws(chatId), k.store.chat(chatId)!, { ok: true, interrupted: false, by: 'user' })
    await settle()
  }
  const reply = async (chatId: string) => { d.onReply!(ws(chatId), k.store.chat(chatId)!); await settle() }
  const reset = async (chatId: string, trigger?: string) => { k.store.clearItems(chatId); d.onReset!(ws(chatId), k.store.chat(chatId)!, trigger); await settle() }
  const chat = (id: string) => k.store.chat(id)!
  return Object.assign(t, { d, turn, reply, reset, chat })
}

/** The Lead workspace's first chat after a message: "New chat", auto-named, with a session. */
async function leadChat(s: Awaited<ReturnType<typeof setup>>): Promise<Chat> {
  const room = await s.k.addRoom(s.repo)
  const c = await s.k.startLeadChat(room.id, { prompt: 'Fix the login bug' })
  return s.k.store.saveChat({ ...s.k.store.chat(c.id)!, sessionId: 'session-1' })
}

describe('chat names (KERNEL-202)', () => {
  it('auto-names placeholder chats only: not a workspace chat, a fork or a big terminal', async () => {
    const s = await setup()
    const room = await s.k.addRoom(s.repo)
    const first = await s.k.leadChat(room.id)
    expect(first).toMatchObject({ title: 'Lead', autoTitle: { turns: 0 } })
    // The first message turns "Lead" into "New chat", and it stays auto-named.
    const started = await s.k.startLeadChat(room.id, { prompt: 'Plan the release' })
    expect(started.id).toBe(first.id)
    expect(s.chat(first.id)).toMatchObject({ title: 'New chat', autoTitle: { turns: 0 } })

    const ws = await s.k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Tabs' })
    const h = s.k.handlers()
    const opened = await h['chats.create']({ workspaceId: ws.id })
    expect(opened).toMatchObject({ title: 'New chat', autoTitle: { turns: 0 } })
    const wsChat = s.k.store.chats(ws.id)[0]
    expect(wsChat.title).toBe('Tabs')
    expect(wsChat.autoTitle).toBeUndefined()
    const fork = await h['chats.fork']({ chatId: wsChat.id })
    expect(fork.autoTitle).toBeUndefined()
    const term = await h['chats.create']({ workspaceId: ws.id, kind: 'terminal' })
    expect(term.autoTitle).toBeUndefined()

    for (const c of [wsChat, fork, term]) await s.turn(c.id)
    expect(s.asked).toEqual([])
    expect(s.chat(wsChat.id).title).toBe('Tabs')
    expect(s.chat(fork.id).title).toBe('Fork of Tabs')
    expect(s.chat(term.id).title).toBe('Terminal (claude)')

    // Closing the last chat opens an auto-named one.
    for (const c of await h['chats.list']({ workspaceId: ws.id })) await h['chats.close']({ chatId: c.id })
    expect((await h['chats.list']({ workspaceId: ws.id }))[0]).toMatchObject({ title: 'New chat', autoTitle: { turns: 0 } })
    await s.k.stop()
  }, 60_000)

  it('names a chat from its conversation at turn 1 when Claude Code wrote no title', async () => {
    const s = await setup()
    const c = await leadChat(s)
    s.answer = async () => 'Fix the login bug'
    await s.turn(c.id, 'The login button does nothing')
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0].current).toBeUndefined()
    expect(s.asked[0].text).toContain('The login button does nothing')
    expect(s.chat(c.id)).toMatchObject({ title: 'Fix the login bug', autoTitle: { turns: 1 } })
    await s.k.stop()
  }, 60_000)

  it("takes Claude Code's title early in the first turn, then passes it as the current name", async () => {
    const s = await setup()
    const c = await leadChat(s)
    s.customTitle = 'Login button fix'
    await s.reply(c.id)
    expect(s.chat(c.id)).toMatchObject({ title: 'Login button fix', autoTitle: { turns: 0 } })
    expect(s.asked).toEqual([])
    s.answer = async (_text, current) => current
    await s.turn(c.id)
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0].current).toBe('Login button fix')
    expect(s.chat(c.id)).toMatchObject({ title: 'Login button fix', autoTitle: { turns: 1 } })
    // Once named, replies don't read the transcript again.
    const reads = s.infoAsked.length
    await s.reply(c.id)
    expect(s.infoAsked).toHaveLength(reads)
    await s.k.stop()
  }, 60_000)

  it('names an auto-named chat again at turns 1, 3, 10 and 30 only, with the current name as a hint', async () => {
    const s = await setup()
    const c = await leadChat(s)
    const at: number[] = []
    s.answer = async () => `Name at ${s.k.store.items(c.id).filter((i) => i.kind === 'result').length}`
    for (let n = 1; n <= 32; n++) {
      const before = s.asked.length
      await s.turn(c.id)
      if (s.asked.length > before) at.push(n)
    }
    expect(at).toEqual([1, 3, 10, 30])
    expect(s.asked.map((a) => a.current)).toEqual([undefined, 'Name at 1', 'Name at 3', 'Name at 10'])
    expect(s.chat(c.id)).toMatchObject({ title: 'Name at 30', autoTitle: { turns: 30 } })
    await s.k.stop()
  }, 60_000)

  it('never changes a name the user typed, even one typed while a request is in flight', async () => {
    const s = await setup()
    const c = await leadChat(s)
    const h = s.k.handlers()
    let release!: (v: string) => void
    s.answer = () => new Promise((r) => { release = r })
    s.k.store.saveItem(c.id, { kind: 'result', id: 'r0', ts: 0, durationMs: 1, ok: true })
    s.d.onTurnDone!(s.k.store.workspace(c.workspaceId)!, s.chat(c.id), { ok: true, interrupted: false, by: 'user' })
    await until(() => s.asked.length === 1)
    const renamed = await h['chats.rename']({ chatId: c.id, title: 'My own name' })
    expect(renamed.autoTitle).toBeUndefined()
    release('Kernel name')
    await settle()
    expect(s.chat(c.id).title).toBe('My own name')
    expect(s.chat(c.id).autoTitle).toBeUndefined()

    // Later turns on the schedule leave it alone, and so does Claude Code's title.
    s.answer = async () => 'Kernel name'
    s.customTitle = 'Claude title'
    for (let n = 0; n < 3; n++) { await s.reply(c.id); await s.turn(c.id) }
    expect(s.asked).toHaveLength(1)
    expect(s.chat(c.id).title).toBe('My own name')
    await s.k.stop()
  }, 60_000)

  it('puts an auto name back to "New chat" on /clear only, and keeps a typed name', async () => {
    const s = await setup()
    const c = await leadChat(s)
    await s.turn(c.id)
    expect(s.chat(c.id)).toMatchObject({ title: 'Named by Kernel', autoTitle: { turns: 1 } })

    for (const trigger of ['plan_mode_exit', 'fresh_session', 'onboarding']) {
      await s.reset(c.id, trigger)
      expect(s.chat(c.id)).toMatchObject({ title: 'Named by Kernel', autoTitle: { turns: 1 } })
    }
    await s.reset(c.id, 'clear')
    expect(s.chat(c.id)).toMatchObject({ title: 'New chat', autoTitle: { turns: 0 } })

    // The old session's title belongs to the old conversation: the /clear turn's end doesn't bring it back.
    s.customTitle = 'Old conversation'
    s.d.onTurnDone!(s.k.store.workspace(c.workspaceId)!, s.chat(c.id), { ok: true, interrupted: false, by: 'user' })
    await settle()
    expect(s.chat(c.id).title).toBe('New chat')

    // The new conversation gets its own name, and the schedule starts over.
    s.k.store.saveChat({ ...s.chat(c.id), sessionId: 'session-2' })
    s.customTitle = undefined
    s.answer = async () => 'The new subject'
    const before = s.asked.length
    await s.turn(c.id)
    expect(s.asked.length).toBe(before + 1)
    expect(s.asked[before].current).toBeUndefined()
    expect(s.chat(c.id)).toMatchObject({ title: 'The new subject', autoTitle: { turns: 1 } })

    // An older emitter sends no trigger, which counts as /clear.
    await s.reset(c.id)
    expect(s.chat(c.id).title).toBe('New chat')

    await s.k.handlers()['chats.rename']({ chatId: c.id, title: 'Mine' })
    await s.reset(c.id, 'clear')
    expect(s.chat(c.id).title).toBe('Mine')
    await s.k.stop()
  }, 60_000)

  it('drops a name for the old conversation that arrives after /clear', async () => {
    const s = await setup()
    const c = await leadChat(s)
    let release!: (v: string) => void
    s.answer = () => new Promise((r) => { release = r })
    s.k.store.saveItem(c.id, { kind: 'result', id: 'r0', ts: 0, durationMs: 1, ok: true })
    s.d.onTurnDone!(s.k.store.workspace(c.workspaceId)!, s.chat(c.id), { ok: true, interrupted: false, by: 'user' })
    await until(() => s.asked.length === 1)
    await s.reset(c.id, 'clear')
    release('About the old conversation')
    await settle()
    expect(s.chat(c.id)).toMatchObject({ title: 'New chat', autoTitle: { turns: 0 } })
    await s.k.stop()
  }, 60_000)

  it('leaves the name when a request fails, and tries again at the next turn end', async () => {
    const s = await setup()
    const c = await leadChat(s)
    s.answer = async () => { throw new Error('timed out') }
    await s.turn(c.id)
    expect(s.chat(c.id)).toMatchObject({ title: 'New chat', autoTitle: { turns: 0 } })
    s.answer = async () => undefined
    await s.turn(c.id)
    expect(s.chat(c.id).title).toBe('New chat')
    s.answer = async () => 'Second try'
    await s.turn(c.id)
    expect(s.asked).toHaveLength(3)
    expect(s.chat(c.id)).toMatchObject({ title: 'Second try', autoTitle: { turns: 3 } })

    // A refresh that fails at 10 is tried again at 11, where it succeeds. 12 is off the schedule.
    s.answer = async () => { throw new Error('offline') }
    for (let n = 4; n <= 10; n++) await s.turn(c.id)
    expect(s.asked).toHaveLength(4)
    s.answer = async () => 'Refreshed'
    await s.turn(c.id)
    await s.turn(c.id)
    expect(s.asked).toHaveLength(5)
    expect(s.chat(c.id)).toMatchObject({ title: 'Refreshed', autoTitle: { turns: 11 } })
    await s.k.stop()
  }, 60_000)

  it('retries a failing refresh once, then waits for the next point on the schedule', async () => {
    const s = await setup()
    const c = await leadChat(s)
    await s.turn(c.id)
    expect(s.chat(c.id)).toMatchObject({ title: 'Named by Kernel', autoTitle: { turns: 1 } })
    s.answer = async () => { throw new Error('model not available') }
    const at: number[] = []
    const run = async (to: number) => {
      for (let n = s.k.store.items(c.id).filter((i) => i.kind === 'result').length + 1; n <= to; n++) {
        const before = s.asked.length
        await s.turn(c.id)
        if (s.asked.length > before) at.push(n)
      }
    }
    await run(10)
    expect(at).toEqual([3, 4, 10])
    await run(40)
    expect(at).toEqual([3, 4, 10, 11, 30, 31])
    expect(s.chat(c.id)).toMatchObject({ title: 'Named by Kernel', autoTitle: { turns: 31 } })
    await s.k.stop()
  }, 60_000)

  it('stops naming a "New chat" after 3 misses in a row, until /clear', async () => {
    const s = await setup()
    const c = await leadChat(s)
    s.answer = async () => undefined
    for (let n = 0; n < 6; n++) await s.turn(c.id)
    expect(s.asked).toHaveLength(3)
    expect(s.chat(c.id)).toMatchObject({ title: 'New chat', autoTitle: { turns: 0 } })
    await s.reset(c.id, 'clear')
    s.k.store.saveChat({ ...s.chat(c.id), sessionId: 'session-2' })
    s.answer = async () => 'After the clear'
    await s.turn(c.id)
    expect(s.asked).toHaveLength(4)
    expect(s.chat(c.id)).toMatchObject({ title: 'After the clear', autoTitle: { turns: 1 } })
    await s.k.stop()
  }, 60_000)

  it('names open chats stuck at "New chat" on start, one at a time', async () => {
    const s = await setup()
    const room = await s.k.addRoom(s.repo)
    const ws = (await s.k.leadChat(room.id)).workspaceId
    const h = s.k.handlers()
    // Chats from before KERNEL-202 have no autoTitle. `turns` is how many finished.
    const legacy = async (o: Partial<Chat>, turns: number) => {
      const { autoTitle: _, ...c } = await h['chats.create']({ workspaceId: ws })
      s.k.store.saveChat({ ...c, ...o })
      s.k.store.saveItem(c.id, { kind: 'user', id: `${c.id}-u`, ts: 1, parts: [{ type: 'text', text: 'Stuck chat' }] })
      for (let n = 0; n < turns; n++) s.k.store.saveItem(c.id, { kind: 'result', id: `${c.id}-r${n}`, ts: 2, durationMs: 1, ok: true })
      return c.id
    }
    const stuck1 = await legacy({ sessionId: 's1' }, 1)
    const stuck2 = await legacy({ sessionId: 's2' }, 2)
    const noTurn = await legacy({ sessionId: 's3' }, 0)
    const noSession = await legacy({}, 1)
    const closed = await legacy({ sessionId: 's4', closed: true }, 1)
    const named = await legacy({ sessionId: 's5', title: 'Already named' }, 1)
    await s.k.stop()

    let live = 0
    let most = 0
    const answer = async () => { live++; most = Math.max(most, live); await new Promise((r) => setTimeout(r, 50)); live--; return 'Recovered name' }
    const again = await setup({ dataDir: s.dataDir, home: s.home, repo: s.repo, answer })
    await until(() => again.asked.length === 2 && again.chat(stuck2).title === 'Recovered name')
    await settle()
    expect(most).toBe(1)
    expect(again.asked.every((a) => a.text === 'User: Stuck chat')).toBe(true)
    expect(again.chat(stuck1)).toMatchObject({ title: 'Recovered name', autoTitle: { turns: 1 } })
    expect(again.chat(stuck2)).toMatchObject({ title: 'Recovered name', autoTitle: { turns: 2 } })
    for (const id of [noTurn, noSession, closed]) expect(again.chat(id).title).toBe('New chat')
    expect(again.chat(named).title).toBe('Already named')
    await again.k.stop()
  }, 60_000)
})

describe('titleText', () => {
  const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, ts: 0, parts: [{ type: 'text', text }] })
  it('keeps the first message and the latest that fit, and drops thinking, tools, notes and results', () => {
    const items: ChatItem[] = [
      user('u1', 'Fix the login bug'),
      { kind: 'thinking', id: 't', ts: 0, text: 'secret thoughts' },
      { kind: 'tool', id: 'x', ts: 0, toolUseId: 'x', name: 'Bash', label: 'Run', detail: 'rm -rf', status: 'done' },
      { kind: 'note', id: 'n', ts: 0, text: 'a note' },
      { kind: 'result', id: 'r', ts: 0, durationMs: 1, ok: true },
      { kind: 'text', id: 'a1', ts: 0, text: 'Looking at it.' },
      ...Array.from({ length: 50 }, (_, i) => user(`m${i}`, `middle message ${i} `.repeat(10))),
      user('last', 'Now the signup page')
    ]
    const text = titleText(items, 1000)
    expect(text.length).toBeLessThanOrEqual(1000)
    expect(text.startsWith('User: Fix the login bug')).toBe(true)
    expect(text.endsWith('User: Now the signup page')).toBe(true)
    expect(text).toContain('...')
    expect(text).not.toMatch(/secret|rm -rf|a note|middle message 0 /)
  })

  it('clips a long latest message instead of dropping it', () => {
    const items: ChatItem[] = [user('u1', 'Fix the login bug'), { kind: 'text', id: 'a1', ts: 0, text: 'x'.repeat(20_000) }, user('u2', 'y'.repeat(20_000))]
    const text = titleText(items)
    expect(text.length).toBeLessThanOrEqual(8000)
    expect(text).toMatch(/^User: Fix the login bug\n\nAssistant: x+\n\nUser: y+$/)
    const many = titleText([user('u1', 'first'), ...Array.from({ length: 40 }, (_, i) => user(`m${i}`, 'z'.repeat(5000)))])
    expect(many.length).toBeLessThanOrEqual(8000)
    expect(many).toContain('\n\n...\n\n')
  })

  it('shows files and issues by name', () => {
    const text = titleText([{ kind: 'user', id: 'u', ts: 0, parts: [{ type: 'text', text: 'Look at' }, { type: 'file', name: 'login.ts', text: 'the whole file' }, { type: 'issue', name: 'KERNEL-83', title: 'Login fails', source: 'linear' }] }])
    expect(text).toBe('User: Look at [file login.ts] [issue KERNEL-83: Login fails]')
    expect(titleText([{ kind: 'text', id: 'a', ts: 0, text: 'hi' }])).toBe('')
  })
})

describe('cleanTitle', () => {
  it('takes the first line without quotes, markdown, a prefix or a closing period', () => {
    expect(cleanTitle('\n  "Fix the login bug."  \nBecause...')).toBe('Fix the login bug')
    expect(cleanTitle('**Title:** Release checklist')).toBe('Release checklist')
    expect(cleanTitle('# Chat name: `Usage meters`')).toBe('Usage meters')
    expect(cleanTitle('Name: “Sidebar polish”!')).toBe('Sidebar polish')
    expect(cleanTitle('Fix the parse_args flag')).toBe('Fix the parse_args flag')
    expect(cleanTitle('__Snake_case cleanup__')).toBe('Snake_case cleanup')
  })

  it('caps at 60 characters on a word and refuses empty answers', () => {
    const long = cleanTitle('A very long name that goes on and on about many different things at once')!
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long).toBe('A very long name that goes on and on about many different')
    expect(cleanTitle('')).toBeUndefined()
    expect(cleanTitle('  \n ')).toBeUndefined()
    expect(cleanTitle('"New chat"')).toBeUndefined()
  })
})
