import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PrInfo, ReviewKind, Workspace } from '@shared/types'
import { mergeBlock } from '@shared/merge'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { git } from '../src/main/services/exec'
import { loadRepoSettings, reviewOf, reviewPolicyOf, saveAlwaysReview, saveReviewSettings, sharedMergeOf, upsertTomlTable } from '../src/main/services/settings'
import { inPaths, kindsFor, lensAgent } from '../src/main/services/lenses'
import { toolPolicy } from '../src/main/services/agentTools'
import { reviewRule } from '../src/main/services/handoff'
import { tempRepo } from './helpers'

// KERNEL-549: kinds of review (code, security, UX) that Kernel starts itself when a PR passes checks.

// Each session's options, so a test can see what a review chat runs with. No Claude Code process ever starts.
const { queries } = vi.hoisted(() => ({ queries: [] as { options: { cwd?: string; disallowedTools?: string[]; systemPrompt?: { append?: string } } }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => {
  const stub = await import('./sdkStub')
  return { ...await original<object>(), query: (a: (typeof queries)[number]) => { queries.push(a); return stub.query() } }
})

const AGENTS = {
  'README.md': '# shop\n',
  '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\ntools: Read, Edit, Write, Bash\n---\nYou are Kai.',
  // Can edit by its tools line, which a review chat overrides.
  '.claude/agents/wren.md': '---\nname: wren\ndescription: Designer.\nrole: Designer\ntools: Read, Edit, Write, NotebookEdit, Bash\n---\nYou are Wren, and you look at screens.'
}

/** A room with no reviewer agent and no built-ins (no starter folder), its `[review]` committed on main. Automatic review is on unless `app` says otherwise. */
async function setup(o: { settings?: string; files?: Record<string, string>; app?: object } = {}) {
  const repo = await tempRepo({ ...AGENTS, ...(o.settings ? { '.kernel/settings.toml': o.settings } : {}), ...o.files })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ version: 2, hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { autoReview: true }, ...o.app }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  const room = await k.addRoom(repo)
  let n = 0
  /** Kai's work in its own worktree, committed and on a PR that passed checks. */
  const pr = async (files: Record<string, string>, agentId = 'kai') => {
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId, title: `Task ${++n}` })
    for (const [f, c] of Object.entries(files)) { await mkdir(dirname(join(ws.path, f)), { recursive: true }); await writeFile(join(ws.path, f), c) }
    await git(ws.path, 'add', '-A')
    await git(ws.path, 'commit', '-qm', 'work')
    const head = (await git(ws.path, 'rev-parse', 'HEAD')).trim()
    k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prNumber: 100 + n, prTitle: `Task ${n}`, prState: 'ready', prHead: head })
    return k.store.workspace(ws.id)!
  }
  const reviewsOf = (id: string) => k.store.workspaces(room.id).filter((w) => w.reviewOf === id)
  const lenses = (rws: Workspace) => k.store.chats(rws.id).map((c) => c.lens)
  const chatOf = (rws: Workspace, kind: ReviewKind) => k.store.chats(rws.id).find((c) => c.lens?.kind === kind)!
  return { k, repo, room, pr, reviewsOf, lenses, chatOf }
}

const info = (ws: Workspace): PrInfo => ({ workspaceId: ws.id, number: ws.prNumber!, url: '', title: '', state: 'ready', baseRef: 'main', checks: [], comments: [], conflicts: [], head: ws.prHead! })
const UX_ON = '# Reviews for this repo.\n[review.ux]\npaths = ["src/renderer/**"]\n'

