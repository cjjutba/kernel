import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { branchExists, createWorktree } from '../src/main/services/worktrees'
import { git } from '../src/main/services/exec'
import { tempRepo, freePort } from './helpers'

// A chat with Kernel's held first message goes out through the real send once its setup passes (KERNEL-405).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// KERNEL-265: a review of work on a long branch starts in its own folder, and takes the branch the Lead names.

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.',
  '.claude/agents/artkin.md': '---\nname: artkin\ndescription: Reviewer. Reviews PRs.\nrole: Reviewer\n---\nYou are Artkin.'
}

const LONG = 'cjjutbaofficial/kernel-237-draw-a-question-card-that-steps-through-several-questions'

async function setup() {
  const repo = await tempRepo(REPO)
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop())
  k.sessions.send = async () => ({ queued: false })
  const project = await k.addProject(repo)
  const lead = await k.leadChat(project.id)
  // The author moves its work onto a branch over 80 characters, which the review starts from (KERNEL-136).
  const author = await k.createWorkspace(project.id, { prompt: 'Draw the card', agentId: 'christian', title: 'Draw a question card', leadChatId: lead.id })
  await git(author.path, 'checkout', '-qb', LONG)
  await writeFile(join(author.path, 'card.txt'), 'card\n')
  await git(author.path, 'add', '.')
  await git(author.path, 'commit', '-qm', 'card')
  const tip = (await git(author.path, 'rev-parse', 'HEAD')).trim()
  const review = (branch?: string) => k.createWorkspace(project.id, { prompt: 'Review it', agentId: 'artkin', title: 'Review PR #213', leadChatId: lead.id, reviewOf: author.id, ...(branch ? { branch } : {}) })
  return { k, repo, author, tip, review }
}

const head = async (path: string) => (await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()

describe('a review of work on a long branch (KERNEL-265)', () => {
  it('starts in a folder of its own, from the tip of the long branch', async () => {
    const { author, tip, review } = await setup()
    const ws = await review()
    expect(ws).toMatchObject({ reviewOf: author.id, baseRef: LONG, branch: 'review/draw-question-card' })
    expect(ws.path).not.toBe(author.path)
    expect(await head(ws.path)).toBe(ws.branch)
    expect((await git(ws.path, 'rev-parse', 'HEAD')).trim()).toBe(tip)
    expect(await head(author.path)).toBe(LONG)
  })

  it('takes the branch the Lead passes, with a suffix when it is taken', async () => {
    const { tip, review } = await setup()
    const first = await review('review/kernel-237-pr-213')
    const second = await review('review/kernel-237-pr-213')
    expect([first.branch, second.branch]).toEqual(['review/kernel-237-pr-213', 'review/kernel-237-pr-213-2'])
    expect(first.path).not.toBe(second.path)
    for (const ws of [first, second]) {
      expect(await head(ws.path)).toBe(ws.branch)
      expect((await git(ws.path, 'rev-parse', 'HEAD')).trim()).toBe(tip)
    }
  })

  it("cuts a long branch from the Lead to 60 characters and still gets its own folder", async () => {
    const { author, review } = await setup()
    const ws = await review(`${LONG}-review`)
    expect(ws.branch).toBe('cjjutbaofficial/kernel-237-draw-a-question-card-that-steps')
    expect(ws.path).not.toBe(author.path)
    expect(await head(ws.path)).toBe(ws.branch)
  })

  it('refuses a branch name git would not accept, and leaves no branch behind', async () => {
    const { repo, review } = await setup()
    await expect(review('review/bad..name')).rejects.toThrow('is not a valid branch name')
    expect(await branchExists(repo, 'review/bad..name')).toBe(false)
  })

  it('leaves no new branch behind when git cannot add the worktree', async () => {
    const { repo, author, review } = await setup()
    const root = dirname(author.path)
    // git makes the branch, then fails to create the folder in a root it cannot write to.
    await chmod(root, 0o555)
    onTestFinished(() => chmod(root, 0o755))
    await expect(review('review/kernel-237-pr-213')).rejects.toThrow()
    expect(await branchExists(repo, 'review/kernel-237-pr-213')).toBe(false)
  })
})

describe('folders for long branches (KERNEL-265)', () => {
  it('gives two branches that share their first 80 characters their own folders', async () => {
    const repo = await tempRepo()
    const root = join(repo, '..', 'wt-265-' + Date.now())
    const author = await createWorktree({ repo, root, branch: LONG, baseRef: 'main' })
    const review = await createWorktree({ repo, root, branch: `${LONG}-review`, baseRef: 'main' })
    expect(review).not.toBe(author)
    expect(basename(review).length).toBeLessThanOrEqual(80)
    expect(await head(author)).toBe(LONG)
    expect(await head(review)).toBe(`${LONG}-review`)
  })
})
