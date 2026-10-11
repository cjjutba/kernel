import { describe, expect, it, onTestFinished } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, trustRoom } from './helpers'
import { Kernel } from '../src/main/kernel'
import { run } from '../src/main/services/exec'
import type { Chat, ChatItem, ChatPart } from '../src/shared/types'

// KERNEL-346: Fork into new workspace, from the "..." menu under a reply.

const KAI = '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
const ROWAN = '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.'

const until = async (ok: () => boolean, ms = 8000) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) } }
const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args]).then((s) => s.replace(/\s+$/, ''))

async function setup(files: Record<string, string> = {}) {
  const repo = await tempRepo({ 'README.md': '# x\n', 'a.txt': 'one\n', '.claude/agents/kai.md': KAI, '.claude/agents/rowan.md': ROWAN, ...files })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop().catch(() => undefined))
  k.sessions.send = async () => ({ queued: false })
  // Anything that would start a turn lands here instead.
  const dispatched: string[] = []
  ;(k.sessions as unknown as { dispatch: (chat: Chat, parts: ChatPart[]) => void }).dispatch = (chat) => { dispatched.push(chat.id) }
  const forks: unknown[] = []
  k.forkSession = (async (id: string, o: unknown) => { forks.push([id, o]); return { sessionId: 'forked-session' } }) as typeof k.forkSession
  const deletedSessions: string[] = []
  k.deleteSession = (async (id: string) => { deletedSessions.push(id) }) as typeof k.deleteSession
  const room = await k.addRoom(repo)
  if (files['.kernel/settings.toml']) await trustRoom(k, room.id)
  const src = await k.createWorkspace(room.id, { prompt: 'Build the home screen', agentId: 'kai', title: 'Home screen' })
  const chat = k.store.saveChat({ ...k.store.chats(src.id)[0], title: 'Home screen', sessionId: 'src-session' })
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', ts: 1, parts: [{ type: 'text', text: 'Build the home screen' }] },
    { kind: 'text', id: 'm1:0', ts: 2, text: 'Built it.' },
    { kind: 'result', id: 'r1', ts: 3, durationMs: 4000, ok: true },
    { kind: 'user', id: 'u2', ts: 4, parts: [{ type: 'text', text: 'Now the empty state' }] },
    { kind: 'text', id: 'm2:0', ts: 5, text: 'Added it.' },
    { kind: 'result', id: 'r2', ts: 6, durationMs: 3000, ok: true }
  ]
  for (const i of items) k.store.saveItem(chat.id, i)
  return { k, repo, room, src, chat, dispatched, forks, deletedSessions }
}