describe('which reviews a PR gets', () => {
  it('gives a PR outside every kind\'s paths the code review only, in a review workspace Kernel starts itself', async () => {
    const { k, pr, reviewsOf, lenses } = await setup({ settings: UX_ON })
    const ws = await pr({ 'docs/notes.md': 'notes\n' })
    await k.reviews.onReady(ws.id)
    const [rws] = reviewsOf(ws.id)
    expect(reviewsOf(ws.id)).toHaveLength(1)
    expect(rws).toMatchObject({ reviewOf: ws.id, status: 'ready', agentId: 'kernel-reviewer', title: `Review PR #${ws.prNumber}` })
    expect(lenses(rws)).toEqual([{ kind: 'code' }])
    expect(k.store.chats(rws.id)[0].title).toBe('Code review')
  })

  it('adds the UX review as a second chat of the same review workspace when the PR touches its paths', async () => {
    const { k, pr, reviewsOf, lenses } = await setup({ settings: UX_ON })
    const ws = await pr({ 'src/renderer/App.tsx': 'export {}\n' })
    await k.reviews.onReady(ws.id)
    const [rws] = reviewsOf(ws.id)
    expect(reviewsOf(ws.id)).toHaveLength(1)
    expect(lenses(rws)).toEqual([{ kind: 'code' }, { kind: 'ux' }])
    // One worktree for both: the chats share it.
    expect(new Set(k.store.chats(rws.id).map((c) => c.workspaceId))).toEqual(new Set([rws.id]))
  })

  it('adds a kind to the open review workspace when a later push touches its paths', async () => {
    const { k, pr, reviewsOf, lenses } = await setup({ settings: UX_ON })
    const ws = await pr({ 'docs/notes.md': 'notes\n' })
    await k.reviews.onReady(ws.id)
    const sent: { chatId: string; text: string }[] = []
    k.sessions.send = async (chatId, parts) => { sent.push({ chatId, text: parts.map((p) => (p.type === 'text' ? p.text : '')).join('') }); return { queued: false } }
    await writeFile(join(ws.path, 'src-renderer.txt'), 'not a match\n')
    await mkdir(join(ws.path, 'src', 'renderer'), { recursive: true })
    await writeFile(join(ws.path, 'src', 'renderer', 'Home.tsx'), 'export {}\n')
    await git(ws.path, 'add', '-A')
    await git(ws.path, 'commit', '-qm', 'screens')
    k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prHead: (await git(ws.path, 'rev-parse', 'HEAD')).trim() })
    await k.reviews.onReady(ws.id)
    const [rws] = reviewsOf(ws.id)
    expect(reviewsOf(ws.id)).toHaveLength(1)
    expect(lenses(rws)).toEqual([{ kind: 'code' }, { kind: 'ux' }])
    // The code review is asked to look at the new commit, once, and the new kind gets its brief.
    const [code, ux] = k.store.chats(rws.id)
    expect(sent.map((m) => m.chatId)).toEqual([code.id, ux.id])
    expect(sent[0].text).toMatch(new RegExp(`^PR #${ws.prNumber} has new commits, up to [0-9a-f]{7}\\. Review it again`))
    expect(sent[1].text).toBe(`Run the UX review of PR #${ws.prNumber} "Task 1" by Kai.`)
    await k.reviews.onReady(ws.id)
    expect(sent).toHaveLength(2)
  })

  it('gives a room with no reviewer agent a code review on every PR, from Kernel\'s own prompt', async () => {
    const { k, pr, reviewsOf, chatOf } = await setup()
    const ws = await pr({ 'a.txt': 'a\n' })
    await k.reviews.onReady(ws.id)
    const [rws] = reviewsOf(ws.id)
    const chat = chatOf(rws, 'code')
    const agent = k.sessions['d'].agentFor(rws, chat)!
    expect(agent).toMatchObject({ id: 'kernel-reviewer', name: 'Code review', prompt: expect.stringMatching(/^You run the code review of a pull request\./) })
    const rule = k.tools.rulesFor(rws, agent, chat)!
    expect(rule).toContain("You are reviewing Kai's work")
    expect(rule).toContain('You run the code review of it.')
    expect(rule).toContain('mcp__kernel__submit_review')
  })

  it("runs the code review with the room's reviewer, as the base branch's [team] picks it, and none with reviewer = \"none\"", async () => {
    const theo = { '.claude/agents/theo.md': '---\nname: theo\ndescription: Reviewer.\nrole: Reviewer\ntools: Read, Grep, Bash\n---\nYou are Theo.' }
    const own = await setup({ files: theo })
    const ws = await own.pr({ 'a.txt': 'a\n' })
    await own.k.reviews.onReady(ws.id)
    const [rws] = own.reviewsOf(ws.id)
    expect(rws.agentId).toBe('theo')
    expect(own.lenses(rws)).toEqual([{ kind: 'code', agent: 'theo' }])
    expect(own.k.sessions['d'].agentFor(rws, own.chatOf(rws, 'code'))).toMatchObject({ id: 'theo', prompt: 'You are Theo.' })

    const none = await setup({ files: theo, settings: '[team]\nreviewer = "none"\n' })
    const quiet = await none.pr({ 'a.txt': 'a\n' })
    await none.k.reviews.onReady(quiet.id)
    expect(none.reviewsOf(quiet.id)).toEqual([])
  })

  it('takes the model and an agent for a kind from its table', async () => {
    const { k, pr, reviewsOf, lenses, chatOf } = await setup({ settings: '[review.security]\nagent = "wren"\nrequired = false\nmodel = "claude-haiku-4-5-20251001"\n' })
    const ws = await pr({ 'a.txt': 'a\n' })
    await k.reviews.onReady(ws.id)
    const [rws] = reviewsOf(ws.id)
    expect(lenses(rws)).toEqual([{ kind: 'code' }, { kind: 'security', agent: 'wren', optional: true }])
    expect(chatOf(rws, 'security')).toMatchObject({ title: 'Security review', model: 'claude-haiku-4-5-20251001' })
    expect(k.sessions['d'].agentFor(rws, chatOf(rws, 'security'))).toMatchObject({ id: 'wren' })
  })

  it("never lets an agent review its own PR with its own prompt", async () => {
    const { k, pr, reviewsOf, lenses, chatOf } = await setup({ settings: '[review.ux]\nagent = "wren"\n\n[review.security]\nagent = "kai"\n' })
    const ws = await pr({ 'a.txt': 'a\n' }, 'kai')
    await k.reviews.onReady(ws.id)
    const [rws] = reviewsOf(ws.id)
    // Kai wrote it, so the security review runs Kernel's prompt. Wren didn't, so the UX review is Wren's.
    expect(lenses(rws)).toEqual([{ kind: 'code' }, { kind: 'security' }, { kind: 'ux', agent: 'wren' }])
    expect(k.sessions['d'].agentFor(rws, chatOf(rws, 'security'))).toMatchObject({ id: 'kernel-reviewer', prompt: expect.stringMatching(/^You run the security review/) })
    const wrens = await setup({ settings: '[review.ux]\nagent = "wren"\n' })
    const own = await wrens.pr({ 'a.txt': 'a\n' }, 'wren')
    await wrens.k.reviews.onReady(own.id)
    expect(wrens.lenses(wrens.reviewsOf(own.id)[0])).toEqual([{ kind: 'code' }, { kind: 'ux' }])
  })

  it("reviews a PR that edits [review] by its base branch's [review], not its own or the checkout's", async () => {
    const { k, repo, pr, reviewsOf, lenses } = await setup({ settings: '[review.security]\nenabled = false\n' })
    // The PR turns security on and code off, and so does an edit in the main checkout nobody committed.
    const edit = '[review.code]\nenabled = false\n\n[review.security]\nenabled = true\n'
    await writeFile(join(repo, '.kernel', 'settings.toml'), edit)
    const ws = await pr({ '.kernel/settings.toml': edit })
    await k.reviews.onReady(ws.id)
    expect(lenses(reviewsOf(ws.id)[0])).toEqual([{ kind: 'code' }])
  })

  it('starts no review by itself with auto review off', async () => {
    const { k, pr, reviewsOf } = await setup({ settings: UX_ON, app: { pr: { autoReview: false } } })
    const ws = await pr({ 'src/renderer/App.tsx': 'export {}\n' })
    await k.reviews.onReady(ws.id)
    bus.push({ type: 'pr', workspaceId: ws.id, state: 'ready' })
    await new Promise((r) => setTimeout(r, 300))
    expect(reviewsOf(ws.id)).toEqual([])
  })

  it('with auto review off, says so only when a review would have started (feat-automatic-review-off-by-default)', async () => {
    const off = await setup({ settings: UX_ON, app: { pr: { autoReview: false } } })
    const ws = await off.pr({ 'src/renderer/App.tsx': 'export {}\n' })
    expect(off.k.reviews.reviewState(ws).notStarted).toBeUndefined()
    await off.k.reviews.onReady(ws.id)
    expect(off.reviewsOf(ws.id)).toEqual([])
    expect(off.k.reviews.reviewState(ws).notStarted).toBe(true)
    // A new head nobody read yet says nothing, and neither does the setting turned on.
    expect(off.k.reviews.reviewState({ ...ws, prHead: 'f'.repeat(40) }).notStarted).toBeUndefined()
    off.k.settings.pr.autoReview = true
    expect(off.k.reviews.reviewState(ws).notStarted).toBeUndefined()

    // `[review]` asks for no review of this PR, so none would have run with the setting on either.
    const none = await setup({ settings: '[team]\nreviewer = "none"\n', app: { pr: { autoReview: false } } })
    const quiet = await none.pr({ 'a.txt': 'a\n' })
    await none.k.reviews.onReady(quiet.id)
    expect(none.k.reviews.reviewState(quiet).notStarted).toBeUndefined()

    // A review of the head already started, here by Kernel before the setting went off.
    const had = await setup()
    const reviewed = await had.pr({ 'a.txt': 'a\n' })
    await had.k.reviews.onReady(reviewed.id)
    expect(had.reviewsOf(reviewed.id)).toHaveLength(1)
    had.k.settings.pr.autoReview = false
    await had.k.reviews.onReady(reviewed.id)
    expect(had.k.reviews.reviewState(had.k.store.workspace(reviewed.id)!).notStarted).toBeUndefined()
    // With its review workspace archived, the round the head had still counts.
    had.k.store.saveWorkspace({ ...had.reviewsOf(reviewed.id)[0], status: 'archived' })
    await had.k.reviews.onReady(reviewed.id)
    expect(had.k.reviews.reviewState(had.k.store.workspace(reviewed.id)!).notStarted).toBeUndefined()
  })

  it('starts the reviews when a PR moves to ready, and reads them as running meanwhile', async () => {
    const { k, pr, reviewsOf } = await setup()
    const ws = await pr({ 'a.txt': 'a\n' })
    bus.push({ type: 'pr', workspaceId: ws.id, state: 'ready' })
    expect(k.reviews.reviewState(ws).inProgress).toBe(true)
    await vi.waitFor(() => expect(reviewsOf(ws.id)[0]?.status).toBe('ready'), { timeout: 10_000, interval: 20 })
  })
})

