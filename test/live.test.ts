import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityEvent, Approval, Chat, ChatItem, RateLimit, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { exec } from '../src/main/services/exec'
import { askTitle } from '../src/main/services/titles'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { QUIT_NOTE, RELAUNCH_NUDGE, SESSION_GONE_NOTE, Sessions, TOOL_STOPPED } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'
import { trustRoom } from './helpers'

// The KERNEL-6 round trip against real Claude Code. It spends a few short Sonnet turns on the Claude plan, so it
// only runs when asked:
//   KERNEL_LIVE=1 KERNEL_LIVE_REPO=<path to a side project> pnpm test test/live.test.ts
// KERNEL_LIVE_BASE overrides the base branch (origin/main), KERNEL_LIVE_OUT where the evidence JSON goes.
// It never writes to ~/.claude/settings.json. Hooks for the outside session go to a temp settings file.

const repo = process.env.KERNEL_LIVE_REPO ?? ''
const ASK = ['git status', 'touch kernel-deny-check', 'git log']

describe.skipIf(!process.env.KERNEL_LIVE)('live round trip', () => {
  it('runs a real session through approvals, hooks and usage', { timeout: 600_000 }, async () => {
    expect(existsSync(join(repo, '.claude/agents')), 'KERNEL_LIVE_REPO needs a .claude/agents folder').toBe(true)
    const toml = join(repo, '.kernel/settings.local.toml')
    expect(existsSync(toml), `${toml} already exists; refusing to overwrite it`).toBe(false)

    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-live-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-live-home-'))
    const claudeSettingsFile = join(home, 'claude-settings.json')
    const hookPort = 18000 + Math.floor(Math.random() * 900)
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      hookPort, worktreeRoot: join(home, 'wt'),
      workspace: { baseRef: process.env.KERNEL_LIVE_BASE ?? 'origin/main' },
      models: { engineers: 'claude-sonnet-5-5', effort: 'medium' },
      permissions: { mode: 'acceptEdits', alwaysAsk: ASK, neverAllow: ['git push origin main'] }
    }))
    const madeKernelDir = !existsSync(join(repo, '.kernel'))
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(toml, '[scripts]\nsetup = "test -f package.json && echo setup ran on port $KERNEL_PORT"\n')

    const pushes: PushEvent[] = []
    const activity: ActivityEvent[] = []
    const hooks: { name: string; keys: string[] }[] = []
    const invalid: string[] = []
    const onPush = (e: PushEvent) => pushes.push(e)
    const onActivity = (e: ActivityEvent) => activity.push(e)
    const onHook = (e: { hook_event_name: string }) => hooks.push({ name: e.hook_event_name, keys: Object.keys(e).sort() })
    const onInvalid = (err: string) => invalid.push(err)
    bus.on('push', onPush); bus.on('activity', onActivity); bus.on('hook', onHook); bus.on('hook.invalid', onInvalid)

    const k = new Kernel({ dataDir, home, claudeSettingsFile })
    await k.start()
    const h = k.handlers()
    const evidence: Record<string, unknown> = { repo, hookPort }
    let wsId: string | undefined
    try {
      // AC1: the side project becomes a room and its agents load
      const room = await h['rooms.add']({ path: repo })
      const agents = await h['agents.list']({ roomId: room.id })
      evidence.agents = agents.map((a) => a.id)
      expect(agents.length).toBeGreaterThan(0)
      const agent = agents.find((a) => a.id === 'implementer') ?? agents[0]

      // The room's committed scripts and files.copy list wait for the user's trust (KERNEL-209). The trusted hash lives in
      // dataDir, so the side project is not changed. The local override above replaces only `setup`: the run script never
      // starts (runAfterSetup is off), and files.copy copies the project's .env files into the temp worktree.
      await trustRoom(k, room.id)

      // AC2: worktree, branch, setup and the first prompt
      const ws = await h['workspaces.create']({ roomId: room.id, agentId: agent.id, prompt: 'Check the working tree. First think it through: which is larger, 2^10 or 10^3, and by how much? Then run exactly `git status --short` with the Bash tool and reply in two short sentences. Run nothing else.' })
      wsId = ws.id
      const chat = (await h['chats.list']({ workspaceId: ws.id }))[0]
      const setup = pushes.flatMap((e) => (e.type === 'script.output' && e.workspaceId === ws.id && e.kind === 'setup' ? e.lines.map((l) => l.line) : []))
      const setupExit = pushes.find((e) => e.type === 'script.exit' && e.workspaceId === ws.id && e.kind === 'setup')
      evidence.workspace = { branch: ws.branch, path: ws.path, status: ws.status, port: ws.port, setup, setupExit }
      expect(ws).toMatchObject({ status: 'ready', mode: 'worktree' })
      expect(existsSync(join(ws.path, '.git'))).toBe(true)
      expect((await exec('git', ['-C', repo, 'branch', '--list', ws.branch])).stdout).toContain(ws.branch)
      expect(setup.join('\n')).toContain(`setup ran on port ${ws.port}`)

      const items = () => k.store.items(chat.id)
      const results = () => items().filter((i) => i.kind === 'result').length
      const tools = () => items().filter((i): i is ChatItem & { kind: 'tool' } => i.kind === 'tool')
      const approvals = () => k.store.approvals({ roomId: room.id })
      const pending = async (match: string) => waitFor(`approval for ${match}`, () => approvals().find((a) => a.status === 'pending' && a.toolName === 'Bash' && a.title.includes(match)))

      // AC4 approve, and AC5 billing from the init message
      k.approvals.decide((await pending('git status')).id, { behavior: 'allow' })
      await waitFor('first turn', () => results() >= 1)
      evidence.apiKeySource = k.sessions.billingOf(chat.id)
      expect(k.sessions.billingOf(chat.id)).toBe('none')
      expect(tools().find((t) => t.detail.includes('git status'))?.status).toBe('done')

      // AC4 deny
      await h['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Run exactly `touch kernel-deny-check` with the Bash tool. If it is denied, do not retry; say so in one sentence.' }] })
      k.approvals.decide((await pending('touch kernel-deny-check')).id, { behavior: 'deny', message: 'Not now.' })
      await waitFor('deny turn', () => results() >= 2)
      expect(existsSync(join(ws.path, 'kernel-deny-check'))).toBe(false)
      expect(tools().find((t) => t.detail.includes('kernel-deny-check'))?.status).toBe('failed')

      // AC4 always allow: saved on the room, and the repeat runs without asking. A command off the list never asks.
      await h['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Run exactly `git log --oneline -1` with the Bash tool, then say done.' }] })
      k.approvals.decide((await pending('git log')).id, { behavior: 'allow', always: true })
      await waitFor('always allow turn', () => results() >= 3)
      evidence.roomAllow = k.store.room(room.id)?.allow
      expect(k.store.room(room.id)?.allow).toContain('git log --oneline -1')
      const asked = approvals().length
      await h['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Run exactly `git log --oneline -1` again with the Bash tool, then exactly `echo kernel-live-ok`, then say done.' }] })
      await waitFor('repeat turn', () => results() >= 4)
      expect(approvals().length).toBe(asked)
      expect(tools().filter((t) => t.detail.includes('git log')).map((t) => t.status)).toEqual(['done', 'done'])
      expect(tools().find((t) => t.detail.includes('echo kernel-live-ok'))?.status).toBe('done')
      evidence.approvals = approvals().map((a: Approval) => ({ title: a.title, status: a.status, source: a.source }))

      // KERNEL-236: three questions in one AskUserQuestion call land on one approval, and the model gets each answer
      await h['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Call the AskUserQuestion tool exactly once, with three questions in that one call: which fruit, which number, and which color. Give each two options. Then reply with each question and my answer to it, one per line, word for word.' }] })
      const question = await waitFor('question approval', () => approvals().find((a) => a.status === 'pending' && a.toolName === 'AskUserQuestion'))
      evidence.question = { title: question.title, questions: question.questions }
      expect(question.questions).toHaveLength(3)
      expect(question.title).toBe(question.questions![0].question)
      const picks = ['kiwi-71', 'plum-42', 'fig-13']
      const answers = Object.fromEntries(question.questions!.map((q, i) => [q.question, picks[i]]))
      const beforeAsk = results()
      k.approvals.decide(question.id, { behavior: 'answer', text: picks.join(' · '), answers })
      await waitFor('answers turn', () => results() > beforeAsk)
      const reply = items().filter((i): i is ChatItem & { kind: 'text' } => i.kind === 'text').at(-1)?.text ?? ''
      evidence.answersReply = reply
      for (const p of picks) expect(reply).toContain(p)
      expect(tools().find((t) => t.name === 'AskUserQuestion')?.status).toBe('done')

      // AC3: a follow-up sent while a turn runs is queued and answered
      await h['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Run exactly `sleep 8` with the Bash tool, then say done.' }] })
      await waitFor('sleep 8 running', () => tools().find((t) => t.detail === 'sleep 8'))
      const followUp = await h['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'After that, also reply with the word banana.' }] })
      expect(followUp.queued).toBe(true)
      await waitFor('banana', () => items().some((i) => i.kind === 'text' && /banana/i.test(i.text)) && !k.sessions.isRunning(chat.id))

      // AC3: interrupt a running tool, then keep talking
      await h['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Run exactly `sleep 30` with the Bash tool, then say done.' }] })
      await waitFor('sleep 30 running', () => tools().find((t) => t.detail === 'sleep 30' && t.status === 'running'))
      const before = results()
      await h['chats.interrupt']({ chatId: chat.id })
      await waitFor('interrupt settles', () => !k.sessions.isRunning(chat.id))
      const all = items()
      const tail = all.slice(all.map((i) => i.kind).lastIndexOf('interrupted'))
      expect(tail[0]?.kind).toBe('interrupted')
      expect(tail.some((i) => i.kind === 'result' && !i.ok)).toBe(false)
      await h['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Reply with just: still here' }] })
      await waitFor('after interrupt', () => results() > before && items().some((i) => i.kind === 'text' && /still here/i.test(i.text)))

      const kinds = items().reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {})
      evidence.transcript = kinds
      expect(kinds.text).toBeGreaterThan(0)
      expect(kinds.thinking).toBeGreaterThan(0)
      expect(kinds.tool).toBeGreaterThan(0)

      // AC6: rate_limit_event arrived, and usage.get answers on demand from the experimental call
      const fromEvents = pushes.filter((e) => e.type === 'usage').map((e) => (e as { limits: RateLimit[] }).limits)
      evidence.rateLimitEvents = fromEvents[0]
      expect(fromEvents.length).toBeGreaterThan(0)
      ;(k.sessions as unknown as { limits: Map<string, RateLimit> }).limits.clear()
      const usage = await h['usage.get']()
      evidence.usage = usage
      for (const type of ['five_hour', 'seven_day']) {
        const l = usage.find((u) => u.type === type)
        expect(l?.utilization, type).toBeTypeOf('number')
        expect(l!.utilization!).toBeGreaterThanOrEqual(0)
        expect(l!.utilization!).toBeLessThanOrEqual(1)
      }

      // AC7: a session outside Kernel reports through the installed hooks after "Install hooks"
      const installed = await h['hooks.install']({ port: hookPort })
      expect(installed.path).toBe(claudeSettingsFile)
      // exec merges process.env, and spawn drops undefined values, so this is how the keys stay out.
      const env = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined }
      const outside = await exec('claude', ['-p', '--settings', claudeSettingsFile, '--model', 'claude-haiku-4-5-20251001', 'Reply with just OK'], { cwd: repo, env, timeoutMs: 180_000 })
      evidence.outside = { code: outside.code, stdout: outside.stdout.trim().slice(0, 200), stderr: outside.stderr.trim().slice(0, 500) }
      expect(outside.code).toBe(0)
      const seen = await waitFor('outside activity', () => {
        const rows = activity.filter((a) => a.roomId === room.id && a.sessionId && !k.sessions.isManaged(a.sessionId))
        return rows.some((a) => a.kind === 'turn.done') ? rows : undefined
      })
      evidence.outsideActivity = seen.map((a) => ({ kind: a.kind, text: a.text, object: a.object, workspaceId: a.workspaceId }))
      evidence.hooks = hooks
      evidence.hookInvalid = invalid
      expect(seen.map((a) => a.kind)).toEqual(expect.arrayContaining(['session.start', 'prompt', 'turn.done']))
      expect(invalid).toEqual([])
    } finally {
      const out = process.env.KERNEL_LIVE_OUT ?? join(tmpdir(), 'kernel-live-evidence.json')
      await writeFile(out, JSON.stringify(evidence, null, 2))
      console.log(`[live] evidence: ${out}`)
      bus.off('push', onPush); bus.off('activity', onActivity); bus.off('hook', onHook); bus.off('hook.invalid', onInvalid)
      if (wsId) await k.archiveWorkspace(wsId, true).catch((e) => console.log('[live] archive failed', e))
      await k.stop()
      await rm(toml, { force: true })
      if (madeKernelDir) await rm(join(repo, '.kernel'), { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

// KERNEL-202: one real Haiku request names a conversation. `-t "chat name"` runs it alone.
describe.skipIf(!process.env.KERNEL_LIVE)('live chat name', () => {
  it('gets a clean chat name back from Haiku', { timeout: 120_000 }, async () => {
    const text = [
      'User: The login button on the settings page does nothing when I click it. Can you find out why?',
      'Assistant: The click handler is attached before the button renders, so it never fires. I moved it into the effect.',
      'User: Now also add a test so it does not break again.'
    ].join('\n\n')
    const name = await askTitle(text, { cwd: repo || tmpdir() })
    console.log(`[live] chat name: ${JSON.stringify(name)}`)
    expect(name).toBeTypeOf('string')
    expect(name!.length).toBeGreaterThan(0)
    expect(name!.length).toBeLessThanOrEqual(60)
    expect(name).not.toMatch(/^["'#*]|[."']$|\n/)
  })
})

// KERNEL-215: a turn a quit cut off carries on when Kernel opens again, in the same conversation. Once through the
// interrupt a quit sends first, once through the abort that follows when a turn doesn't stop in time. `-t "live relaunch"`.
describe.skipIf(!process.env.KERNEL_LIVE)('live relaunch', () => {
  for (const [how, budgetMs] of [['an interrupt', 15_000], ['an abort', 0]] as const) {
    it(`resumes a session cut off by ${how}`, { timeout: 600_000 }, async () => {
      expect(existsSync(join(repo, '.claude/agents')), 'KERNEL_LIVE_REPO needs a .claude/agents folder').toBe(true)
      const dataDir = await mkdtemp(join(tmpdir(), 'kernel-live-data-'))
      const home = await mkdtemp(join(tmpdir(), 'kernel-live-home-'))
      const where = { dataDir, home, claudeSettingsFile: join(home, 'claude-settings.json') }
      await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
        hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'),
        workspace: { baseRef: process.env.KERNEL_LIVE_BASE ?? 'origin/main' },
        models: { engineers: 'claude-sonnet-5-5', effort: 'low' },
        permissions: { mode: 'bypassInWorktrees', alwaysAsk: [], neverAllow: [] },
        // The side project's committed setup (install, database push, seed) is not what this test is about.
        scripts: { setupOnCreate: false }
      }))
      const evidence: Record<string, unknown> = { repo, how }
      let k = new Kernel(where)
      await k.start()
      let wsId: string | undefined
      try {
        const h = k.handlers()
        const room = await h['rooms.add']({ path: repo })
        const agents = await h['agents.list']({ roomId: room.id })
        const agent = agents.find((a) => a.id === 'implementer') ?? agents.find((a) => !a.lead) ?? agents[0]
        // Trust the committed scripts, or the workspace waits and the brief never goes out (KERNEL-209). Setup is off above.
        await trustRoom(k, room.id)
        const ws = await h['workspaces.create']({ roomId: room.id, agentId: agent.id, prompt: 'Remember the word kumquat for later. Run exactly `sleep 20` with the Bash tool, then say done. Run nothing else.' })
        wsId = ws.id
        const chat = (await h['chats.list']({ workspaceId: ws.id }))[0]
        await waitFor('sleep 20 running', () => k.store.items(chat.id).find((i) => i.kind === 'tool' && i.detail === 'sleep 20' && i.status === 'running'))
        const session = k.store.chat(chat.id)?.sessionId
        const t0 = Date.now()
        await k.stop({ budgetMs })
        evidence.stopMs = Date.now() - t0
        evidence.sessionBefore = session
        // The interrupt ends the turn well inside its budget. The abort leaves no claude process of that run alive.
        if (budgetMs) expect(Date.now() - t0).toBeLessThan(budgetMs)
        await new Promise((r) => setTimeout(r, 1500))
        const saved = new Store(join(dataDir, 'kernel.db'))
        const pids = saved.meta<{ pid: number }[]>('claudePids') ?? []
        saved.db.close()
        const alive = pids.filter(({ pid }) => { try { process.kill(pid, 0); return true } catch { return false } })
        evidence.leftover = { pids, alive }
        expect(alive).toEqual([])

        k = new Kernel(where)
        await k.start()
        const items = () => k.store.items(chat.id)
        expect(items().filter((i) => i.kind === 'note').map((i) => (i as { text: string }).text)).toContain(QUIT_NOTE)
        expect(items().find((i) => i.kind === 'tool' && i.detail === 'sleep 20')).toMatchObject({ status: 'failed', output: TOOL_STOPPED })
        // The nudge goes out once the launch check (`claude auth status`) finishes, which start() doesn't wait for (KERNEL-396).
        const isNudgeRow = (i: ChatItem) => i.kind === 'user' && (i.parts[0] as { text?: string }).text === RELAUNCH_NUDGE
        await waitFor('the nudge', () => items().some(isNudgeRow), 30_000)
        const nudge = items().findIndex(isNudgeRow)
        const after = () => items().slice(nudge)
        await waitFor('the nudge turn', () => after().some((i) => i.kind === 'result') && !k.sessions.isRunning(chat.id))
        evidence.nudgeTurn = after().map((i) => ({ kind: i.kind, ...(i.kind === 'text' ? { text: i.text.slice(0, 200) } : {}), ...(i.kind === 'result' ? { ok: i.ok, error: i.error } : {}), ...(i.kind === 'note' ? { text: i.text } : {}) }))
        expect(after().filter((i) => i.kind === 'result').every((i) => i.kind === 'result' && i.ok)).toBe(true)
        expect(after().some((i) => i.kind === 'note' && /Session stopped/.test(i.text))).toBe(false)
        evidence.sessionAfter = k.store.chat(chat.id)?.sessionId
        // Same conversation: it still knows what it was told before the quit.
        await k.handlers()['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Which word did I ask you to remember? Reply with just that word.' }] })
        await waitFor('the word', () => items().slice(nudge).some((i) => i.kind === 'text' && /kumquat/i.test(i.text)) && !k.sessions.isRunning(chat.id))
      } finally {
        const out = join(process.env.KERNEL_LIVE_OUT ? join(process.env.KERNEL_LIVE_OUT, '..') : tmpdir(), `kernel-live-relaunch-${budgetMs ? 'interrupt' : 'abort'}.json`)
        await writeFile(out, JSON.stringify(evidence, null, 2))
        console.log(`[live] evidence: ${out}`)
        if (wsId) await k.archiveWorkspace(wsId, true).catch((e) => console.log('[live] archive failed', e))
        await k.stop({ budgetMs: 0 })
        await rm(home, { recursive: true, force: true })
        await rm(dataDir, { recursive: true, force: true })
      }
    })
  }
})

