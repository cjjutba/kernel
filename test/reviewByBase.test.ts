import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, PrInfo, Workspace } from '@shared/types'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { kernelTools } from '../src/main/services/kernelMcp'
import { run } from '../src/main/services/exec'
import { tempRepo } from './helpers'

// KERNEL-299: a review the Lead started with base_ref set to the reviewed branch, instead of review_of, is still a review,
// and is archived once that work merges or closes.

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\nrole: Frontend\n---\nYou are Kai.',
  '.claude/agents/theo.md': '---\nname: theo\ndescription: Reviews PRs.\nrole: Reviewer\n---\nYou are Theo.'
}

const info = (state: PrInfo['state']): PrInfo => ({ workspaceId: '', number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state, baseRef: 'main', checks: [], comments: [], conflicts: [] })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Waits until `ok` holds, up to 10 s, so a slow full run doesn't fail on a fixed sleep. */
async function until(ok: () => boolean) {
  for (const end = Date.now() + 10_000; !ok() && Date.now() < end;) await wait(50)
}

async function setup() {
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
  const rowan = (await k.agents(room.id)).find((a) => a.lead) as AgentDef
  const author = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
  const create = kernelTools(k['leadToolDeps'](room.id, rowan, lead)).find((t) => t.name === 'create_workspace')!
  /** create_workspace as the Lead calls it; the id of the new workspace, or the refusal. */
  const handOff = async (args: Record<string, string>) => {
    const out = await create.handler(args as never, {})
    const said = (out.content[0] as { text: string }).text
    const id = /^Created (\S+) on/.exec(said)?.[1]
    return id ? k.store.workspace(id)! : said
  }
  const notes: string[] = []
  const onActivity = (e: { kind: string; text: string; workspaceId?: string; quote?: string }) => { if (e.kind === 'note' && e.text === 'kept the review workspace') notes.push(`${e.workspaceId}: ${e.quote}`) }
  bus.on('activity', onActivity)
  onTestFinished(() => { bus.off('activity', onActivity) })
  const status = (w: Workspace) => k.store.workspace(w.id)!.status
  return { k, gh, room, lead, author, handOff, notes, status, where: k['o'] as ConstructorParameters<typeof Kernel>[0] }
}

describe('create_workspace with a reviewer on another workspace\'s branch (KERNEL-299)', () => {
  it('links it as a review, and archives it once the reviewed PR merges', async () => {
    const { k, gh, author, handOff, status } = await setup()
    gh.pr = info('ready')
    await k.refreshPr(author.id)
    const review = await handOff({ agent: 'theo', title: 'Review PR #42', brief: 'Review it', base_ref: `origin/${author.branch}` }) as Workspace
    expect(review.reviewOf).toBe(author.id)
    gh.pr = info('merged')
    await k.refreshPr(author.id)
    await until(() => status(review) === 'archived')
    expect(status(review)).toBe('archived')
    expect(status(author)).not.toBe('archived')
  })

  it('keeps an origin/ base and a short branch name, on a long reviewed branch', async () => {
    const { k, gh, room, lead, handOff, status } = await setup()
    const remote = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await run('git', ['init', '-q', '--bare', remote])
    await run('git', ['-C', room.path, 'remote', 'add', 'origin', remote])
    await run('git', ['-C', room.path, 'push', '-q', 'origin', 'main'])
    // The branch review_of can't start a review from yet (KERNEL-265), pushed with a commit on it.
    const author = await k.createWorkspace(room.id, { prompt: 'Fix it', agentId: 'kai', title: 'MCP servers', leadChatId: lead.id, branch: 'cjjutbaofficial/kernel-295-agents-in-the-kernel-repo-start-three-mcp-servers-they-never' })
    await writeFile(join(author.path, 'mcp.ts'), 'export {}\n')
    await run('git', ['-C', author.path, 'add', '-A'])
    await run('git', ['-C', author.path, 'commit', '-q', '-m', 'mcp'])
    await run('git', ['-C', author.path, 'push', '-q', 'origin', author.branch])
    gh.pr = info('ready')
    await k.refreshPr(author.id)
    const review = await handOff({ agent: 'theo', title: 'Review PR #213', brief: 'Review it', base_ref: `origin/${author.branch}`, branch: 'review/kernel-295-pr-213' }) as Workspace
    expect(review).toMatchObject({ reviewOf: author.id, branch: 'review/kernel-295-pr-213', baseRef: `origin/${author.branch}` })
    expect((await run('git', ['-C', review.path, 'log', '-1', '--format=%s'])).trim()).toBe('mcp')
    gh.pr = info('merged')
    await k.refreshPr(author.id)
    await until(() => status(review) === 'archived')
    expect(status(review)).toBe('archived')
  })

  it('runs the review checks: a second review by the same reviewer is refused', async () => {
    const { author, handOff } = await setup()
    const first = await handOff({ agent: 'theo', title: 'Review PR #42', brief: 'Review it', base_ref: author.branch }) as Workspace
    expect(first.reviewOf).toBe(author.id)
    expect(await handOff({ agent: 'theo', title: 'Review it again', brief: 'Review it', base_ref: author.branch })).toBe(`Not created: Theo already has a review of this open (workspace ${first.id}). Ask for another pass with message_agent.`)
  })

  it('leaves a task on another workspace\'s branch alone when that work merges', async () => {
    const { k, gh, author, handOff, status } = await setup()
    gh.pr = info('ready')
    await k.refreshPr(author.id)
    const task = await handOff({ agent: 'kai', title: 'Invoice export', brief: 'Build on the table', base_ref: author.branch }) as Workspace
    expect(task.reviewOf).toBeUndefined()
    gh.pr = info('merged')
    await k.refreshPr(author.id)
    await wait(600)
    expect(k.store.workspace(task.id)!.reviewOf).toBeUndefined()
    expect(status(task)).not.toBe('archived')
  })

  it('leaves a reviewer on main alone', async () => {
    const { handOff } = await setup()
    const ws = await handOff({ agent: 'theo', title: 'Audit the repo', brief: 'Look around', base_ref: 'main' }) as Workspace
    expect(ws.reviewOf).toBeUndefined()
  })
})