describe('a review chat', () => {
  it("can't edit or write, even when its agent's tools line allows it", async () => {
    const { k, pr, reviewsOf, chatOf } = await setup({ settings: '[review.ux]\nagent = "wren"\n' })
    const ws = await pr({ 'a.txt': 'a\n' })
    await k.reviews.onReady(ws.id)
    const [rws] = reviewsOf(ws.id)
    // Setup passed and the briefs went out, so each chat's session started.
    await vi.waitFor(() => expect(queries.filter((q) => q.options.cwd === rws.path)).toHaveLength(2), { timeout: 10_000, interval: 20 })
    const ux = queries.find((q) => q.options.cwd === rws.path && q.options.systemPrompt?.append?.includes('You are Wren'))!
    expect(ux.options.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']))
    expect(ux.options.disallowedTools).not.toContain('Bash')
    expect(ux.options.systemPrompt?.append).toContain('You run the UX review of it.')
    const policy = toolPolicy(k.sessions['d'].agentFor(rws, chatOf(rws, 'ux'))!.tools, { readOnly: true })!
    expect(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].map((t) => policy.allows(t, { file_path: '/tmp/x.ts' }))).toEqual([false, false, false, false])
    expect(policy.allows('Bash')).toBe(true)
    expect(policy.allows('Read')).toBe(true)
  })

  it('saves one verdict per kind, and blockers from either kind hold the merge', async () => {
    const { k, pr, reviewsOf, chatOf } = await setup({ settings: UX_ON })
    const ws = await pr({ 'src/renderer/App.tsx': 'export {}\n' })
    await k.reviews.onReady(ws.id)
    const [rws] = reviewsOf(ws.id)
    const code = chatOf(rws, 'code')
    const ux = chatOf(rws, 'ux')
    await k.reviews.submitReview(rws.id, { verdict: 'approved', summary: 'Fine.' }, code.id)
    await k.reviews.submitReview(rws.id, { verdict: 'blockers', summary: 'One thing.', blockers: [{ text: 'The button has no label.', file: 'src/renderer/App.tsx', line: 1 }] }, ux.id)
    const rules = { requireGreen: false, requireReviewer: true }
    let now = k.store.workspace(ws.id)!
    expect(now.reviews?.map((v) => [v.lens, v.verdict, v.agentId, v.sha])).toEqual([['code', 'approved', 'kernel-reviewer', ws.prHead], ['ux', 'blockers', 'kernel-reviewer', ws.prHead]])
    expect(mergeBlock(now, info(now), rules)).toBe('The UX review found 1 blocker on the latest commit. Merge anyway to go ahead.')
    expect(k.reviews.reviewState(now)).toMatchObject({ approved: ['code'], blocking: ['ux'], blockers: true })
    // The UX review looks again and approves: its verdict replaces its own, never the code review's.
    await k.reviews.submitReview(rws.id, { verdict: 'approved', summary: 'Labelled now.' }, ux.id)
    now = k.store.workspace(ws.id)!
    expect(now.reviews?.map((v) => [v.lens, v.verdict])).toEqual([['code', 'approved'], ['ux', 'approved']])
    expect(mergeBlock(now, info(now), rules)).toBeUndefined()
    expect(k.reviews.reviewState(now)).toMatchObject({ approved: ['code', 'ux'], blockers: false, waiting: [] })
  })
})

