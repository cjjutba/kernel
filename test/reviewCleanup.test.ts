import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrInfo, Workspace } from '@shared/types'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { tempRepo } from './helpers'

// KERNEL-131: review workspaces go once the work they reviewed merges or closes, through archive_workspace's checks.

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
  '.claude/agents/theo.md': '---\nname: theo\ndescription: Reviewer. Reviews PRs.\nrole: Reviewer\n---\nYou are Theo.'
}

/** Archiving runs git, which takes seconds when the whole suite runs at once (KERNEL-187). */
const SLOW = { timeout: 15_000 }

const info = (state: PrInfo['state']): PrInfo => ({ workspaceId: '', number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state, baseRef: 'main', checks: [], comments: [], conflicts: [] })

/** `other` adds a second piece of work and its own review, which only the first test needs. */
async function setup(o: { other?: boolean } = {}) {
  const repo = await tempRepo(REPO)
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop())
  k.sessions.send = async () => ({ queued: false })
  const gh = { pr: null as PrInfo | null }
  k.github = { info: async (_cwd, _ref, workspaceId) => (gh.pr ? { ...gh.pr, workspaceId } : null), merge: async () => undefined, ready: async () => undefined, reopen: async () => undefined }
  const room = await k.addRoom(repo)
  const lead = await k.leadChat(room.id)
  const author = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
  const review = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'theo', title: 'Review PR #42', leadChatId: lead.id, reviewOf: author.id })
  // Other work and its own review, which a merge of the first PR must leave alone.
  const other = o.other ? await k.createWorkspace(room.id, { prompt: 'Build the export', agentId: 'kai', title: 'Invoice export', leadChatId: lead.id }) : undefined
  const otherReview = other ? await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'theo', title: 'Review the export', leadChatId: lead.id, reviewOf: other.id }) : undefined
  // The PR is open and adopted first, so a later merge or close counts.
  gh.pr = info('ready')
  await k.refreshPr(author.id)
  const notes: string[] = []
  const onActivity = (e: { kind: string; text: string; actor?: string; quote?: string }) => { if (e.kind === 'note' && e.text === 'kept the review workspace') notes.push(`${e.actor}: ${e.quote}`) }
  bus.on('activity', onActivity)
  onTestFinished(() => { bus.off('activity', onActivity) })
  const status = (w: Workspace) => k.store.workspace(w.id)!.status
  const archived = () => vi.waitFor(() => expect(status(review)).toBe('archived'), SLOW)
  // Kernel marks a review it will archive once its turn ends, before anything async, so this holds once refreshPr returns.
  const marked = () => k['reviewsToArchive'].has(review.id)
  return { k, gh, room, lead, author, review, other, otherReview, notes, archived, marked, status }
}

describe('review workspaces after the work they reviewed (KERNEL-131)', () => {
  it('archive once the PR merges, and leave the author\'s workspace and the Lead\'s alone', async () => {
    const { k, gh, author, otherReview, lead, archived, status } = await setup({ other: true })
    gh.pr = info('merged')
    await k.refreshPr(author.id)
    await archived()
    expect(status(author)).not.toBe('archived')
    expect(status(otherReview!)).not.toBe('archived')
    expect(k.store.workspace(lead.workspaceId)!.status).not.toBe('archived')
  })

  it('archive once the PR is closed without merging', async () => {
    const { k, gh, author, archived } = await setup()
    gh.pr = info('closed')
    await k.refreshPr(author.id)
    await archived()
  })

  it('keep a review workspace with uncommitted changes, and say why in the log', async () => {
    const { k, gh, author, review, notes, status } = await setup()
    await writeFile(join(review.path, 'scratch.md'), 'notes\n')
    gh.pr = info('merged')
    await k.refreshPr(author.id)
    await vi.waitFor(() => expect(notes).toEqual(["kernel: The work it reviewed is done, but it wasn't archived: it has uncommitted changes."]), SLOW)
    expect(status(review)).not.toBe('archived')
  })

  it('archive a review workspace that was still working once its turn ends', async () => {
    const { k, gh, author, review, archived, marked, status } = await setup()
    const chats = k.store.chats(review.id).map((c) => c.id)
    const running = k.sessions.isRunning
    k.sessions.isRunning = (id) => chats.includes(id)
    gh.pr = info('merged')
    await k.refreshPr(author.id)
    expect(marked()).toBe(true)
    expect(status(review)).not.toBe('archived')
    k.sessions.isRunning = running
    const deps = (k.sessions as unknown as { d: { onTurnDone: (ws: Workspace, chat: unknown, t: object) => void } }).d
    deps.onTurnDone(k.store.workspace(review.id)!, k.store.chat(chats[0])!, { ok: true, interrupted: false, by: 'lead' })
    await archived()
  })
})

