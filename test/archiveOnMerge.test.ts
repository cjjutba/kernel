import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatPart, PrInfo, Workspace } from '@shared/types'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { run } from '../src/main/services/exec'
import { archiveToast } from '../src/renderer/src/screens/workspace/pr/model'
import { tempRepo, freePort } from './helpers'

// A chat with Kernel's held first message goes out through the real send once its setup passes (KERNEL-405).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// KERNEL-114: Archive on merge in Settings, Git archives the work whose PR merged, and covers review cleanup (KERNEL-131).

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.',
  '.claude/agents/artkin.md': '---\nname: artkin\ndescription: Reviewer. Reviews PRs.\nrole: Reviewer\n---\nYou are Artkin.'
}

/** Archiving runs git, which takes seconds when the whole suite runs at once (KERNEL-187). */
const SLOW = { timeout: 15_000 }

const info = (state: PrInfo['state'], head?: string): PrInfo => ({ workspaceId: '', number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state, baseRef: 'main', checks: [], comments: [], conflicts: [], ...(head ? { head } : {}) })


/**
 * A project with the Lead, Christian's work and Artkin's review of it, its PR open. `archiveOnMerge` and `deleteBranch` are the
 * app-wide switches, `project` and `projectDelete` the project's own values in `.kernel/settings.local.toml`, written as given, so
 * a string stays a string. `origin` gives the repo a bare remote before the work starts.
 */
async function setup(o: { archiveOnMerge?: boolean; project?: boolean; deleteBranch?: boolean; projectDelete?: boolean | string; origin?: boolean } = {}) {
  const repo = await tempRepo(REPO)
  if (o.origin) {
    const origin = join(await mkdtemp(join(tmpdir(), 'kernel-origin-')), 'o.git')
    await run('git', ['init', '-q', '--bare', origin])
    await run('git', ['-C', repo, 'remote', 'add', 'origin', origin])
    await run('git', ['-C', repo, 'push', '-q', 'origin', 'main'])
  }
  const own = [
    ...(o.project === undefined ? [] : [`archive_on_merge = ${o.project}`]),
    ...(o.projectDelete === undefined ? [] : [`delete_branch_on_archive = ${JSON.stringify(o.projectDelete)}`])
  ]
  if (own.length) {
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), `[workspace]\n${own.join('\n')}\n`)
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  const app = { ...(o.archiveOnMerge === undefined ? {} : { archiveOnMerge: o.archiveOnMerge }), ...(o.deleteBranch === undefined ? {} : { deleteBranchOnArchive: o.deleteBranch }) }
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', ...app } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop())
  k.sessions.send = async () => ({ queued: false })
  // A merge starts its archive passes without awaiting them, so a check that a workspace stays must wait for them.
  const passes = [vi.spyOn(k.autoArchive, 'archiveReviews'), vi.spyOn(k.autoArchive, 'archiveMerged')]
  const settled = async () => {
    await vi.waitFor(() => expect(passes[1]).toHaveBeenCalled(), SLOW)
    await Promise.all(passes.flatMap((p) => p.mock.results.map((r) => r.value)))
  }
  const gh = { pr: null as PrInfo | null }
  k.github = { info: async (_cwd, _ref, workspaceId) => (gh.pr ? { ...gh.pr, workspaceId } : null), merge: async () => undefined, ready: async () => undefined, reopen: async () => undefined }
  const project = await k.addProject(repo)
  const lead = await k.leadChat(project.id)
  const author = await k.createWorkspace(project.id, { prompt: 'Build the table', agentId: 'christian', title: 'Invoice table', leadChatId: lead.id })
  const review = await k.createWorkspace(project.id, { prompt: 'Review it', agentId: 'artkin', title: 'Review PR #42', leadChatId: lead.id, reviewOf: author.id })
  const notes: string[] = []
  const onActivity = (e: { kind: string; text: string; workspaceId?: string; quote?: string }) => { if (e.kind === 'note' && e.text.startsWith('kept the')) notes.push(`${e.workspaceId}: ${e.quote}`) }
  bus.on('activity', onActivity)
  onTestFinished(() => { bus.off('activity', onActivity) })
  const status = (w: Workspace) => k.store.workspace(w.id)!.status
  /** The PR opens, then merges or closes, as the poll would see it. */
  const land = async (state: 'merged' | 'closed', head?: string) => {
    gh.pr = info('ready', head)
    await k.refreshPr(author.id)
    gh.pr = info(state, head)
    await k.refreshPr(author.id)
  }
  const turnDone = (w: Workspace) => {
    const deps = (k.sessions as unknown as { d: { onTurnDone: (ws: Workspace, chat: unknown, t: object) => void } }).d
    deps.onTurnDone(k.store.workspace(w.id)!, k.store.chats(w.id)[0], { ok: true, interrupted: false, by: 'lead' })
  }
  return { k, gh, repo, project, lead, author, review, notes, status, land, settled, turnDone, where: k.o }
}