describe('[review] in the shared settings file', () => {
  it('reads the defaults: code on for every PR and required, security and UX off', () => {
    expect(reviewOf(undefined)).toEqual({
      rounds: 2,
      kinds: { code: { enabled: true, paths: [], required: true }, security: { enabled: false, paths: [], required: true }, ux: { enabled: false, paths: [], required: true } }
    })
    // A kind's table turns it on unless it says otherwise. Values of the wrong type keep their default.
    const read = reviewOf({ rounds: 3, code: { enabled: false }, security: { paths: ['src/main/**', 7], required: 'yes' }, ux: { enabled: false, agent: ' wren ', provider: 'gemini' } })
    expect(read).toEqual({
      rounds: 3,
      kinds: { code: { enabled: false, paths: [], required: true }, security: { enabled: true, paths: ['src/main/**'], required: true }, ux: { enabled: false, paths: [], required: true, agent: 'wren' } }
    })
    expect(reviewOf({ rounds: 0 }).rounds).toBe(2)
    expect(reviewPolicyOf('[team]\nreviewer = "none"\n[review.ux]\n')).toMatchObject({ team: { reviewer: 'none' }, review: { kinds: { ux: { enabled: true } } } })
    expect(reviewPolicyOf('not toml [').review).toEqual(reviewOf(undefined))
  })

  it('writes [review] through settings.setReview, keeping comments and every other table as written', async () => {
    const { k, repo, room } = await setup({ settings: '# Shared with the team.\n[pr]\nmerge_method = "rebase" # always\n\n[review.code]\n# Who reviews code.\npaths = [\n  "src/**",\n]\n' })
    const file = join(repo, '.kernel', 'settings.toml')
    const out = await k.handlers()['settings.setReview']({ roomId: room.id, review: { rounds: 3, kinds: { code: { paths: null, required: false }, ux: { enabled: true, paths: ['src/renderer/**'], agent: 'wren' } } } })
    expect(await readFile(file, 'utf8')).toBe([
      '# Shared with the team.', '[pr]', 'merge_method = "rebase" # always', '',
      '[review.code]', '# Who reviews code.', 'required = false', '',
      '[review]', 'rounds = 3', '',
      '[review.ux]', 'enabled = true', 'paths = ["src/renderer/**"]', 'agent = "wren"', ''
    ].join('\n'))
    expect(out.review).toMatchObject({ rounds: 3, kinds: { code: { enabled: true, paths: [], required: false }, ux: { enabled: true, paths: ['src/renderer/**'], agent: 'wren' } } })
    // Back to the defaults: the tables left empty go, the rest stays.
    await saveReviewSettings(repo, { rounds: null, kinds: { code: { required: null }, ux: { enabled: null, paths: [], agent: '' } } })
    expect(await readFile(file, 'utf8')).toBe('# Shared with the team.\n[pr]\nmerge_method = "rebase" # always\n')
    expect((await loadRepoSettings(repo)).review).toEqual(reviewOf(undefined))
    await expect(saveReviewSettings(repo, { rounds: 11 })).rejects.toThrow('Review rounds must be a whole number from 1 to 10.')
    // The personal file can't change the team's reviews.
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[review.security]\nenabled = true\n')
    expect((await loadRepoSettings(repo)).review?.kinds.security.enabled).toBe(false)
  })

  it('writes [merge] always_review through settings.setAlwaysReview, keeping comments and every other key as written (KERNEL-594)', async () => {
    const original = '# Shared with the team.\n[merge]\nauto = true # Kernel ignores this here\n\n[review.code]\npaths = ["src/**"]\n'
    const { k, repo, room } = await setup({ settings: original })
    const file = join(repo, '.kernel', 'settings.toml')
    expect((await loadRepoSettings(repo)).merge).toEqual({ alwaysReview: [] })
    const out = await k.handlers()['settings.setAlwaysReview']({ roomId: room.id, paths: [' src/billing/** ', '', 'db/migrations/**', 'src/billing/**'] })
    expect(await readFile(file, 'utf8')).toBe('# Shared with the team.\n[merge]\nauto = true # Kernel ignores this here\nalways_review = ["src/billing/**", "db/migrations/**"]\n\n[review.code]\npaths = ["src/**"]\n')
    expect(out.merge).toEqual({ alwaysReview: ['src/billing/**', 'db/migrations/**'] })
    // Auto-merge reads the same key, so what Settings writes is what a PR is held back by.
    expect(sharedMergeOf(await readFile(file, 'utf8'))).toEqual({ alwaysReview: ['src/billing/**', 'db/migrations/**'], ignored: ['auto'] })
    // The personal file's own list is the user's, not the team's.
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[merge]\nalways_review = ["infra/**"]\n')
    expect((await loadRepoSettings(repo)).merge).toEqual({ alwaysReview: ['src/billing/**', 'db/migrations/**'] })
    // An empty list takes the key back out and leaves the rest.
    expect((await k.handlers()['settings.setAlwaysReview']({ roomId: room.id, paths: [] })).merge).toEqual({ alwaysReview: [] })
    expect(await readFile(file, 'utf8')).toBe(original)
    // A file with no [merge] gets the table, and its last table goes untouched.
    await writeFile(file, '[review.code]\npaths = ["src/**"]\n')
    await saveAlwaysReview(repo, ['CHANGELOG.md'])
    expect(await readFile(file, 'utf8')).toBe('[review.code]\npaths = ["src/**"]\n\n[merge]\nalways_review = ["CHANGELOG.md"]\n')
    await writeFile(file, '[merge]\n[merge]\n')
    await expect(saveAlwaysReview(repo, ['a/**'])).rejects.toThrow(".kernel/settings.toml isn't valid TOML")
  })

  it('refuses a change it can\'t splice in without touching the rest of the file', () => {
    expect(() => upsertTomlTable('[review]\nrounds = 2\n[review]\n', 'review', { rounds: 3 })).toThrow(".kernel/settings.toml isn't valid TOML")
    expect(upsertTomlTable('', 'review.ux', { enabled: true, paths: ['a/**'] })).toBe('[review.ux]\nenabled = true\npaths = ["a/**"]\n')
    expect(upsertTomlTable('[review.ux]\nenabled = true\n', 'review.ux', { enabled: null })).toBe('')
  })
})