describe('review workspaces, edge cases (KERNEL-131)', () => {
  it('waits for a message queued in the review to go out and its turn to end', async () => {
    const { k, gh, author, review, archived, marked, status } = await setup()
    const chat = k.store.chats(review.id)[0].id
    const queued = k.sessions.queued
    k.sessions.queued = (id) => (id === chat ? [{ id: 'q', chatId: chat, parts: [{ type: 'text', text: 'One more look' }], ts: 1 }] : queued.call(k.sessions, id))
    gh.pr = info('merged')
    await k.refreshPr(author.id)
    expect(marked()).toBe(true)
    expect(status(review)).not.toBe('archived')
    k.sessions.queued = queued
    const deps = (k.sessions as unknown as { d: { onTurnDone: (ws: Workspace, chat: unknown, t: object) => void } }).d
    deps.onTurnDone(k.store.workspace(review.id)!, k.store.chat(chat)!, { ok: true, interrupted: false, by: 'lead' })
    await archived()
  })

  it('archives a workspace once when two archives ask at the same time', async () => {
    const { k, review, status } = await setup()
    await Promise.all([k.archiveWorkspace(review.id), k.archiveWorkspace(review.id)])
    expect(status(review)).toBe('archived')
  })

  it('archives at start a review that was still working when Kernel quit, and leaves one the user restored', async () => {
    const { k, gh, author, review, marked, status } = await setup()
    const chats = k.store.chats(review.id).map((c) => c.id)
    k.sessions.isRunning = (id) => chats.includes(id)
    gh.pr = info('merged')
    await k.refreshPr(author.id)
    expect(marked()).toBe(true)
    expect(status(review)).not.toBe('archived')
    const where = (k as unknown as { o: ConstructorParameters<typeof Kernel>[0] }).o
    await k.stop()
    const k2 = new Kernel(where)
    await k2.start()
    onTestFinished(() => k2.stop())
    await vi.waitFor(() => expect(k2.store.workspace(review.id)!.status).toBe('archived'), SLOW)
    // The user brings it back from History. The next launch leaves it be: it isn't marked, and a sweep passes it over.
    await k2.restoreWorkspace(review.id)
    await k2.stop()
    const k3 = new Kernel(where)
    await k3.start()
    onTestFinished(() => k3.stop())
    expect(k3['reviewsToArchive'].has(review.id)).toBe(false)
    await k3['sweepReviews']()
    expect(k3.store.workspace(review.id)!.status).not.toBe('archived')
  })

  it('archives a review whose setup failed: its held brief waits for the user, not for a turn', async () => {
    const { k, gh, author, review, archived } = await setup()
    k.store.saveWorkspace({ ...k.store.workspace(review.id)!, status: 'failed' })
    const chat = k.store.chats(review.id)[0].id
    k.sessions.hold(chat, [{ type: 'text', text: 'Review it' }])
    gh.pr = info('merged')
    await k.refreshPr(author.id)
    await archived()
    // Archive let go of the held brief, so a restore doesn't find the chat still waiting for setup.
    expect(k.sessions.queued(chat)).toEqual([])
  })
})