describe('fork into new workspace (KERNEL-346)', () => {
  it("starts a worktree at the source's HEAD with its files as they are now, forks the chat into it and sends nothing", async () => {
    const { k, repo, src, chat, dispatched, forks } = await setup()
    // The source's work so far: a commit, an edit, a new file and a deletion that nobody committed.
    await writeFile(join(src.path, 'b.txt'), 'committed\n')
    await git(src.path, 'add', '-A')
    await git(src.path, 'commit', '-q', '-m', 'work')
    await writeFile(join(src.path, 'a.txt'), 'edited\n')
    await writeFile(join(src.path, 'new.txt'), 'untracked\n')
    await rm(join(src.path, 'README.md'))
    const before = await git(src.path, 'status', '--porcelain')

    const ws = await k.handlers()['workspaces.fork']({ chatId: chat.id, itemId: 'u2' })

    expect(ws).toMatchObject({ roomId: src.roomId, agentId: 'kai', mode: 'worktree', baseRef: src.baseRef, branch: `${src.branch}-fork`, name: `${src.name}-fork`, title: 'Home screen' })
    expect(ws.path).not.toBe(src.path)
    expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(await git(src.path, 'rev-parse', 'HEAD'))
    expect(await readFile(join(ws.path, 'a.txt'), 'utf8')).toBe('edited\n')
    expect(await readFile(join(ws.path, 'b.txt'), 'utf8')).toBe('committed\n')
    expect(await readFile(join(ws.path, 'new.txt'), 'utf8')).toBe('untracked\n')
    expect(existsSync(join(ws.path, 'README.md'))).toBe(false)
    // The copied changes are uncommitted in the fork too, and the source keeps its own.
    expect((await git(ws.path, 'status', '--porcelain')).split('\n').sort()).toEqual([' D README.md', ' M a.txt', '?? new.txt'])
    expect(await git(src.path, 'status', '--porcelain')).toBe(before)
    expect(await git(repo, 'branch', '--list', ws.branch)).not.toBe('')

    // The chat is forked into it up to the reply before u2, from the session in the source's folder.
    const chats = k.store.chats(ws.id)
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({ title: 'Fork of Home screen', sessionId: 'forked-session', forkOf: { chatId: chat.id } })
    expect(forks).toEqual([['src-session', { dir: src.path, upToMessageId: 'm1', title: 'Fork of Home screen' }]])
    const copied = k.store.items(chats[0].id)
    expect(copied.filter((i) => i.kind !== 'note')).toHaveLength(2)
    expect(copied.at(-1)).toMatchObject({ kind: 'note', text: expect.stringMatching(/^Forked from home-screen, with its files as they were at \d\d:\d\d\.$/) })

    // Setup runs as for any workspace, then the chat waits for the user: nothing is sent or queued.
    await until(() => k.store.workspace(ws.id)?.status === 'ready')
    expect(k.sessions.waitsFor(chats[0].id)).toBeUndefined()
    expect(k.sessions.queued(chats[0].id)).toEqual([])
    expect(dispatched).toEqual([])
    expect(k.store.chats(src.id).map((c) => c.id)).toEqual([chat.id])

    // A second fork takes the next free branch and name.
    const again = await k.handlers()['workspaces.fork']({ chatId: chat.id })
    expect(again).toMatchObject({ branch: `${src.branch}-fork-2`, name: `${src.name}-fork-2` })
    await until(() => k.store.workspace(again.id)?.status === 'ready')
  })

  it("holds the fork's chat until setup passes", async () => {
    const { k, chat } = await setup()
    const ws = await k.workspaces.forkWorkspace(chat.id)
    const fork = k.store.chats(ws.id)[0]
    // During setup a message waits, the way a brief does.
    expect(k.sessions.waitsFor(fork.id)).toBe('setup')
    await until(() => k.store.workspace(ws.id)?.status === 'ready')
    expect(k.sessions.waitsFor(fork.id)).toBeUndefined()
  })

  it('waits for trust like any new workspace, and what was typed meanwhile goes out once setup passes', async () => {
    const { k, repo, room, chat, dispatched } = await setup({ '.kernel/settings.toml': '[scripts]\nsetup = "echo ran > ran.txt"\n', '.gitignore': 'ran.txt\n' })
    // The setup text changes after the source started, so nobody has trusted it yet.
    await writeFile(join(repo, '.kernel/settings.toml'), '[scripts]\nsetup = "echo again > ran.txt"\n')
    const ws = await k.workspaces.forkWorkspace(chat.id)
    await until(() => k.store.workspace(ws.id)?.status === 'trust')
    expect(existsSync(join(ws.path, 'ran.txt'))).toBe(false)
    // The composer stays open while the room waits for trust. A message waits instead of starting the agent.
    delete (k.sessions as unknown as { send?: unknown }).send
    const fork = k.store.chats(ws.id)[0]
    expect(await k.sessions.send(fork.id, [{ type: 'text', text: 'Try the other layout' }])).toMatchObject({ queued: true, why: 'setup' })
    expect(dispatched).toEqual([])

    await trustRoom(k, room.id)
    await until(() => k.store.workspace(ws.id)?.status === 'ready', 15000)
    expect(await readFile(join(ws.path, 'ran.txt'), 'utf8')).toBe('again\n')
    await until(() => dispatched.includes(fork.id))
    expect(dispatched).toEqual([fork.id])
  }, 30000)

  it("refuses a big terminal, the Lead's workspace and an archived workspace", async () => {
    const { k, room, src } = await setup()
    const term = await k.handlers()['chats.create']({ workspaceId: src.id, kind: 'terminal' })
    await expect(k.workspaces.forkWorkspace(term.id)).rejects.toThrow('cannot be forked')
    const lead = await k.handlers()['lead.open']({ roomId: room.id })
    const leadChat = k.store.chats(lead.id).find((c) => c.kind === 'chat')!
    await expect(k.workspaces.forkWorkspace(leadChat.id)).rejects.toThrow('Only a workspace with its own worktree')
    const other = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Other' })
    await k.archiveWorkspace(other.id, false)
    await expect(k.workspaces.forkWorkspace(k.store.chats(other.id)[0].id)).rejects.toThrow('Restore the workspace')
  })

  it('leaves no workspace or branch behind when the session cannot fork, and drops the session when the worktree fails', async () => {
    const { k, repo, room, src, chat, deletedSessions } = await setup()
    const count = () => k.store.workspaces(room.id).length
    const before = count()
    k.forkSession = (async () => { throw new Error('Session src-session not found') }) as typeof k.forkSession
    await expect(k.workspaces.forkWorkspace(chat.id)).rejects.toThrow('not found')
    expect(count()).toBe(before)
    expect(await git(repo, 'branch', '--list', `${src.branch}-fork`)).toBe('')

    // A branch name git refuses fails the worktree after the session forked: the forked session goes too.
    k.forkSession = (async () => ({ sessionId: 'orphan' })) as typeof k.forkSession
    k.store.saveWorkspace({ ...k.store.workspace(src.id)!, branch: 'bad..name' })
    await expect(k.workspaces.forkWorkspace(chat.id)).rejects.toThrow()
    expect(count()).toBe(before)
    expect(deletedSessions).toEqual(['orphan'])
  })
})