describe('paths and prompts', () => {
  it('matches globs, files and folders against the PR\'s changed files', () => {
    expect(inPaths('src/renderer/a/b.tsx', ['src/renderer/**'])).toBe(true)
    expect(inPaths('src/main/a.ts', ['src/renderer/**'])).toBe(false)
    expect(inPaths('src/renderer/App.css', ['**/*.css'])).toBe(true)
    expect(inPaths('src/renderer/App.tsx', ['src/renderer'])).toBe(true)
    expect(inPaths('src/renderer-old/App.tsx', ['src/renderer/'])).toBe(false)
    expect(inPaths('docs/a.md', ['./docs/a.md'])).toBe(true)
    const review = reviewOf({ ux: { paths: ['src/renderer/**'] }, security: { paths: ['src/main/**'] } })
    expect(kindsFor(review, ['README.md'])).toEqual(['code'])
    expect(kindsFor(review, ['src/renderer/App.tsx', 'src/main/x.ts'])).toEqual(['code', 'security', 'ux'])
    // Files git couldn't list run every kind that is on.
    expect(kindsFor(review, undefined)).toEqual(['code', 'security', 'ux'])
  })

  it("gives each kind Kernel's own read-only prompt, blocking only on its own kind of problem", () => {
    for (const kind of ['code', 'security', 'ux'] as const) expect(lensAgent(kind)).toMatchObject({ id: 'kernel-reviewer', tools: ['Read', 'Grep', 'Glob', 'Bash'], builtIn: 'reviewer' })
    expect(lensAgent('security').prompt).toContain('The code review covers those.')
    expect(lensAgent('ux').prompt).toContain('The code and security reviews cover those.')
    const rule = reviewRule({ author: 'Kai', task: 'T', workspaceId: 'w', branch: 'feat/x', base: 'origin/main', lens: 'security', others: ['code', 'ux'] })
    expect(rule).toContain('You run the security review of it. The code and UX reviews run in other chats of this workspace, so block only on what the security review covers and leave the rest to them.')
  })
})
