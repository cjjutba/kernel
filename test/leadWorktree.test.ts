import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { git, run } from '../src/main/services/exec'
import { agentPrompt } from '../src/main/services/sessions'
import { projectWorktreeRoot, slugify } from '../src/main/services/worktrees'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { setUp, tempRepo, freePort } from './helpers'

// KERNEL-405: each chat with Kernel is its own workspace, with its own worktree, branch, ports and setup. It replaces KERNEL-355's
// one Lead worktree per project, and KERNEL-181's sync now runs per chat.

const sdk = vi.hoisted(() => ({ calls: [] as { options: any }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: unknown }) => {
    sdk.calls.push({ options })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 0 })
    }
  }
}))

const REPO = {
  'README.md': '# client\n',
  '.gitignore': '.env.local\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.'
}

async function dirs(workspace: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', ...workspace } }))
  return { dataDir, home }
}

/** A started Kernel on `where`, stopped when the test ends. Sends are real, into the mocked SDK, which records each session. */
async function boot(where: { dataDir: string; home: string }) {
  const k = new Kernel(where)
  k.signedInReader = async () => true
  await k.start()
  // The mocked sessions never end a turn, so the quit doesn't wait for them.
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  return k
}

const sha = async (repo: string, ref: string) => (await git(repo, 'rev-parse', ref)).trim()
const branchOf = async (path: string) => (await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()
const queuedText = (k: Kernel, chatId: string) => k.sessions.queued(chatId).map((q) => q.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
const callIn = (path: string) => sdk.calls.filter((c) => c.options.cwd === path)

/** A repo with an `origin`, as most projects have. */
async function withOrigin(files: Record<string, string> = {}) {
  const repo = await tempRepo({ ...REPO, ...files })
  const bare = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
  await run('git', ['init', '-q', '--bare', bare])
  await run('git', ['-C', repo, 'remote', 'add', 'origin', bare])
  await run('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'main'])
  return { repo, bare }
}

/** Someone else pushes a commit to `branch` on the remote, which the project hasn't fetched. Its sha. */
async function pushElsewhere(bare: string, file: string, branch = 'main') {
  const other = await mkdtemp(join(tmpdir(), 'kernel-clone-'))
  await run('git', ['clone', '-q', bare, other])
  const has = (await run('git', ['-C', other, 'rev-parse', '--verify', '--quiet', `origin/${branch}`]).then(() => true, () => false))
  await run('git', ['-C', other, 'checkout', '-q', '-B', branch, has ? `origin/${branch}` : 'origin/main'])
  await writeFile(join(other, `${file}.txt`), `${file}\n`)
  await run('git', ['-C', other, 'add', '-A'])
  await run('git', ['-C', other, '-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', file])
  await run('git', ['-C', other, 'push', '-q', 'origin', branch])
  return sha(other, 'HEAD')
}

describe('a workspace per chat with Kernel (KERNEL-405)', () => {
  it('fetches, then makes a worktree on kernel/<slug> from the latest origin/main, and sends the first message once it exists', async () => {
    const { repo, bare } = await withOrigin()
    const where = await dirs()
    const k = await boot(where)
    const project = await k.addProject(repo)
    // Merged on GitHub and not fetched yet: ⌘N fetches first.
    const merged = await pushElsewhere(bare, 'merged')
    await writeFile(join(repo, 'notes.txt'), 'mine\n')
    sdk.calls.length = 0
    const chat = await k.handlers()['lead.start']({ projectId: project.id, prompt: 'Plan wave 3 of the invoices work' })
    const ws = k.store.workspace(chat.workspaceId)!
    expect(ws).toMatchObject({ lead: true, threadId: chat.threadId, agentId: 'kernel-lead', mode: 'worktree', branch: 'kernel/plan-wave-3-of-invoices', baseRef: 'origin/main', status: 'setup' })
    expect(ws.path).toBe(join(projectWorktreeRoot(join(where.home, 'wt'), project), 'kernel-plan-wave-3-of-invoices'))
    // lead.start answers before the fetch and the worktree, and the message waits for them (KERNEL-542).
    await k.workspaces.worktreeMade(ws.id)
    expect(await sha(ws.path, 'HEAD')).toBe(merged)
    expect(await branchOf(ws.path)).toBe(ws.branch)
    // Nothing waits for setup by default (KERNEL-490).
    await vi.waitFor(() => expect(k.sessions.isHeld(chat.id)).toBe(false))
    await vi.waitFor(() => expect(callIn(ws.path)).toHaveLength(1))
    expect(k.sessions.queued(chat.id)).toEqual([])
    await setUp(k, chat.id)
    // The main checkout is left alone: same branch, same commit, its own files.
    expect(await branchOf(repo)).toBe('main')
    expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('mine\n')
    expect(existsSync(join(ws.path, 'notes.txt'))).toBe(false)
  })

  it('gives two chats two worktrees, two branches and two port blocks, and a + tab joins its own chat', async () => {
    const { repo } = await withOrigin()
    const k = await boot(await dirs())
    const project = await k.addProject(repo)
    const a = await k.handlers()['lead.start']({ projectId: project.id, prompt: 'Plan the release' })
    const b = await k.handlers()['lead.start']({ projectId: project.id, prompt: 'Plan the release' })
    const [wa, wb] = [await setUp(k, a.id), await setUp(k, b.id)]
    expect(wa.id).not.toBe(wb.id)
    expect([wa.branch, wb.branch]).toEqual(['kernel/plan-release', 'kernel/plan-release-2'])
    expect(wa.path).not.toBe(wb.path)
    expect(Math.abs(wa.port - wb.port)).toBeGreaterThanOrEqual(10)
    expect(k.env.envFor(wb)).toMatchObject({ KERNEL_PORT: String(wb.port), KERNEL_WORKSPACE: wb.path, KERNEL_BRANCH: 'kernel/plan-release-2', KERNEL_BASE_REF: 'origin/main', KERNEL_DEFAULT_BRANCH: 'main' })
    const tab = await k.handlers()['chats.create']({ workspaceId: wb.id })
    expect(tab).toMatchObject({ workspaceId: wb.id, threadId: b.threadId, title: 'New tab' })
    expect(k.chatTabs(wa.id).map((c) => c.id)).toEqual([a.id])
    expect((await k.handlers()['lead.open']({ projectId: project.id }))?.id).toBe(wb.id)
  })

  it('starts from the target branch picked in New chat, after a fetch', async () => {
    const { repo, bare } = await withOrigin()
    const k = await boot(await dirs())
    const project = await k.addProject(repo)
    const release = await pushElsewhere(bare, 'release-fix', 'release/v2')
    const chat = await k.handlers()['lead.start']({ projectId: project.id, prompt: 'Check the release', baseRef: 'origin/release/v2' })
    const ws = await setUp(k, chat.id)
    expect(ws).toMatchObject({ baseRef: 'origin/release/v2', branch: 'kernel/check-release' })
    expect(await sha(ws.path, 'HEAD')).toBe(release)
  })

  it('copies files and runs setup like a teammate, holds the message through a failed setup with Wait for setup on, and Run again sends it', async () => {
    const repo = await tempRepo({ ...REPO, '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt && echo set up"\n' })
    await writeFile(join(repo, '.env.local'), 'SECRET=1\n')
    const k = await boot(await dirs({ leadWaitForSetup: true }))
    const project = await k.addProject(repo)
    sdk.calls.length = 0
    const chat = await k.lead.startLeadChat(project.id, { prompt: 'Plan it' })
    const ws = await setUp(k, chat.id, 'failed')
    expect(await readFile(join(ws.path, '.env.local'), 'utf8')).toBe('SECRET=1\n')
    expect(queuedText(k, chat.id)).toEqual(['Plan it'])
    // A second tab of a chat whose setup failed waits with it.
    const tab = await k.handlers()['chats.create']({ workspaceId: ws.id })
    await k.sessions.send(tab.id, [{ type: 'text', text: 'And this' }])
    expect(queuedText(k, tab.id)).toEqual(['And this'])
    expect(callIn(ws.path)).toHaveLength(0)
    await writeFile(join(ws.path, 'ok.txt'), 'ok\n')
    expect((await k.setup.retrySetup(ws.id)).status).toBe('ready')
    await vi.waitFor(() => expect(callIn(ws.path)).toHaveLength(2))
    expect(k.sessions.queued(chat.id)).toEqual([])
    expect(k.sessions.queued(tab.id)).toEqual([])
  })

  // Naming the branch and folder from the chat's title: leadNaming.test.ts (KERNEL-424).

  it('follows its own branch pattern, from Settings or the project', async () => {
    const repo = await tempRepo({ ...REPO, '.kernel/settings.local.toml': '[workspace]\nlead_branch_pattern = "plans/{lead}-{slug}"\n' })
    const k = await boot(await dirs({ leadBranchPattern: 'lead/{slug}' }))
    const project = await k.addProject(repo)
    const ws = await setUp(k, (await k.lead.startLeadChat(project.id, { prompt: 'Release notes' })).id)
    expect(ws.branch).toBe('plans/kernel-release-notes')
  })

  it('keeps Kernel on the checkout in a repo with no commit yet, with no setup', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-'))
    await run('git', ['init', '-q', '-b', 'main', repo])
    for (const [f, c] of Object.entries(REPO)) { await mkdir(join(repo, f, '..'), { recursive: true }); await writeFile(join(repo, f), c) }
    const k = await boot(await dirs())
    const project = await k.addProject(repo)
    sdk.calls.length = 0
    const chat = await k.lead.startLeadChat(project.id, { prompt: 'Plan it' })
    expect(k.store.workspace(chat.workspaceId)).toMatchObject({ mode: 'current', path: repo, lead: true, status: 'ready' })
    await vi.waitFor(() => expect(callIn(repo)).toHaveLength(1))
  })

  it("runs Kernel in its worktree with the checkout's project config, and tells it its branch and that the checkout isn't its", async () => {
    const repo = await tempRepo(REPO)
    const k = await boot(await dirs())
    const project = await k.addProject(repo)
    sdk.calls.length = 0
    const chat = await k.lead.startLeadChat(project.id, { prompt: 'Plan the PDF export' })
    const ws = await setUp(k, chat.id)
    await vi.waitFor(() => expect(callIn(ws.path)).toHaveLength(1))
    const options = callIn(ws.path)[0].options
    expect(options).toMatchObject({ cwd: ws.path, projectConfigRoot: repo })
    expect(options.systemPrompt.append).toContain(`You are working in a git worktree at ${ws.path} on branch ${ws.branch}, created from main. It is not the main checkout, which the user may be running.`)
    const christian = await k.createWorkspace(project.id, { prompt: 'Build it', agentId: 'christian', title: 'Build' })
    await vi.waitFor(() => expect(callIn(christian.path)).toHaveLength(1))
    expect(callIn(christian.path)[0].options).not.toHaveProperty('projectConfigRoot')
    expect(agentPrompt(undefined, christian)).not.toContain('It is not the main checkout')
    expect(agentPrompt(undefined, christian)).toContain(`Push with \`git push -u origin ${christian.branch}\` (or \`HEAD\`), never a bare \`git push\`.`)
  })

  it("reads the project's env files from the chat's own worktree, where files.copy put them", async () => {
    const repo = await tempRepo({ ...REPO, '.kernel/settings.toml': '[env]\nfiles = [".env.local"]\n' })
    await writeFile(join(repo, '.env.local'), 'FROM_COPY=1\n')
    const k = await boot(await dirs())
    const project = await k.addProject(repo)
    const ws = await setUp(k, (await k.lead.leadChat(project.id)).id)
    expect(await readFile(join(ws.path, '.env.local'), 'utf8')).toBe('FROM_COPY=1\n')
    expect(k.env.envFor(ws)).toMatchObject({ FROM_COPY: '1', KERNEL_WORKSPACE: ws.path, KERNEL_ROOT_PATH: repo })
  })

  it('refuses Fork into new workspace for a chat with Kernel, and lets Create PR run on its branch', async () => {
    const repo = await tempRepo(REPO)
    const k = await boot(await dirs())
    const project = await k.addProject(repo)
    const chat = await k.lead.leadChat(project.id)
    await setUp(k, chat.id)
    await expect(k.workspaces.forkWorkspace(chat.id)).rejects.toThrow("A chat with Kernel can't fork")
    expect(k.team.isLeadWorkspace(k.store.workspace(chat.workspaceId)!)).toBe(true)
  })
})

// KERNEL-490: Kernel's first message waits only when Wait for setup is on and a setup script runs on create. A teammate's brief
// always waits.
describe('what waits for setup (KERNEL-490)', () => {
  const SETUP = { '.kernel/settings.toml': '[scripts]\nsetup = "sleep 1 && echo set up"\n' }

  /** A started Kernel on a project made of `files`, with `workspace` in its settings. */
  async function project(files: Record<string, string>, workspace: Record<string, unknown> = {}) {
    const repo = await tempRepo({ ...REPO, ...files })
    const k = await boot(await dirs(workspace))
    const r = await k.addProject(repo)
    sdk.calls.length = 0
    return { k, project: r }
  }

  /**
   * Kernel's message went out once the worktree existed, without waiting for setup, so the chat isn't empty and shows the turn,
   * not the "Running setup" line (KERNEL-542).
   */
  const sentAtOnce = async (k: Kernel, chat: Chat) => {
    await vi.waitFor(() => expect(k.sessions.isHeld(chat.id)).toBe(false))
    expect(k.sessions.queued(chat.id)).toEqual([])
    expect(k.store.items(chat.id).filter((i) => i.kind === 'user')).toHaveLength(1)
    await vi.waitFor(() => expect(callIn(k.store.workspace(chat.workspaceId)!.path)).toHaveLength(1))
  }

  it("sends Kernel's first message at once by default, while the setup script runs", async () => {
    const { k, project: r } = await project(SETUP)
    const chat = await k.lead.startLeadChat(r.id, { prompt: 'Plan it' })
    await sentAtOnce(k, chat)
    expect(k.store.workspace(chat.workspaceId)!.status).toBe('setup')
    expect((await setUp(k, chat.id)).setupRun).toMatchObject({ end: 0 })
  })

  it('holds it until setup passes with Wait for setup on and a setup script', async () => {
    const { k, project: r } = await project(SETUP, { leadWaitForSetup: true })
    const chat = await k.lead.startLeadChat(r.id, { prompt: 'Plan it' })
    const ws = k.store.workspace(chat.workspaceId)!
    expect(queuedText(k, chat.id)).toEqual(['Plan it'])
    expect(k.sessions.queueReason(chat.id)).toBe('setup')
    expect(callIn(ws.path)).toHaveLength(0)
    await setUp(k, chat.id)
    await vi.waitFor(() => expect(callIn(ws.path)).toHaveLength(1))
    expect(k.sessions.queued(chat.id)).toEqual([])
  })

  it("keeps the window's id on the prompt through setup and on what the chat's handlers send next (KERNEL-894)", async () => {
    const { k, project: r } = await project(SETUP, { leadWaitForSetup: true })
    const h = k.handlers()
    const chat = await h['lead.start']({ projectId: r.id, prompt: 'Plan it', clientId: 'c-start' })
    expect(k.sessions.queued(chat.id).map((q) => q.id)).toEqual(['c-start'])
    await setUp(k, chat.id)
    await vi.waitFor(() => expect(k.store.items(chat.id).filter((i) => i.kind === 'user').map((i) => i.id)).toEqual(['c-start']))
    // The mocked turn never ends, so each of these waits behind it under its id.
    expect(await h['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'And the tests' }], clientId: 'c-send' })).toMatchObject({ queued: true })
    await h['chats.sendNow']({ chatId: chat.id, id: 'c-send', clientId: 'c-now' })
    await h['chats.retry']({ chatId: chat.id, itemId: 'c-start', clientId: 'c-retry' })
    expect(k.sessions.queued(chat.id).map((q) => q.id)).toEqual(['c-now', 'c-retry'])
  })

  it.each([
    ['the project has no setup script', {}, true],
    ['Run setup on create is off', SETUP, false]
  ] as const)('sends it at once with Wait for setup on when %s, and runs no setup', async (_, files, setupOnCreate) => {
    const { k, project: r } = await project(files, { leadWaitForSetup: true })
    if (!setupOnCreate) await k.config.setSettings({ scripts: { setupOnCreate } })
    const chat = await k.lead.startLeadChat(r.id, { prompt: 'Plan it' })
    await sentAtOnce(k, chat)
    expect((await setUp(k, chat.id)).setupRun).toBeUndefined()
  })

  it("sends it at once when the project's own file turns Wait for setup off", async () => {
    const { k, project: r } = await project({ ...SETUP, '.kernel/settings.local.toml': '[workspace]\nlead_wait_for_setup = false\n' }, { leadWaitForSetup: true })
    const chat = await k.lead.startLeadChat(r.id, { prompt: 'Plan it' })
    await sentAtOnce(k, chat)
    await setUp(k, chat.id)
  })

  it.each([false, true])("holds a teammate's brief through a failed setup, with Wait for setup %s", async (leadWaitForSetup) => {
    const { k, project: r } = await project({ '.kernel/settings.toml': '[scripts]\nsetup = "exit 3"\n' }, { leadWaitForSetup })
    const ws = await k.workspaces.createWorkspace(r.id, { prompt: 'Build the invoice list', agentId: 'christian' })
    expect(ws.status).toBe('failed')
    const brief = k.chatTabs(ws.id).find((c) => c.kind !== 'terminal')!
    expect(queuedText(k, brief.id)).toEqual(['Build the invoice list'])
    expect(k.sessions.queueReason(brief.id)).toBe('setup')
    expect(callIn(ws.path)).toHaveLength(0)
  })
})

/**
 * The shared Lead workspace from before KERNEL-405, as a database from 0.2.0 holds it: open chats with tabs, one of them closed,
 * one closed chat, a session on each tab. `mode` puts it on the checkout, as CJ's is, or in `<root>/<project>/lead`.
 */
async function legacy(mode: 'current' | 'worktree') {
  const { repo } = await withOrigin()
  const where = await dirs()
  const k = await boot(where)
  const project = await k.addProject(repo)
  await k.stop()
  const store = new Store(join(where.dataDir, 'kernel.db'))
  const root = join(where.home, 'wt', slugify(project.name))
  let path = repo
  if (mode === 'worktree') {
    path = join(root, 'lead')
    await mkdir(root, { recursive: true })
    await run('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', path, 'origin/main'])
  }
  const old: Workspace = { id: 'old-lead', projectId: project.id, name: 'lead', branch: mode === 'current' ? 'main' : 'HEAD', baseRef: mode === 'current' ? 'main' : 'origin/main', path, mode, agentId: 'kernel-lead', lead: true, port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
  store.saveWorkspace(old)
  const t = (id: string, title: string, at: number, closedAt?: number) => store.saveThread({ id, projectId: project.id, title, createdAt: at, ...(closedAt ? { closedAt } : {}) })
  t('plan', 'Plan wave 3', 1)
  t('icons', 'Chat icons sizing', 2)
  t('done', 'Old question', 3, 5)
  const tab = (id: string, threadId: string, o: Partial<Chat> = {}) => store.saveChat({ id, workspaceId: old.id, title: id, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, threadId, sessionId: `session-${id}`, createdAt: 1, ...o })
  tab('plan-1', 'plan')
  tab('plan-2', 'plan', { closed: true })
  tab('plan-3', 'plan')
  tab('icons-1', 'icons')
  tab('done-1', 'done', { closed: true })
  store.saveChat({ id: 'term', workspaceId: old.id, title: 'Claude', kind: 'terminal', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1 })
  // A message that waited in a tab when Kernel quit.
  store.saveMeta('queues', { 'plan-1': [{ id: 'q1', chatId: 'plan-1', parts: [{ type: 'text', text: 'Carry on' }], ts: 1 }] })
  store.saveMeta('leadChatsMoved', false)
  store.db.close()
  // The user's own setup, which takes long enough to see the chats held while it runs.
  await mkdir(join(repo, '.kernel'), { recursive: true })
  await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[scripts]\nsetup = "sleep 1"\n')
  await mkdir(join(path, '.kernel', 'plans'), { recursive: true })
  await writeFile(join(path, '.kernel', 'plans', 'wave-3.md'), '# Wave 3\n')
  await writeFile(join(repo, 'untracked.txt'), 'the user is working here\n')
  return { repo, where, project, old, path }
}

describe('moving the open chats out of the shared Lead workspace at startup (KERNEL-405)', () => {
  for (const mode of ['current', 'worktree'] as const) {
    it(`gives each open chat its own worktree with its tabs and sessions, and archives the old record (${mode})`, async () => {
      const { repo, where, project, old, path } = await legacy(mode)
      const headBefore = await sha(repo, 'HEAD')
      const k = await boot(where)
      const moved = k.lead.chatWorkspaces(project.id)
      expect(moved.map((w) => [w.threadId, w.branch, w.mode, w.lead])).toEqual([['plan', 'kernel/plan-wave-3', 'worktree', true], ['icons', 'kernel/chat-icons-sizing', 'worktree', true]])
      // Every tab of each open chat moves with it, a closed one too, and keeps its session (KERNEL-348).
      const plan = moved[0]
      expect(k.store.chats(plan.id).map((c) => [c.id, c.sessionId, !!c.closed])).toEqual([['plan-1', 'session-plan-1', false], ['plan-2', 'session-plan-2', true], ['plan-3', 'session-plan-3', false]])
      expect(k.store.chats(moved[1].id).map((c) => c.id)).toEqual(['icons-1'])
      // The closed chat stays with the old record, which is archived, and the old record's terminal closes.
      expect(k.store.chats(old.id).map((c) => [c.id, !!c.closed])).toEqual([['done-1', true], ['term', true]])
      expect(k.store.workspace(old.id)).toMatchObject({ status: 'archived' })
      expect(k.store.thread('done')!.closedAt).toBe(5)
      // The plans its chats wrote come along.
      expect(await readFile(join(plan.path, '.kernel', 'plans', 'wave-3.md'), 'utf8')).toBe('# Wave 3\n')
      // Setup runs with the chats held, and they carry on once it passes. A quit didn't cut this setup short, so it isn't failed.
      expect(moved.map((w) => w.status)).toEqual(['setup', 'setup'])
      expect(k.sessions.isHeld('plan-1')).toBe(true)
      expect(k.sessions.isHeld('plan-3')).toBe(true)
      expect(queuedText(k, 'plan-1')).toEqual(['Carry on'])
      sdk.calls.length = 0
      for (const w of moved) await setUp(k, w.id)
      expect(k.sessions.isHeld('plan-1')).toBe(false)
      // What waited goes once setup passed, in the new folder, resuming the chat's session.
      await vi.waitFor(() => expect(callIn(plan.path).map((c) => c.options.resume)).toEqual(['session-plan-1']))
      expect(k.store.thread('plan')!.closedAt).toBeUndefined()
      // The checkout is untouched, and on the checkout nothing was removed. A worktree goes.
      expect(await sha(repo, 'HEAD')).toBe(headBefore)
      expect(await branchOf(repo)).toBe('main')
      expect(await readFile(join(repo, 'untracked.txt'), 'utf8')).toBe('the user is working here\n')
      if (mode === 'current') expect(existsSync(join(repo, '.kernel', 'plans', 'wave-3.md'))).toBe(true)
      else {
        await k.archive.trashEmptied()
        expect(existsSync(path)).toBe(false)
        expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain(`${path}\n`)
      }
      expect(k.store.meta('leadChatsMoved')).toBe(true)
      // The old record can't be deleted from History, and lead.open finds the newest chat.
      expect((await k.history.deletePreview([old.id])).skipped).toEqual([{ id: old.id, name: 'lead', reason: "It is Kernel's workspace." }])
      expect((await k.handlers()['lead.open']({ projectId: project.id }))?.id).toBe(moved[1].id)
      await k.stop()

      // A second start moves nothing.
      const again = await boot(where)
      expect(again.store.workspaces(project.id).filter((w) => w.lead).map((w) => w.id).sort()).toEqual([old.id, ...moved.map((w) => w.id)].sort())
    })
  }
})

// KERNEL-181: each chat's worktree follows the latest main, on its own.

/** Commits on main in `repo` and pushes, so origin/main moves there without a fetch. */
async function landOnMain(repo: string, file: string, n = 1) {
  for (let i = 0; i < n; i++) {
    await writeFile(join(repo, `${file}-${i}.txt`), `${file} ${i}\n`)
    await run('git', ['-C', repo, 'add', '-A'])
    await run('git', ['-C', repo, 'commit', '-q', '-m', `${file} ${i}`])
  }
  await run('git', ['-C', repo, 'push', '-q', 'origin', 'main'])
}

/** A project with an origin and two chats with Kernel, set up and idle. Sends are recorded, not run. */
async function syncedProject() {
  const { repo, bare } = await withOrigin()
  const k = await boot(await dirs())
  k.sessions.send = async () => ({ queued: false })
  const project = await k.projects.addProject(repo)
  const a = await k.lead.newLeadChat(project.id, { prompt: '' })
  const b = await k.lead.newLeadChat(project.id, { prompt: '' })
  const [wa, wb] = [await setUp(k, a.id), await setUp(k, b.id)]
  return { k, repo, bare, project, a, b, wa, wb }
}

const syncNotes = (k: Kernel, projectId: string) => k.store.activity(projectId, 500).filter((x) => x.actor === 'kernel' && /^(updated|didn't update) Kernel's worktree/.test(x.text)).reverse()

describe("keeping each chat's worktree on the latest main (KERNEL-181, KERNEL-405)", () => {
  it('fast-forwards each idle chat on its own branch, logs one line each, and does nothing once it is current', async () => {
    const { k, repo, project, wa, wb } = await syncedProject()
    await landOnMain(repo, 'merged', 3)
    await k.lead.syncLead(project.id)
    for (const w of [wa, wb]) {
      expect(await sha(w.path, 'HEAD')).toBe(await sha(repo, 'origin/main'))
      expect(await branchOf(w.path)).toBe(w.branch)
    }
    await k.lead.syncLead(project.id)
    expect(syncNotes(k, project.id).map((x) => [x.workspaceId, x.text]).sort()).toEqual([wa.id, wb.id].map((id) => [id, "updated Kernel's worktree to origin/main, 3 new commits"]).sort())
  })

  it('moves only the chat that is idle, and a turn that ends syncs only its own chat', async () => {
    const { k, repo, project, a, b, wa, wb } = await syncedProject()
    const was = await sha(wa.path, 'HEAD')
    await landOnMain(repo, 'while-running')
    const isRunning = k.sessions.isRunning.bind(k.sessions)
    k.sessions.isRunning = (id) => id === a.id || isRunning(id)
    await k.lead.syncLead(project.id)
    expect(await sha(wa.path, 'HEAD')).toBe(was)
    expect(await sha(wb.path, 'HEAD')).toBe(await sha(repo, 'origin/main'))
    k.sessions.isRunning = isRunning
    const sync = vi.spyOn(k.lead, 'syncLead')
    ;(k.sessions as unknown as { d: { onTurnDone: (...x: unknown[]) => void } }).d.onTurnDone(wa, a, { ok: true, interrupted: false, by: 'user' })
    expect(sync).toHaveBeenCalledWith(project.id, { workspaceId: wa.id })
    await Promise.all(sync.mock.results.map((r) => r.value))
    expect(await sha(wa.path, 'HEAD')).toBe(await sha(repo, 'origin/main'))
    expect(b.id).toBeTruthy()
  })

  it('fetches once when a PR in the project merges, then moves every chat', async () => {
    const { k, bare, project, wa, wb } = await syncedProject()
    const christian = await k.workspaces.createWorkspace(project.id, { prompt: 'Build it', agentId: 'christian', title: 'Build' })
    const merged = await pushElsewhere(bare, 'merged')
    const sync = vi.spyOn(k.lead, 'syncLead')
    bus.push({ type: 'pr', workspaceId: christian.id, state: 'merged' })
    expect(sync.mock.calls).toEqual([[project.id, { fetch: true }]])
    await Promise.all(sync.mock.results.map((r) => r.value))
    expect(await sha(wa.path, 'HEAD')).toBe(merged)
    expect(await sha(wb.path, 'HEAD')).toBe(merged)
  })

  it('moves nothing when tracked files have changes or the chat has commits of its own, and logs each once per sha', async () => {
    const { k, repo, project, wa, wb } = await syncedProject()
    const was = await sha(wa.path, 'HEAD')
    await writeFile(join(wa.path, 'README.md'), '# edited by Kernel\n')
    await writeFile(join(wb.path, 'kernel.txt'), 'Kernel committed\n')
    await run('git', ['-C', wb.path, 'add', '-A'])
    await run('git', ['-C', wb.path, '-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'own'])
    const own = await sha(wb.path, 'HEAD')
    await landOnMain(repo, 'first')
    await k.lead.syncLead(project.id)
    await k.lead.syncLead(project.id)
    expect(await sha(wa.path, 'HEAD')).toBe(was)
    expect(await sha(wb.path, 'HEAD')).toBe(own)
    expect(syncNotes(k, project.id).map((x) => [x.workspaceId, x.object]).sort()).toEqual([[wa.id, 'tracked files have changes'], [wb.id, 'it has a commit of its own']].sort())
    await landOnMain(repo, 'second')
    await k.lead.syncLead(project.id)
    expect(syncNotes(k, project.id)).toHaveLength(4)
  })

  it('leaves a chat that is setting up, or whose setup failed, where it is', async () => {
    const { k, repo, project, wa } = await syncedProject()
    const was = await sha(wa.path, 'HEAD')
    k.store.saveWorkspace({ ...k.store.workspace(wa.id)!, status: 'failed' })
    await landOnMain(repo, 'merged')
    await k.lead.syncLead(project.id, { workspaceId: wa.id })
    expect(await sha(wa.path, 'HEAD')).toBe(was)
    await rm(join(repo, 'merged-0.txt'))
  })
})
