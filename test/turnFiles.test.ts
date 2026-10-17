import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, ChatItem, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { tempRepo, freePort } from './helpers'
import { fakeCodex } from './helpers/fakeCodex'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'

// KERNEL-584: a turn's result row lists the files the turn changed, read from the checkpoint taken when it ends.

// A scripted query(), as in restore.test.ts: each one yields what the test feeds it, and an interrupt ends the turn with
// error_during_execution, as the real one does. The rest of the SDK stays real, since Codex reads Kernel's tools from it.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: { abortController?: AbortController } }) => {
    const items: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    const signal = options.abortController?.signal
    const aborted = () => new Error('Claude Code process aborted by user')
    signal?.addEventListener('abort', () => { for (const w of waiters.splice(0)) w.reject(aborted()) })
    const feed = (m: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: m, done: false }); else items.push(m) }
    sdk.calls.push({ options, feed })
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
          : signal?.aborted ? Promise.reject(aborted()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
      }),
      interrupt: async () => feed({ type: 'result', subtype: 'error_during_execution', uuid: `i${sdk.calls.length}`, duration_ms: 1 }),
      setModel: async () => {}, setPermissionMode: async () => {}, applyFlagSettings: async () => {}
    }
  }
}))

const REPO = {
  'README.md': '# client\n',
  'src/table.tsx': 'export const Table = () => null\n',
  'src/old.ts': 'a\nb\n',
  '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.'
}
const text = (t: string) => [{ type: 'text' as const, text: t }]

/** A Kernel on a temp data folder, with GitHub and naming stubbed. `pushed` collects the result rows pushed to the renderer. */
async function kernel(where: { dataDir: string; home: string }) {
  const k = new Kernel(where)
  await k.start()
  k.chats.titleFor = async () => undefined
  k.github = { info: async () => null, merge: async () => undefined, ready: async () => undefined, reopen: async () => undefined }
  const pushed: { chatId: string; item: ChatItem }[] = []
  const onPush = (e: PushEvent) => { if (e.type === 'chat.item' && e.item.kind === 'result') pushed.push({ chatId: e.chatId, item: e.item }) }
  bus.on('push', onPush)
  onTestFinished(() => { bus.off('push', onPush) })
  return { k, pushed }
}

async function dirs() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  return { dataDir, home }
}

const results = (k: Kernel, chatId: string) => k.store.items(chatId).filter((i): i is ChatItem & { kind: 'result' } => i.kind === 'result')
/** Once the checkpoint of the turn that just ended is saved, and its files are on the result row. */
async function saved(k: Kernel, ws: Workspace, count: number) {
  await vi.waitFor(async () => expect(await k.handlers()['checkpoints.list']({ workspaceId: ws.id })).toHaveLength(count), { timeout: 10_000, interval: 20 })
  await k.checkpoints.settled(ws.id)
}