// KERNEL-355, KERNEL-405: a Lead chat that ran on the main checkout, in the shared Lead workspace from before KERNEL-405, still
// remembers its turns once it moves into a worktree of its own, resumed by session id from there (KERNEL-348). Two short Sonnet
// turns in a throwaway repo in a temp folder, nothing in KERNEL_LIVE_REPO. `-t "live lead move"`.
describe.skipIf(!process.env.KERNEL_LIVE)('live lead move', () => {
  it('resumes a Lead chat from the checkout in its new worktree', { timeout: 300_000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-live-lead-'))
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-live-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-live-home-'))
    const where = { dataDir, home, claudeSettingsFile: join(home, 'claude-settings.json') }
    for (const args of [['init', '-q', '-b', 'main', repo], ['-C', repo, 'config', 'user.email', 't@t.dev'], ['-C', repo, 'config', 'user.name', 'Test']]) await exec('git', args)
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true })
    await writeFile(join(repo, 'README.md'), '# lead move\n')
    await writeFile(join(repo, '.claude', 'agents', 'rowan.md'), '---\nname: rowan\ndescription: Lead.\nlead: true\nmodel: sonnet\n---\nYou are Rowan. Answer in one short line.')
    await exec('git', ['-C', repo, 'add', '-A'])
    await exec('git', ['-C', repo, 'commit', '-q', '-m', 'init'])
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'),
      models: { effort: 'low', leadPlanMode: false }, permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [] }
    }))
    const evidence: Record<string, unknown> = { repo }
    let k = new Kernel(where)
    await k.start()
    try {
      const room = await k.addRoom(repo)
      // The Lead as it was before the move: one shared workspace on the checkout, with a chat in it.
      const made = k.store.saveWorkspace({ id: 'old-lead', roomId: room.id, name: 'lead', branch: 'main', baseRef: 'main', path: repo, mode: 'current', agentId: 'rowan', lead: true, port: 4300, status: 'ready', prState: 'none', createdAt: Date.now() })
      k.store.saveThread({ id: 'kumquat', roomId: room.id, title: 'Kumquat', createdAt: Date.now() })
      const chat = k.store.saveChat({ id: 'kumquat-tab', workspaceId: made.id, title: 'Kumquat', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, threadId: 'kumquat', createdAt: Date.now() })
      k.store.saveMeta('leadChatsMoved', false)
      await k.handlers()['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Remember the word kumquat for later. Reply with just ok. Use no tools.' }] })
      const items = () => k.store.items(chat.id)
      await waitFor('the first turn', () => items().some((i) => i.kind === 'result') && !k.sessions.isRunning(chat.id))
      const session = k.store.chat(chat.id)?.sessionId
      evidence.before = { session, cwd: k.store.workspace(made.id)?.path }
      expect(k.store.workspace(made.id)?.path).toBe(repo)
      expect(session).toBeTruthy()
      await k.stop()

      k = new Kernel(where)
      await k.start()
      const moved = k.store.workspace(k.store.chat(chat.id)!.workspaceId)!
      evidence.after = { mode: moved.mode, path: moved.path, branch: moved.branch, baseRef: moved.baseRef }
      expect(moved).toMatchObject({ mode: 'worktree', branch: 'rowan/kumquat', baseRef: 'main', lead: true, threadId: 'kumquat' })
      expect(k.store.workspace(made.id)?.status).toBe('archived')
      await waitFor('setup', () => k.store.workspace(moved.id)?.status === 'ready')
      const from = items().length
      await k.handlers()['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Which word did I ask you to remember? Reply with just that word.' }] })
      await waitFor('the word', () => items().slice(from).some((i) => i.kind === 'result') && !k.sessions.isRunning(chat.id))
      evidence.reply = items().slice(from).flatMap((i) => (i.kind === 'text' ? [i.text] : i.kind === 'note' ? [`note: ${i.text}`] : []))
      evidence.sessionAfter = k.store.chat(chat.id)?.sessionId
      expect(items().slice(from).some((i) => i.kind === 'text' && /kumquat/i.test(i.text))).toBe(true)
      expect(k.store.chat(chat.id)?.sessionId).toBe(session)
    } finally {
      const out = join(process.env.KERNEL_LIVE_OUT ? join(process.env.KERNEL_LIVE_OUT, '..') : tmpdir(), 'kernel-live-lead-move.json')
      await writeFile(out, JSON.stringify(evidence, null, 2))
      console.log(`[live] evidence: ${out}`)
      await k.stop({ budgetMs: 0 })
      for (const dir of [home, dataDir, repo]) await rm(dir, { recursive: true, force: true })
    }
  })
})

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs = 180_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = check()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