describe('at start, reviews made with base_ref (KERNEL-299)', () => {
  it('links and archives reviews of work that merged or closed, keeps one with unsaved work, and leaves tasks and open work alone', async () => {
    const { k, gh, room, lead, author, status, notes, where } = await setup()
    // What the Lead did before: a reviewer started from the reviewed branch, with no review_of.
    const stale = async (agentId: string, of: Workspace, title: string) => {
      const w = await k.createWorkspace(room.id, { prompt: title, agentId, title, leadChatId: lead.id })
      return k.store.saveWorkspace({ ...w, baseRef: `origin/${of.branch}` })
    }
    const merged = await stale('theo', author, 'Review PR #42')
    const dirty = await stale('theo', author, 'Second look at PR #42')
    await writeFile(join(dirty.path, 'scratch.md'), 'notes\n')
    const task = await stale('kai', author, 'Invoice export')
    const other = await k.createWorkspace(room.id, { prompt: 'Build the export', agentId: 'kai', title: 'Invoice export UI', leadChatId: lead.id })
    const openReview = await stale('theo', other, 'Review the export')
    const closed = await k.createWorkspace(room.id, { prompt: 'Try a chart', agentId: 'kai', title: 'Invoice chart', leadChatId: lead.id })
    const closedReview = await stale('theo', closed, 'Review the chart')
    // The PRs merge and close while nothing links the reviews, so nothing archives them.
    gh.pr = info('ready')
    for (const w of [author, other, closed]) await k.refreshPr(w.id)
    gh.pr = info('merged')
    await k.refreshPr(author.id)
    gh.pr = info('closed')
    await k.refreshPr(closed.id)
    // Closed work may be archived already. Its review still goes.
    await k.archiveWorkspace(closed.id)
    await wait(300)
    expect(status(merged)).not.toBe('archived')
    await k.stop()

    const k2 = new Kernel(where)
    await k2.start()
    onTestFinished(() => k2.stop())
    const now = (w: Workspace) => k2.store.workspace(w.id)!
    await until(() => now(merged).status === 'archived' && now(closedReview).status === 'archived' && notes.length > 0)
    expect(now(merged)).toMatchObject({ reviewOf: author.id, status: 'archived' })
    expect(now(closedReview)).toMatchObject({ reviewOf: closed.id, status: 'archived' })
    expect(now(dirty).reviewOf).toBe(author.id)
    expect(now(dirty).status).not.toBe('archived')
    expect(notes).toEqual([`${dirty.id}: The work it reviewed is done, but it wasn't archived: it has uncommitted changes.`])
    // Open work keeps its review, now linked, so its merge archives it later.
    expect(now(openReview).reviewOf).toBe(other.id)
    expect(now(openReview).status).not.toBe('archived')
    expect(now(task).reviewOf).toBeUndefined()
    expect(now(task).status).not.toBe('archived')
    expect(now(author).status).not.toBe('archived')
  }, 40_000)
})
