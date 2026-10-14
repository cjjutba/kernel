import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, setUp } from './helpers'
import { Kernel } from '../src/main/kernel'
import { run } from '../src/main/services/exec'
import { snapshot } from '../src/main/services/checkpoints'
import type { Workspace } from '@shared/types'

// A chat with Kernel's held first message goes out through the real send once its setup passes (KERNEL-405).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// KERNEL-333: Delete in History forgets archived workspaces with their branches, checkpoints and Claude Code transcripts.

const KAI = '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
const KERNEL = '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.'

async function setup() {
  const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/kai.md': KAI, '.claude/agents/kernel.md': KERNEL })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop().catch(() => undefined))
  k.sessions.send = async () => ({ queued: false })
  const room = await k.addRoom(repo)

  // The Claude Code side, in memory: `onDisk` is what each folder holds, and what a delete took is in `deleted`.
  const onDisk: Record<string, { sessionId: string; fileSize: number }[]> = {}
  const listed: (string | undefined)[] = []
  const deleted: [string, string | undefined][] = []
  const fails = new Set<string>()
  k.listSessions = (async (o?: { dir?: string }) => { listed.push(o?.dir); return (onDisk[o?.dir ?? ''] ?? []).map((s) => ({ ...s, summary: 'x', lastModified: 1 })) }) as typeof k.listSessions
  // With no dir the SDK looks in every folder.
  const folderOf = (id: string, dir?: string) => dir !== undefined ? dir : Object.keys(onDisk).find((d) => onDisk[d].some((s) => s.sessionId === id)) ?? ''
  k.sessionInfo = (async (id: string, o?: { dir?: string }) => {
    const s = (onDisk[folderOf(id, o?.dir)] ?? []).find((x) => x.sessionId === id)
    return s ? { ...s, summary: 'x', lastModified: 1 } : undefined
  }) as typeof k.sessionInfo
  k.deleteSession = (async (id: string, o?: { dir?: string }) => {
    if (fails.has(id)) throw new Error('EACCES: permission denied')
    const dir = folderOf(id, o?.dir)
    const list = onDisk[dir] ?? []
    if (!list.some((s) => s.sessionId === id)) throw new Error(`Session ${id} not found in project directory for ${o?.dir}`)
    onDisk[dir] = list.filter((s) => s.sessionId !== id)
    deleted.push([id, o?.dir])
  }) as typeof k.deleteSession

  const refs = async (prefix: string) => (await run('git', ['-C', repo, 'for-each-ref', '--format=%(refname)', prefix])).trim().split('\n').filter(Boolean)
  const hasBranch = async (name: string) => (await run('git', ['-C', repo, 'branch', '--list', name])).trim() !== ''

  /**
   * A workspace that was archived with its branch kept, as it sits in History. It has a checkpoint, a transcript line, a chat
   * that remembers a session, and one more session on disk that the chat forgot. `commit` leaves a commit nobody has pushed.
   */
  async function archived(title: string, o: { commit?: boolean; merged?: boolean } = {}) {
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title })
    if (o.commit) {
      await writeFile(join(ws.path, `${title}.ts`), 'work\n')
      await run('git', ['-C', ws.path, 'add', '-A'])
      await run('git', ['-C', ws.path, 'commit', '-q', '-m', `work on ${title}`])
    }
    const chat = k.store.chats(ws.id)[0]
    k.store.saveChat({ ...chat, sessionId: `${title}-now` })
    k.store.saveItem(chat.id, { kind: 'text', id: `${title}-line`, ts: 1, text: 'hello' })
    await snapshot(ws, { chatId: chat.id, title: 'Go', start: true })
    onDisk[ws.path] = [{ sessionId: `${title}-now`, fileSize: 1000 }, { sessionId: `${title}-forgotten`, fileSize: 250 }]
    await k.archiveWorkspace(ws.id, false)
    await k.archive.cleanedUp(ws.id)
    if (o.merged) k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prState: 'merged' })
    return k.store.workspace(ws.id)!
  }

  return { k, repo, room, onDisk, listed, deleted, fails, refs, hasBranch, archived }
}