/** Commits a file in the workspace and pushes its branch, as an agent opening a PR does. The commit pushed. */
async function pushWork(ws: Workspace) {
  await writeFile(join(ws.path, 'table.ts'), 'export const table = 1\n')
  await run('git', ['-C', ws.path, 'add', '-A'])
  await run('git', ['-C', ws.path, 'commit', '-q', '-m', 'table'])
  await run('git', ['-C', ws.path, 'push', '-q', '-u', 'origin', ws.branch])
  return (await run('git', ['-C', ws.path, 'rev-parse', 'HEAD'])).trim()
}

describe('Archive on merge (KERNEL-114)', () => {
  it('archives the merged work and its review, and leaves the Lead\'s workspace alone', async () => {
    const { k, author, review, lead, status, land } = await setup()
    await land('merged')
    await vi.waitFor(() => expect([status(author), status(review)]).toEqual(['archived', 'archived']), SLOW)
    expect(k.store.workspace(lead.workspaceId)!.status).not.toBe('archived')
  })

  it('archives nothing when the switch is off, not even the review', async () => {
    const { author, review, status, land, settled, notes } = await setup({ archiveOnMerge: false })
    await land('merged')
    await settled()
    expect(status(author)).not.toBe('archived')
    expect(status(review)).not.toBe('archived')
    expect(notes).toEqual([])
  })

  it('reads the project\'s own value before the app-wide one', async () => {
    const off = await setup({ project: false })
    await off.land('merged')
    await off.settled()
    expect(off.status(off.author)).not.toBe('archived')
    expect(off.status(off.review)).not.toBe('archived')
    const on = await setup({ archiveOnMerge: false, project: true })
    await on.land('merged')
    await vi.waitFor(() => expect([on.status(on.author), on.status(on.review)]).toEqual(['archived', 'archived']), SLOW)
  })

  it('keeps the work of a PR closed without merging, and archives its review', async () => {
    const { author, review, status, land } = await setup()
    await land('closed')
    await vi.waitFor(() => expect(status(review)).toBe('archived'), SLOW)
    expect(status(author)).not.toBe('archived')
  })

  it('keeps merged work with uncommitted changes, and says why in the log', async () => {
    const { author, status, land, notes } = await setup()
    await writeFile(join(author.path, 'scratch.md'), 'notes\n')
    await land('merged')
    await vi.waitFor(() => expect(notes).toContain(`${author.id}: Its PR #42 merged, but it wasn't archived: it has uncommitted changes.`), SLOW)
    expect(status(author)).not.toBe('archived')
  })

  it('keeps merged work with a commit GitHub doesn\'t have', async () => {
    const { author, status, land, notes } = await setup({ origin: true })
    const head = await pushWork(author)
    await writeFile(join(author.path, 'more.ts'), 'export const more = 1\n')
    await run('git', ['-C', author.path, 'add', '-A'])
    await run('git', ['-C', author.path, 'commit', '-q', '-m', 'more'])
    await land('merged', head)
    await vi.waitFor(() => expect(notes).toContain(`${author.id}: Its PR #42 merged, but it wasn't archived: it has a commit that GitHub doesn't.`), SLOW)
    expect(status(author)).not.toBe('archived')
  })

  it('archives squash-merged work whose branch GitHub deleted: what the PR had is on GitHub', async () => {
    const { repo, author, status, land } = await setup({ origin: true })
    const head = await pushWork(author)
    // The merge left the commit off main, and GitHub deleted the branch, so the remote copy is gone too.
    await run('git', ['-C', repo, 'push', '-q', 'origin', '--delete', author.branch])
    await land('merged', head)
    await vi.waitFor(() => expect(status(author)).toBe('archived'), SLOW)
  })

  it('archives merged work that was still working once its turn ends', async () => {
    const { k, author, status, land, settled, turnDone } = await setup()
    const chats = k.store.chats(author.id).map((c) => c.id)
    const running = k.sessions.isRunning
    k.sessions.isRunning = (id) => chats.includes(id)
    await land('merged')
    await settled()
    expect(k.autoArchive['reviewsToArchive'].has(author.id)).toBe(true)
    expect(status(author)).not.toBe('archived')
    k.sessions.isRunning = running
    turnDone(author)
    await vi.waitFor(() => expect(status(author)).toBe('archived'), SLOW)
  })

  it('never archives merged work on the project\'s own checkout, where uncommitted changes can\'t be checked', async () => {
    const { k, project, author, status, land, settled } = await setup()
    // Work on the project's checkout, as a current-branch workspace is, with a file left uncommitted there.
    k.store.saveWorkspace({ ...k.store.workspace(author.id)!, mode: 'current', path: project.path, branch: 'main' })
    await writeFile(join(project.path, 'scratch.md'), 'notes\n')
    await land('merged')
    await settled()
    expect(status(author)).not.toBe('archived')
    expect(k.autoArchive['reviewsToArchive'].has(author.id)).toBe(false)
  })

  it('never archives the Lead\'s workspace, even before the team is read', async () => {
    const { k, lead } = await setup()
    k.store.saveWorkspace({ ...k.store.workspace(lead.workspaceId)!, prState: 'merged' })
    // A cold cache: nothing says which agent is the Lead.
    k.team.agentCache.clear()
    await k.autoArchive['archiveMerged'](lead.workspaceId)
    k.store.saveMeta('mergedSwept', false)
    await k.autoArchive['sweepMerged']()
    expect(k.store.workspace(lead.workspaceId)!.status).not.toBe('archived')
  })

  it('leaves merged work that moved to a fresh branch before the archive', async () => {
    const { k, gh, author, status, land, settled, turnDone } = await setup()
    const chats = k.store.chats(author.id).map((c) => c.id)
    const running = k.sessions.isRunning
    k.sessions.isRunning = (id) => chats.includes(id)
    await land('merged')
    await settled()
    expect(k.autoArchive['reviewsToArchive'].has(author.id)).toBe(true)
    // The turn puts the worktree on a new branch, which has no PR on GitHub. The archive's git check drops the merged one.
    await run('git', ['-C', author.path, 'checkout', '-q', '-b', 'feat/next'])
    gh.pr = null
    k.sessions.isRunning = running
    const passes = (k.autoArchive['archiveMerged'] as unknown as { mock: { results: { value: Promise<void> }[] } }).mock.results.length
    turnDone(author)
    await vi.waitFor(() => expect((k.autoArchive['archiveMerged'] as unknown as { mock: { results: unknown[] } }).mock.results.length).toBeGreaterThan(passes), SLOW)
    await settled()
    expect(k.store.workspace(author.id)).toMatchObject({ branch: 'feat/next', prState: 'none' })
    expect(k.autoArchive['reviewsToArchive'].has(author.id)).toBe(false)
    expect(status(author)).not.toBe('archived')
  })

  it('refuses Continue once the archive has started, and leaves the branch alone', async () => {
    const { k, repo, author, status, land } = await setup()
    // The archive holds at its first step, after it has started and before the record says archived. Its checks before
    // that sync the branch too, so only the archive's own call holds.
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const sync = k.prs.syncBranch.bind(k.prs)
    const archive = k.archive.archiveWorkspace.bind(k.archive)
    let archiving = false
    const reached = vi.fn()
    vi.spyOn(k.archive, 'archiveWorkspace').mockImplementation((id, ...a) => { if (id === author.id) archiving = true; return archive(id, ...a) })
    vi.spyOn(k.prs, 'syncBranch').mockImplementation(async (id) => { if (id === author.id && archiving) { reached(); await held } return sync(id) })
    await land('merged')
    await vi.waitFor(() => expect(reached).toHaveBeenCalled(), SLOW)
    await expect(k.prs.continuePr(author.id)).rejects.toThrow('This workspace is being archived, so Continue changed nothing. Restore it once the archive finishes to keep going.')
    expect((await run('git', ['-C', author.path, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(author.branch)
    release()
    await vi.waitFor(() => expect(status(author)).toBe('archived'), SLOW)
    await expect(k.prs.continuePr(author.id)).rejects.toThrow('This workspace was archived, so Continue changed nothing. Restore it to keep going.')
    expect(k.store.workspace(author.id)).toMatchObject({ branch: author.branch, prState: 'merged', prNumber: 42 })
    expect((await run('git', ['-C', repo, 'branch', '--list', `${author.branch}-2`])).trim()).toBe('')
  })

  it('skips the archive when Continue started first, so the branch and the record agree', async () => {
    const { k, author, status, land, settled } = await setup()
    // The archive pass holds after its git checks, before it decides; Continue holds before it switches the branch.
    let releaseArchive!: () => void
    const archiveHeld = new Promise<void>((r) => { releaseArchive = r })
    const unpushed = k.autoArchive['unpushedOf'].bind(k.autoArchive)
    const archiveReached = vi.fn()
    vi.spyOn(k.autoArchive as unknown as { unpushedOf: typeof unpushed }, 'unpushedOf').mockImplementation(async (ws) => { archiveReached(); await archiveHeld; return unpushed(ws) })
    let releaseContinue!: () => void
    const continueHeld = new Promise<void>((r) => { releaseContinue = r })
    const lock = k.workspaces.withBranchLock.bind(k.workspaces)
    const continueReached = vi.fn()
    vi.spyOn(k.workspaces, 'withBranchLock').mockImplementation(async (projectId, pick) => { continueReached(); await continueHeld; return lock(projectId, pick) })
    await land('merged')
    await vi.waitFor(() => expect(archiveReached).toHaveBeenCalled(), SLOW)
    const continued = k.prs.continuePr(author.id)
    await vi.waitFor(() => expect(continueReached).toHaveBeenCalled(), SLOW)
    releaseArchive()
    await settled()
    expect(status(author)).not.toBe('archived')
    expect(k.archive.archivingNow(author.id)).toBe(false)
    releaseContinue()
    const next = await continued
    expect(next).toMatchObject({ branch: `${author.branch}-2`, prState: 'none', prNumber: undefined })
    expect((await run('git', ['-C', author.path, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(next.branch)
    expect(k.autoArchive['reviewsToArchive'].has(author.id)).toBe(false)
    expect(status(author)).not.toBe('archived')
  })

  it('releases the workspaces waiting on the merge, and still tells the Lead the work merged', async () => {
    const { k, project, lead, author, status, land } = await setup()
    // Not handed off in the Lead's chat, so the merge is the last of that chat's work.
    const waiter = await k.createWorkspace(project.id, { prompt: 'Build the export', agentId: 'christian', title: 'Invoice export' })
    k.store.saveWorkspace({ ...k.store.workspace(waiter.id)!, waitsFor: { on: [author.id], held: false } })
    const posts: string[] = []
    k.sessions.post = (chatId: string, parts: ChatPart[]) => { posts.push(`${chatId}: ${parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}`); return true }
    ;(k.leadUpdates as unknown as { d: { delayMs?: number } }).d.delayMs = 20
    await land('merged')
    await vi.waitFor(() => expect(status(author)).toBe('archived'), SLOW)
    // Released, not broken: the work it waited for merged.
    expect(k.store.workspace(waiter.id)!.waitsFor?.releasing).toBe(true)
    expect(posts.some((p) => p.startsWith(`${k.store.chats(waiter.id)[0].id}: PR #42 by Christian merged into main.`))).toBe(true)
    await vi.waitFor(() => expect(posts.some((p) => p.startsWith(`${lead.id}:`) && p.includes('PR #42 was merged.'))).toBe(true), SLOW)
  })
})

/** Whether the project's repo still has the workspace's branch. */
const hasBranch = async (repo: string, ws: Workspace) => (await run('git', ['-C', repo, 'branch', '--list', ws.branch])).trim() !== ''

describe('Delete branch on archive in a project (KERNEL-370)', () => {
  it('deletes a pushed branch when the project turns it on and the app leaves it off', async () => {
    const { k, repo, author } = await setup({ origin: true, projectDelete: true })
    await pushWork(author)
    await k.archive.archiveWorkspace(author.id)
    await k.archive.cleanedUp(author.id)
    expect(await hasBranch(repo, author)).toBe(false)
  })

  it('keeps the branch when the project turns it off and the app turns it on', async () => {
    const { k, repo, author } = await setup({ origin: true, deleteBranch: true, projectDelete: false })
    await pushWork(author)
    await k.archive.archiveWorkspace(author.id)
    await k.archive.cleanedUp(author.id)
    expect(await hasBranch(repo, author)).toBe(true)
  })

  it('uses the app value when the project\'s is not true or false', async () => {
    // Off in the app, so a truthy string read as the project's value would delete the branch.
    const { k, repo, author } = await setup({ origin: true, deleteBranch: false, projectDelete: 'yes' })
    await pushWork(author)
    await k.archive.archiveWorkspace(author.id)
    await k.archive.cleanedUp(author.id)
    expect(await hasBranch(repo, author)).toBe(true)
  })

  it('lets the caller\'s choice win over the project and the app', async () => {
    const keep = await setup({ origin: true, deleteBranch: true, projectDelete: true })
    await pushWork(keep.author)
    await keep.k.archive.archiveWorkspace(keep.author.id, false)
    await keep.k.archive.cleanedUp(keep.author.id)
    expect(await hasBranch(keep.repo, keep.author)).toBe(true)
    const drop = await setup({ origin: true, deleteBranch: false, projectDelete: false })
    await pushWork(drop.author)
    await drop.k.archive.archiveWorkspace(drop.author.id, true)
    await drop.k.archive.cleanedUp(drop.author.id)
    expect(await hasBranch(drop.repo, drop.author)).toBe(false)
  })

  it('still keeps a branch with a commit that never left the machine', async () => {
    const { k, repo, author } = await setup({ origin: true, projectDelete: true })
    await pushWork(author)
    await writeFile(join(author.path, 'more.ts'), 'export const more = 1\n')
    await run('git', ['-C', author.path, 'add', '-A'])
    await run('git', ['-C', author.path, 'commit', '-q', '-m', 'more'])
    await k.archive.archiveWorkspace(author.id)
    await k.archive.cleanedUp(author.id)
    expect(await hasBranch(repo, author)).toBe(true)
  })

  it('deletes the branch of work Kernel archives on merge', async () => {
    const { k, repo, author, status, land } = await setup({ origin: true, projectDelete: true })
    const head = await pushWork(author)
    await land('merged', head)
    await vi.waitFor(() => expect(status(author)).toBe('archived'), SLOW)
    await k.archive.cleanedUp(author.id)
    expect(await hasBranch(repo, author)).toBe(false)
  })
})

describe('Delete the branch while Kernel is already archiving (KERNEL-139)', () => {
  /** Kernel's own archive, which keeps the branch, and the person's, which asks to delete it, both running at once. */
  const both = async (k: Kernel, ws: Workspace) => {
    const kept: string[] = []
    const onActivity = (e: { kind: string; text: string; object?: string }) => { if (e.kind === 'note' && e.text.startsWith('kept the branch')) kept.push(`${e.text} ${e.object}`) }
    bus.on('activity', onActivity)
    onTestFinished(() => { bus.off('activity', onActivity) })
    await Promise.all([k.archive.archiveWorkspace(ws.id), k.archive.archiveWorkspace(ws.id, true)])
    return kept
  }

  it('deletes a pushed branch', async () => {
    const { k, repo, author, status } = await setup({ origin: true, deleteBranch: false })
    await pushWork(author)
    expect(await both(k, author)).toEqual([])
    expect(status(author)).toBe('archived')
    expect(await hasBranch(repo, author)).toBe(false)
  })

  it('keeps a branch with a commit that never left the machine, and says why', async () => {
    const { k, repo, author } = await setup({ origin: true, deleteBranch: false })
    await pushWork(author)
    await writeFile(join(author.path, 'more.ts'), 'export const more = 1\n')
    await run('git', ['-C', author.path, 'add', '-A'])
    await run('git', ['-C', author.path, 'commit', '-q', '-m', 'more'])
    expect(await both(k, author)).toEqual([`kept the branch because it has commits that were never pushed: ${author.branch}`])
    expect(await hasBranch(repo, author)).toBe(true)
  })

  it('leaves the running archive\'s choice when the second one doesn\'t ask to delete', async () => {
    const { k, repo, author } = await setup({ origin: true, deleteBranch: false })
    await pushWork(author)
    await Promise.all([k.archive.archiveWorkspace(author.id), k.archive.archiveWorkspace(author.id, false)])
    expect(await hasBranch(repo, author)).toBe(true)
  })
})

describe('Archive on merge at start (KERNEL-114)', () => {
  it('archives work that merged before, keeps the Lead\'s workspace, and runs once', async () => {
    const { k, lead, author, where } = await setup()
    // Merged before archive on merge worked: saved as merged, with no PR event to come.
    k.store.saveWorkspace({ ...k.store.workspace(author.id)!, prState: 'merged', prNumber: 42 })
    k.store.saveWorkspace({ ...k.store.workspace(lead.workspaceId)!, prState: 'merged' })
    k.store.saveMeta('mergedSwept', false)
    await k.stop()
    const k2 = new Kernel(where)
    await k2.start()
    onTestFinished(() => k2.stop())
    await vi.waitFor(() => expect(k2.store.workspace(author.id)!.status).toBe('archived'), SLOW)
    expect(k2.store.workspace(lead.workspaceId)!.status).not.toBe('archived')
    // The user brings it back. The next start leaves it be.
    await k2.restoreWorkspace(author.id)
    await k2.stop()
    const k3 = new Kernel(where)
    await k3.start()
    onTestFinished(() => k3.stop())
    await k3.autoArchive['sweepMerged']()
    expect(k3.store.workspace(author.id)!.status).not.toBe('archived')
  })

  it('archives at start merged work that was still working when Kernel quit', async () => {
    const { k, author, land, settled, where } = await setup()
    const chats = k.store.chats(author.id).map((c) => c.id)
    k.sessions.isRunning = (id) => chats.includes(id)
    await land('merged')
    await settled()
    expect(k.store.workspace(author.id)!.status).not.toBe('archived')
    await k.stop()
    const k2 = new Kernel(where)
    await k2.start()
    onTestFinished(() => k2.stop())
    await vi.waitFor(() => expect(k2.store.workspace(author.id)!.status).toBe('archived'), SLOW)
  })
})

describe('the toast for a workspace Kernel archives on merge while it is open (KERNEL-114)', () => {
  const ws = (extra: Partial<Workspace>) => ({ id: 'w', projectId: 'r', name: 'w', branch: 'b', baseRef: 'main', path: '/x', mode: 'worktree', agentId: 'christian', port: 1, status: 'archived', prState: 'none', createdAt: 1, ...extra }) as Workspace

  it('says what Kernel did when the PR merged', () => {
    expect(archiveToast(ws({ prState: 'merged', prNumber: 164 }), undefined, 'Christian')).toEqual({ title: "Archived Christian's workspace after PR #164 merged", sub: 'Restore it from History.' })
    expect(archiveToast(ws({ prState: 'merged' }), undefined, undefined)).toMatchObject({ title: 'Archived the workspace' })
  })

  it('has none for a PR that was only closed, or a workspace with no PR', () => {
    expect(archiveToast(ws({ prState: 'closed', prNumber: 164 }), undefined, 'Christian')).toBeUndefined()
    expect(archiveToast(ws({}), undefined, 'Christian')).toBeUndefined()
  })
})