describe('the files a turn changed (KERNEL-584)', () => {
  it('a Claude turn lists what it added, edited and deleted under its reply, and keeps them after a restart', async () => {
    const where = await dirs()
    const { k, pushed } = await kernel(where)
    const project = await k.addProject(await tempRepo(REPO))
    const ws = await k.createWorkspace(project.id, { prompt: 'Build the table', agentId: 'christian', title: 'Invoice table' })
    const chat = k.store.chats(ws.id)[0]
    await vi.waitFor(() => expect(sdk.calls.find((c) => c.options.cwd === ws.path)).toBeDefined())
    const call = sdk.calls.find((c) => c.options.cwd === ws.path)!
    call.feed({ type: 'system', subtype: 'init', session_id: 'christian-session', apiKeySource: 'none' })

    // The turn's edits are made by Bash, which no Edit or Write tool call would show.
    await writeFile(join(ws.path, 'src/table.tsx'), 'export const Table = () => <table />\nexport const Row = () => <tr />\n')
    await rm(join(ws.path, 'src/old.ts'))
    await writeFile(join(ws.path, 'src/empty.tsx'), 'export const Empty = () => null\n')
    call.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node scripts/gen.js' } }] } })
    call.feed({ type: 'assistant', uuid: 'a2', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Built the table.' }] } })
    call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 1 })
    await saved(k, ws, 2)

    const files = [
      { path: 'src/empty.tsx', status: 'A', added: 1, removed: 0 },
      { path: 'src/old.ts', status: 'D', added: 0, removed: 2 },
      { path: 'src/table.tsx', status: 'M', added: 2, removed: 1 }
    ]
    expect(results(k, chat.id)).toMatchObject([{ id: 'r1', ok: true, files }])
    expect(pushed.filter((p) => p.chatId === chat.id).map((p) => p.item)).toMatchObject([{ id: 'r1' }, { id: 'r1', files }])
    const order = k.store.items(chat.id).map((i) => i.id)
    expect(order.at(-1)).toBe('r1')

    // A turn that changed nothing gets no files.
    await k.sessions.send(chat.id, text('Does it build?'))
    call.feed({ type: 'result', subtype: 'success', uuid: 'r2', duration_ms: 1 })
    await saved(k, ws, 3)
    expect(results(k, chat.id).map((r) => [r.id, r.files?.length])).toEqual([['r1', 3], ['r2', undefined]])

    // A stopped turn has no result row, so its files go nowhere: not on the turn before it.
    await k.sessions.send(chat.id, text('Add a footer'))
    await writeFile(join(ws.path, 'src/footer.tsx'), 'x\n')
    await k.sessions.interrupt(chat.id)
    await saved(k, ws, 4)
    expect(results(k, chat.id).map((r) => [r.id, r.files?.length])).toEqual([['r1', 3], ['r2', undefined]])

    // Nor does the checkpoint taken before discarding changes.
    await vi.waitFor(() => expect(k.sessions.isRunning(chat.id)).toBe(false))
    await writeFile(join(ws.path, 'src/scratch.ts'), 'y\n')
    await k.handlers()['workspaces.discard']({ workspaceId: ws.id })
    expect((await k.handlers()['checkpoints.list']({ workspaceId: ws.id }))[0].title).toBe('Before discarding changes')
    expect(results(k, chat.id).map((r) => [r.id, r.files?.length])).toEqual([['r1', 3], ['r2', undefined]])
    const before = k.store.items(chat.id).map((i) => i.id)
    await k.stop()

    // The files are stored on the row, which keeps its place in the transcript.
    const { k: k2 } = await kernel(where)
    onTestFinished(() => k2.stop({ budgetMs: 0 }))
    expect(k2.store.items(chat.id).map((i) => i.id)).toEqual(before)
    expect(before.indexOf('r1')).toBe(order.length - 1)
    expect(results(k2, chat.id)[0].files).toEqual(files)
  }, 30000)

  describe('a Codex chat', () => {
    const env = { log: process.env.FAKE_CODEX_LOG, codexHome: process.env.CODEX_HOME }
    let fake: Awaited<ReturnType<typeof fakeCodex>>
    beforeEach(async () => { fake = await fakeCodex(); process.env.FAKE_CODEX_LOG = fake.log; delete process.env.CODEX_HOME })
    afterEach(() => {
      for (const [name, value] of [['FAKE_CODEX_LOG', env.log], ['CODEX_HOME', env.codexHome]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    })

    it('lists the files its turn changed the same way', async () => {
      const where = await dirs()
      await mkdir(join(where.home, '.codex', 'skills'), { recursive: true })
      await writeFile(join(where.home, '.codex', 'config.toml'), 'model = "gpt-6-astra"\n')
      const { k } = await kernel(where)
      onTestFinished(() => k.stop({ budgetMs: 0 }))
      await k.providers.setPath('codex', { path: fake.bin })
      const repo = await tempRepo(REPO)
      const project = await k.addProject(repo)
      const ws: Workspace = { id: 'ws-codex', projectId: project.id, name: 'w', branch: 'b', baseRef: 'main', path: repo, mode: 'worktree', agentId: 'christian', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
      k.store.saveWorkspace(ws)
      const chat: Chat = { id: 'codex', workspaceId: ws.id, title: 'x', kind: 'chat', provider: 'codex', model: 'gpt-6-astra', effort: 'low', plan: false, createdAt: 1 }
      k.store.saveChat(chat)

      await writeFile(join(repo, 'README.md'), '# client\n\nInvoices.\n')
      await writeFile(join(repo, 'src/empty.tsx'), 'export const Empty = () => null\n')
      await k.sessions.send(chat.id, text('Build the table'))
      await saved(k, ws, 1)
      expect(results(k, chat.id)).toMatchObject([{ ok: true, files: [{ path: 'README.md', status: 'M', added: 2, removed: 0 }, { path: 'src/empty.tsx', status: 'A', added: 1, removed: 0 }] }])

      await k.sessions.send(chat.id, text('Does it build?'))
      await saved(k, ws, 2)
      expect(results(k, chat.id).map((r) => r.files?.length)).toEqual([2, undefined])
    }, 30000)
  })
})