describe('deleting workspaces from History', () => {
  it('forgets a merged workspace: its branch, checkpoints, rows and every transcript, and reports the bytes', async () => {
    const { k, room, refs, hasBranch, archived, deleted } = await setup()
    // Merged by squash, so git still counts its commit as unpushed.
    const a = await archived('merged-work', { commit: true, merged: true })
    const keep = await archived('other')
    expect(await hasBranch(a.branch)).toBe(true)
    expect(await refs(`refs/kernel/checkpoints/${a.id}/`)).not.toEqual([])
    expect(await refs(`refs/kernel/checkpoint-head/${a.id}`)).toHaveLength(1)

    const r = await k.deleteWorkspaces([a.id], { deleteUnpushed: false })

    expect(r).toEqual({ deleted: [a.id], skipped: [], keptBranches: 0, freedBytes: 1250 })
    expect(await hasBranch(a.branch)).toBe(false)
    expect(await refs(`refs/kernel/checkpoints/${a.id}/`)).toEqual([])
    expect(await refs(`refs/kernel/checkpoint-head/${a.id}`)).toEqual([])
    expect(k.store.workspace(a.id)).toBeUndefined()
    expect(k.store.chats(a.id)).toEqual([])
    expect(deleted.map(([id]) => id).sort()).toEqual(['merged-work-forgotten', 'merged-work-now'])
    expect(deleted.every(([, dir]) => dir === a.path)).toBe(true)
    // The other archived workspace, in the same room, is untouched.
    expect(k.store.workspace(keep.id)?.status).toBe('archived')
    expect(await refs(`refs/kernel/checkpoints/${keep.id}/`)).not.toEqual([])
    expect(k.store.items(k.store.chats(keep.id)[0].id)).toHaveLength(1)
    expect(k.store.room(room.id)).toBeDefined()
  })

  it("keeps a session a forked workspace still uses, and finds the fork's own in the source's folder (KERNEL-346)", async () => {
    const { k, room, onDisk, deleted, archived } = await setup()
    const src = await archived('source')
    // Fork into new workspace leaves the forked session in the source worktree's project folder, next to the source's own.
    onDisk[src.path].push({ sessionId: 'fork-session', fileSize: 500 })
    const fork = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'source-fork' })
    k.store.saveChat({ ...k.store.chats(fork.id)[0], sessionId: 'fork-session' })

    expect(await k.deleteWorkspaces([src.id], { deleteUnpushed: false })).toMatchObject({ deleted: [src.id], freedBytes: 1250 })
    expect(deleted.map(([id]) => id).sort()).toEqual(['source-forgotten', 'source-now'])
    expect(onDisk[src.path]).toEqual([{ sessionId: 'fork-session', fileSize: 500 }])

    // Deleting the fork later finds its session there, though its own folder has none.
    await k.archiveWorkspace(fork.id, false)
    await k.archive.cleanedUp(fork.id)
    expect(await k.deleteWorkspaces([fork.id], { deleteUnpushed: false })).toMatchObject({ deleted: [fork.id], freedBytes: 500 })
    expect(deleted.at(-1)).toEqual(['fork-session', undefined])
    expect(onDisk[src.path]).toEqual([])
  })

  it('keeps a branch whose commits are pushed nowhere, and deletes it when asked', async () => {
    const { k, hasBranch, archived } = await setup()
    const empty = await archived('nothing-new')
    const kept = await archived('unpushed-one', { commit: true })
    const asked = await archived('unpushed-two', { commit: true })

    const first = await k.deleteWorkspaces([empty.id, kept.id], { deleteUnpushed: false })
    expect(first.deleted).toEqual([empty.id, kept.id])
    expect(first.keptBranches).toBe(1)
    expect(await hasBranch(empty.branch)).toBe(false)
    expect(await hasBranch(kept.branch)).toBe(true)
    // The record goes either way: only the branch stays.
    expect(k.store.workspace(kept.id)).toBeUndefined()

    const second = await k.deleteWorkspaces([asked.id], { deleteUnpushed: true })
    expect(second).toMatchObject({ deleted: [asked.id], keptBranches: 0 })
    expect(await hasBranch(asked.branch)).toBe(false)
  })

  it('keeps a branch another workspace record still uses, until that one goes too', async () => {
    const { k, hasBranch, archived } = await setup()
    const a = await archived('reviewed', { commit: true, merged: true })
    // A review workspace shares the reviewed branch (KERNEL-265).
    const review: Workspace = { ...a, id: 'review-of-reviewed', name: 'review-reviewed', reviewOf: a.id, path: `${a.path}-review` }
    k.store.saveWorkspace(review)

    const first = await k.deleteWorkspaces([a.id], { deleteUnpushed: true })
    expect(first).toMatchObject({ deleted: [a.id], keptBranches: 0 })
    expect(await hasBranch(a.branch)).toBe(true)

    await k.deleteWorkspaces([review.id], { deleteUnpushed: false })
    expect(await hasBranch(a.branch)).toBe(false)
  })

  it('counts a branch shared by workspaces deleted together once, and a session once', async () => {
    const { k, hasBranch, archived, onDisk, deleted } = await setup()
    const a = await archived('twin', { commit: true })
    const b: Workspace = { ...a, id: 'twin-review', name: 'twin-review', reviewOf: a.id }
    k.store.saveWorkspace(b)
    expect(onDisk[a.path]).toHaveLength(2)

    const p = await k.deletePreview([a.id, b.id])
    expect(p).toMatchObject({ workspaces: 2, unpushedBranches: 1, transcriptBytes: 1250 })
    const r = await k.deleteWorkspaces([a.id, b.id], { deleteUnpushed: false })
    expect(r).toMatchObject({ deleted: [a.id, b.id], keptBranches: 1, freedBytes: 1250 })
    expect(await hasBranch(a.branch)).toBe(true)
    expect(deleted).toHaveLength(2)
  })

  it('deletes only the recorded sessions of a current-branch workspace and never lists the main checkout', async () => {
    const { k, repo, room, onDisk, listed, deleted, hasBranch, archived } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'on main' })
    const chat = k.store.chats(ws.id)[0]
    k.store.saveChat({ ...chat, sessionId: 'mine' })
    k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, mode: 'current', path: repo, branch: 'main', status: 'archived', archivedAt: 1 })
    // The main checkout also holds the user's own sessions, and this workspace's recorded one.
    onDisk[repo] = [{ sessionId: 'users-own', fileSize: 9_000_000 }, { sessionId: 'mine', fileSize: 400 }]
    await archived('bystander')
    listed.length = 0

    const p = await k.deletePreview([ws.id])
    expect(p).toMatchObject({ workspaces: 1, unpushedBranches: 0, transcriptBytes: 400 })
    const r = await k.deleteWorkspaces([ws.id], { deleteUnpushed: true })

    expect(r).toEqual({ deleted: [ws.id], skipped: [], keptBranches: 0, freedBytes: 400 })
    expect(deleted).toEqual([['mine', repo]])
    expect(listed).not.toContain(repo)
    expect(onDisk[repo].map((s) => s.sessionId)).toEqual(['users-own'])
    // main is the room's branch, whatever deleteUnpushed says.
    expect(await hasBranch('main')).toBe(true)
  })

  it('skips a workspace a live workspace still waits on, with a reason', async () => {
    const { k, room, hasBranch, archived } = await setup()
    const a = await archived('waited-on', { commit: true, merged: true })
    const free = await archived('free')
    const waiter = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Waiter' })
    k.store.saveWorkspace({ ...k.store.workspace(waiter.id)!, waitsFor: { on: [a.id], held: true } })

    const p = await k.deletePreview([a.id, free.id])
    expect(p.workspaces).toBe(1)
    expect(p.skipped).toEqual([{ id: a.id, name: a.name, reason: expect.stringMatching(/^.+'s workspace still waits on it\.$/) }])
    const r = await k.deleteWorkspaces([a.id, free.id], { deleteUnpushed: false })

    expect(r.deleted).toEqual([free.id])
    expect(r.skipped).toEqual(p.skipped)
    expect(k.store.workspace(a.id)?.status).toBe('archived')
    expect(await hasBranch(a.branch)).toBe(true)
  })

  it('skips an id that is not archived, not found or the shared Lead workspace from before KERNEL-405, and touches nothing of theirs', async () => {
    const { k, room, hasBranch } = await setup()
    const live = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Still working' })
    const lead = { ...await k.leadChat(room.id).then((c) => setUp(k, c.workspaceId)), id: 'shared-lead', name: 'lead', threadId: undefined, status: 'archived' as const, archivedAt: 1 }
    k.store.saveWorkspace(lead)

    const r = await k.deleteWorkspaces([live.id, 'nope', lead.id], { deleteUnpushed: true })

    expect(r.deleted).toEqual([])
    expect(r.skipped).toEqual([
      { id: live.id, name: live.name, reason: 'It is not archived.' },
      { id: 'nope', name: 'nope', reason: 'Kernel no longer has it.' },
      { id: lead.id, name: 'lead', reason: "It is Kernel's workspace." }
    ])
    expect(k.store.workspace(live.id)?.status).not.toBe('archived')
    expect(k.store.workspace(lead.id)).toBeDefined()
    expect(await hasBranch(live.branch)).toBe(true)
  })

  it('leaves the row when a transcript will not delete, ignores one that is already gone, and runs again', async () => {
    const { k, hasBranch, fails, onDisk, archived } = await setup()
    const a = await archived('stuck')
    const b = await archived('fine')
    fails.add('stuck-now')
    onDisk[b.path] = onDisk[b.path].slice(0, 1)
    onDisk[b.path].push({ sessionId: 'fine-forgotten', fileSize: 250 })
    // One of b's sessions was already deleted by hand.
    const gone = k.store.chats(b.id)[0]
    k.store.saveChat({ ...gone, sessionId: 'never-written' })

    const r = await k.deleteWorkspaces([a.id, b.id], { deleteUnpushed: false })

    expect(r.deleted).toEqual([b.id])
    expect(r.skipped).toEqual([{ id: a.id, name: a.name, reason: 'EACCES: permission denied' }])
    expect(k.store.workspace(a.id)?.status).toBe('archived')
    expect(await hasBranch(a.branch)).toBe(false)

    fails.clear()
    const again = await k.deleteWorkspaces([a.id], { deleteUnpushed: false })
    expect(again.deleted).toEqual([a.id])
    expect(k.store.workspace(a.id)).toBeUndefined()
  })

  it('leaves a workspace that was restored after the plan was made', async () => {
    const { k, hasBranch, archived } = await setup()
    const a = await archived('first')
    const b = await archived('restored-meanwhile', { commit: true, merged: true })
    // The first transcript to go is the moment b comes back.
    const real = k.deleteSession
    k.deleteSession = (async (...args: Parameters<typeof real>) => {
      k.store.saveWorkspace({ ...k.store.workspace(b.id)!, status: 'ready' })
      return real(...args)
    }) as typeof k.deleteSession

    const r = await k.deleteWorkspaces([a.id, b.id], { deleteUnpushed: true })

    expect(r.deleted).toEqual([a.id])
    expect(r.skipped).toEqual([{ id: b.id, name: b.name, reason: 'It is not archived.' }])
    expect(await hasBranch(b.branch)).toBe(true)
    expect(k.store.workspace(b.id)?.status).toBe('ready')
  })

  it('runs one delete at a time, so a second call plans against what the first left', async () => {
    const { k, archived } = await setup()
    const a = await archived('once')
    const [one, two] = await Promise.all([k.deleteWorkspaces([a.id], { deleteUnpushed: false }), k.deleteWorkspaces([a.id], { deleteUnpushed: false })])
    expect(one.deleted).toEqual([a.id])
    expect(two.deleted).toEqual([])
    expect(two.skipped).toEqual([{ id: a.id, name: a.id, reason: 'Kernel no longer has it.' }])
  })

  it('previews the numbers the delete then reports', async () => {
    const { k, archived } = await setup()
    const ids = [(await archived('p1', { commit: true })).id, (await archived('p2', { commit: true, merged: true })).id, (await archived('p3')).id]

    const p = await k.deletePreview(ids)
    expect(p).toEqual({ workspaces: 3, skipped: [], unpushedBranches: 1, transcriptBytes: 3750 })
    // Counting changes nothing.
    expect(ids.every((id) => k.store.workspace(id))).toBe(true)

    const r = await k.deleteWorkspaces(ids, { deleteUnpushed: false })
    expect(r).toEqual({ deleted: ids, skipped: [], keptBranches: p.unpushedBranches, freedBytes: p.transcriptBytes })
  })

  it('exposes both channels through the handler map', async () => {
    const { k, archived } = await setup()
    const a = await archived('via-ipc')
    const h = k.handlers()
    expect(await h['workspaces.deletePreview']({ workspaceIds: [a.id] })).toMatchObject({ workspaces: 1 })
    expect(await h['workspaces.delete']({ workspaceIds: [a.id], deleteUnpushed: false })).toMatchObject({ deleted: [a.id] })
  })
})