// KERNEL-286: a chat whose Claude Code session is gone starts a fresh one. Kernel matches the CLI's own words for a
// missing session, which no typed field carries, so run this before an SDK bump: a new wording fails it. One short Haiku
// turn in a temp folder, nothing in KERNEL_LIVE_REPO. `-t "live session gone"`.
describe.skipIf(!process.env.KERNEL_LIVE)('live session gone', () => {
  it('starts a fresh session that replies when the saved one is gone', { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-live-gone-'))
    const store = new Store(join(dir, 'kernel.db'))
    const ws = { id: 'ws', roomId: 'room', name: 'gone', branch: 'main', baseRef: 'main', path: dir, mode: 'current', agentId: 'noor', port: 4311, status: 'ready', prState: 'none', createdAt: 1 } as Workspace
    const missing = randomUUID()
    const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Gone', kind: 'chat', model: 'claude-haiku-4-5-20251001', effort: 'low', plan: false, createdAt: 1, sessionId: missing }
    store.saveWorkspace(ws)
    store.saveChat(chat)
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    let done!: (ok: boolean) => void
    const turn = new Promise<boolean>((resolve) => { done = resolve })
    const sessions = new Sessions({
      store, approvals: new Approvals(store), settings: () => settings, agentFor: () => undefined, mcpFor: () => undefined,
      roomAllow: () => [], allowInRoom: () => {}, onTurnDone: (_ws, _chat, t) => done(t.ok)
    })
    try {
      await sessions.send('chat', [{ type: 'text', text: 'Reply with the single word ok and nothing else.' }])
      expect(await turn).toBe(true)
      const items = store.items('chat')
      console.log(`[live] session gone: ${JSON.stringify(items.map((i) => i.kind))}`)
      expect(items.map((i) => i.kind).slice(0, 2)).toEqual(['user', 'note'])
      expect(items[1]).toMatchObject({ text: SESSION_GONE_NOTE })
      expect(items.some((i) => i.kind === 'text')).toBe(true)
      expect(store.chat('chat')?.sessionId).toBeTruthy()
      expect(store.chat('chat')?.sessionId).not.toBe(missing)
    } finally {
      sessions.stopAll()
      store.db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// KERNEL-406: the same journey on Codex, on the bundled Codex and the ChatGPT plan it is signed in to. It spends a few short
// turns on a small Codex model, so it runs only when asked:
//   KERNEL_LIVE=1 KERNEL_LIVE_CODEX=1 KERNEL_LIVE_REPO=<path to a side project> pnpm test test/live.test.ts -t codex
// KERNEL_LIVE_CODEX_MODEL picks the model (gpt-5.6-luna).
const codexModel = process.env.KERNEL_LIVE_CODEX_MODEL ?? 'gpt-5.6-luna'
const liveCodex = !!process.env.KERNEL_LIVE && !!process.env.KERNEL_LIVE_CODEX

/** Settings with every role on Codex, two commands on Always ask and one on Never allow. */
async function codexSettings(dataDir: string, home: string) {
  const role = { provider: 'codex', model: codexModel, effort: 'medium' }
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
    hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'),
    workspace: { baseRef: process.env.KERNEL_LIVE_BASE ?? 'origin/main' },
    models: { roles: { lead: role, engineers: role, qa: role, reviewer: role }, leadPlanMode: true },
    permissions: { mode: 'acceptEdits', alwaysAsk: ['touch kernel-ask-check', 'touch kernel-deny-check'], neverAllow: ['git push origin main'] }
  }))
}

async function codexKernel(dataDir: string, home: string) {
  const k = new Kernel({ dataDir, home, claudeSettingsFile: join(home, 'claude-settings.json') })
  await k.start()
  return k
}

describe.skipIf(!liveCodex)('live codex teammate', () => {
  it('runs a teammate on Codex through approvals, tool rows, limits and a resume after a restart', { timeout: 600_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-live-codex-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-live-codex-home-'))
    await codexSettings(dataDir, home)
    const pushes: PushEvent[] = []
    const onPush = (e: PushEvent) => pushes.push(e)
    bus.on('push', onPush)
    let k = await codexKernel(dataDir, home)
    const evidence: Record<string, unknown> = { repo, model: codexModel }
    let wsId: string | undefined
    try {
      const room = await k.handlers()['rooms.add']({ path: repo })
      await trustRoom(k, room.id)
      const agents = await k.handlers()['agents.list']({ roomId: room.id })
      const agent = agents.find((a) => !a.lead && !a.builtIn) ?? agents[0]
      const ws = await k.handlers()['workspaces.create']({ roomId: room.id, agentId: agent.id, prompt: 'Think briefly about which is larger, 2^10 or 10^3. Then run exactly `touch kernel-ask-check` in the shell, and reply in one short sentence.' })
      wsId = ws.id
      const chat = (await k.handlers()['chats.list']({ workspaceId: ws.id }))[0]
      expect(chat).toMatchObject({ provider: 'codex', model: codexModel })
      const items = () => k.store.items(chat.id)
      const results = () => items().filter((i) => i.kind === 'result').length
      const tools = () => items().filter((i): i is ChatItem & { kind: 'tool' } => i.kind === 'tool')
      const pending = (match: string) => waitFor(`approval for ${match}`, () => k.store.approvals({ roomId: room.id }).find((a) => a.status === 'pending' && a.title.includes(match)))

      // Always ask: the card shows, and the command runs once allowed.
      k.approvals.decide((await pending('kernel-ask-check')).id, { behavior: 'allow' })
      await waitFor('first turn', () => results() >= 1)
      expect(existsSync(join(ws.path, 'kernel-ask-check'))).toBe(true)
      expect(k.store.chat(chat.id)?.sessionId).toBeTruthy()

      // A denied command doesn't run.
      await k.handlers()['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Run exactly `touch kernel-deny-check` in the shell. If it is declined, do not retry; say so in one sentence.' }] })
      k.approvals.decide((await pending('kernel-deny-check')).id, { behavior: 'deny', message: 'Not now.' })
      await waitFor('deny turn', () => results() >= 2)
      expect(existsSync(join(ws.path, 'kernel-deny-check'))).toBe(false)

      // Never allow is declined without asking.
      const asked = k.store.approvals({ roomId: room.id }).length
      await k.handlers()['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Run exactly `git push origin main` in the shell once. If it is declined, do not retry; say so in one sentence.' }] })
      await waitFor('never allow turn', () => results() >= 3)
      expect(k.store.approvals({ roomId: room.id }).length).toBe(asked)

      const kinds = items().reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {})
      evidence.transcript = kinds
      evidence.tools = tools().map((t) => [t.name, t.status, t.detail])
      expect(kinds.text).toBeGreaterThan(0)
      expect(kinds.thinking).toBeGreaterThan(0)
      expect(tools().some((t) => t.name === 'Bash' && t.status === 'done')).toBe(true)

      // Codex's usage windows arrive, kept apart from Claude's.
      const usage = pushes.filter((e) => e.type === 'usage').map((e) => (e as { limits: RateLimit[] }).limits).at(-1) ?? []
      evidence.usage = usage
      expect(usage.some((l) => l.provider === 'codex' && l.type === 'five_hour' && typeof l.utilization === 'number')).toBe(true)

      // Kernel restarts, and the chat resumes its thread.
      const thread = k.store.chat(chat.id)?.sessionId
      await k.stop()
      k = await codexKernel(dataDir, home)
      await k.handlers()['chats.send']({ chatId: chat.id, parts: [{ type: 'text', text: 'Which file did you create with touch in this chat? Reply with just its name.' }] })
      await waitFor('resumed turn', () => k.store.items(chat.id).filter((i) => i.kind === 'result').length >= 4 && !k.sessions.isRunning(chat.id))
      const reply = k.store.items(chat.id).filter((i): i is ChatItem & { kind: 'text' } => i.kind === 'text').at(-1)?.text ?? ''
      evidence.resumedReply = reply
      expect(k.store.chat(chat.id)?.sessionId).toBe(thread)
      expect(reply).toContain('kernel-ask-check')
    } finally {
      const out = process.env.KERNEL_LIVE_OUT ?? join(tmpdir(), 'kernel-live-codex-evidence.json')
      await writeFile(out, JSON.stringify(evidence, null, 2))
      console.log(`[live] codex evidence: ${out}`)
      bus.off('push', onPush)
      if (wsId) await k.archiveWorkspace(wsId, true).catch((e) => console.log('[live] archive failed', e))
      await k.stop()
      await rm(home, { recursive: true, force: true })
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!liveCodex)('live codex lead', () => {
  it('has a Lead on Codex plan in plan mode, get the approval card, and hand off with create_workspace', { timeout: 600_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-live-codex-lead-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-live-codex-lead-home-'))
    await codexSettings(dataDir, home)
    const k = await codexKernel(dataDir, home)
    const evidence: Record<string, unknown> = { repo, model: codexModel }
    try {
      const room = await k.handlers()['rooms.add']({ path: repo })
      await trustRoom(k, room.id)
      const agents = await k.handlers()['agents.list']({ roomId: room.id })
      const teammate = agents.find((a) => !a.lead && !a.builtIn) ?? agents.find((a) => !a.lead)!
      const chat = await k.handlers()['lead.start']({ roomId: room.id, prompt: `Plan one small task for ${teammate.name}: add the line "Hello from Kernel" to the end of README.md. One task, a short plan. Don't read any files.` })
      expect(chat).toMatchObject({ provider: 'codex', plan: true })
      const plan = await waitFor('plan card', () => k.store.approvals({ roomId: room.id }).find((a) => a.kind === 'plan' && a.status === 'pending'), 300_000)
      evidence.plan = plan.detail
      k.approvals.decide(plan.id, { behavior: 'allow' })
      const handed = await waitFor('hand-off', () => k.store.workspaces(room.id).find((w) => w.leadChatId === chat.id), 300_000)
      evidence.handedOff = { name: handed.name, agent: handed.agentId }
      const rows = k.store.items(chat.id).filter((i): i is ChatItem & { kind: 'tool' } => i.kind === 'tool')
      evidence.leadTools = rows.map((t) => [t.name, t.status])
      expect(rows.some((t) => t.name === 'mcp__kernel__create_workspace' && t.status === 'done')).toBe(true)
      expect(k.store.chat(chat.id)?.plan).toBe(false)
      await k.archiveWorkspace(handed.id, true).catch(() => undefined)
    } finally {
      const out = join(tmpdir(), 'kernel-live-codex-lead-evidence.json')
      await writeFile(out, JSON.stringify(evidence, null, 2))
      console.log(`[live] codex lead evidence: ${out}`)
      await k.stop()
      await rm(home, { recursive: true, force: true })
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
