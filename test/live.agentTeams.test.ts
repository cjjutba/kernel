import { describe, expect, it, vi } from 'vitest'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityEvent } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { tempRepo, freePort } from './helpers'

// KERNEL-857: what agent teams do inside a Kernel chat, on the pinned SDK. A research run, not a regression test: it asserts
// almost nothing and records what it saw. It drives Kernel's own session code with Settings, Models and effort, Agent teams
// on, and spends several Sonnet turns plus two or three teammates on the Claude plan, so a person runs it:
//   KERNEL_LIVE=1 KERNEL_LIVE_OUT=<folder> pnpm exec vitest run test/live.agentTeams.test.ts
// KERNEL_LIVE_BG=user keeps the Mac's own Claude Code settings for background tasks. By default the run turns them on
// through the session's flag settings, since a ~/.claude/settings.json that sets CLAUDE_CODE_DISABLE_BACKGROUND_TASKS would
// otherwise hide what most users get.
// The SDK's `query` is wrapped to log every message, hook call and permission ask; Kernel's code runs as it is. Teams and
// tasks land in ~/.claude, since a temp CLAUDE_CONFIG_DIR has no login. The run copies the folders it made into the
// evidence folder and removes them, and leaves everything else in ~/.claude alone.

type Entry = Record<string, any> & { t: number; kind: string }
/** Every SDK message, hook call, permission ask and step of the run, in order. */
const log: Entry[] = []
const queries: { q: any; sessionId?: string; chat?: string }[] = []
const t0 = Date.now()
const note = (kind: string, data: Record<string, unknown> = {}) => { log.push({ t: Date.now() - t0, kind, ...data }) }

/** Long strings cut, so the log stays readable. */
function clip(v: unknown, n = 400): unknown {
  if (typeof v === 'string') return v.length > n ? `${v.slice(0, n)}…(${v.length})` : v
  if (Array.isArray(v)) return v.map((x) => clip(x, n))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, n)]))
  return v
}

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  const query: typeof sdk.query = ({ prompt, options }) => {
    const o = { ...options! }
    const cwd = o.cwd
    const hooks: Record<string, any[]> = {}
    for (const [event, matchers] of Object.entries(o.hooks ?? {})) {
      hooks[event] = matchers!.map((m, i) => ({
        ...m,
        hooks: m.hooks.map((h, j) => async (input: any, id: string | undefined, ctx: any) => {
          // The first matcher of each event is Kernel's report hook, which every call reaches: the input is logged once there.
          if (i === 0 && j === 0) note('hook', { cwd, event, input: clip(input) })
          const out = await h(input, id, ctx)
          if (out && Object.keys(out).length) note('hook.out', { cwd, event, matcher: m.matcher, tool: input.tool_name, agent_id: input.agent_id, out: clip(out) })
          return out
        })
      }))
    }
    o.hooks = hooks
    const can = o.canUseTool!
    o.canUseTool = async (tool, input, opts) => {
      note('canUseTool', { cwd, tool, input: clip(input), agentID: opts.agentID, toolUseID: opts.toolUseID, title: opts.title, decisionReason: opts.decisionReason })
      const r = await can(tool, input, opts)
      note('canUseTool.out', { cwd, tool, agentID: opts.agentID, behavior: r?.behavior })
      return r
    }
    if (process.env.KERNEL_LIVE_BG !== 'user') o.settings = { ...((o.settings as object | undefined) ?? {}), env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' } }
    const env = o.env ?? {}
    note('options', { cwd, model: o.model, resume: o.resume, sessionId: o.sessionId, permissionMode: o.permissionMode, teams: env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, bgOff: env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, settings: o.settings })
    const q = sdk.query({ prompt, options: o })
    const entry: { q: any; sessionId?: string; chat?: string } = { q, chat: cwd }
    queries.push(entry)
    const iter = q[Symbol.asyncIterator].bind(q)
    ;(q as any)[Symbol.asyncIterator] = () => {
      const it = iter()
      return {
        async next() {
          const r = await it.next()
          if (!r.done) {
            const m = r.value as any
            if (m.type === 'system' && m.subtype === 'init') entry.sessionId = m.session_id
            if (m.type !== 'stream_event') note('msg', { cwd, type: m.type, subtype: m.subtype, parent: m.parent_tool_use_id, msg: clip(m, 300) })
          }
          return r
        },
        return: it.return?.bind(it),
        throw: it.throw?.bind(it)
      }
    }
    return q
  }
  return { ...sdk, query }
})

const NOOR = `---
name: noor
description: Engineer.
model: sonnet
role: Backend
---
You build what you're asked. Keep replies short.
`
// Shares a name with the teammate the run spawns, for the third known gate bug.
const KAI = `---
name: kai
description: Frontend engineer.
model: sonnet
role: Frontend
---
You build screens.
`
// A tools line without Write or Edit, to see whether it reaches a teammate.
const RHEA = `---
name: rhea
description: Reviewer.
model: sonnet
role: QA
tools: Read, Grep, Glob, Bash, Agent, SendMessage, TeamCreate, TeamDelete
---
You review. Keep replies short.
`

const claudeDir = join(homedir(), '.claude')
const listDir = async (p: string): Promise<string[]> => (existsSync(p) ? readdir(p) : [])
const hooks = (event: string, pred: (input: any) => boolean = () => true) => log.filter((l) => l.kind === 'hook' && l.event === event && pred(l.input))
const msgs = (pred: (m: Entry) => boolean) => log.filter((l) => l.kind === 'msg' && pred(l))
const bashRan = (match: string) => hooks('PreToolUse', (i) => i.tool_name === 'Bash' && String(i.tool_input?.command ?? '').includes(match))
const bashDone = (match: string) => hooks('PostToolUse', (i) => i.tool_name === 'Bash' && String(i.tool_input?.command ?? '').includes(match))

describe.skipIf(!process.env.KERNEL_LIVE)('live agent teams', () => {
  it('records what a team does in a Kernel chat', { timeout: 2_400_000 }, async () => {
    const out = process.env.KERNEL_LIVE_OUT ?? (await mkdtemp(join(tmpdir(), 'kernel-teams-evidence-')))
    await mkdir(out, { recursive: true })
    // The test may run inside Claude Code: its own session's variables would reach the session as the Mac's.
    const saved = { ...process.env }
    for (const key of Object.keys(process.env)) if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT') delete process.env[key]
    const before = { teams: await listDir(join(claudeDir, 'teams')), tasks: await listDir(join(claudeDir, 'tasks')) }
    const made = async () => ({
      teams: (await listDir(join(claudeDir, 'teams'))).filter((n) => !before.teams.includes(n)),
      tasks: (await listDir(join(claudeDir, 'tasks'))).filter((n) => !before.tasks.includes(n))
    })
    const snapshot = async (label: string) => {
      const m = await made()
      for (const kind of ['teams', 'tasks'] as const) for (const name of m[kind]) await cp(join(claudeDir, kind, name), join(out, 'claude', label, kind, name), { recursive: true }).catch(() => undefined)
      note('snapshot', { label, ...m })
      return m
    }

    const reference = await mkdtemp(join(tmpdir(), 'kernel-teams-ref-'))
    const repo = await tempRepo({ 'README.md': '# demo\n', '.claude/agents/noor.md': NOOR, '.claude/agents/kai.md': KAI, '.claude/agents/rhea.md': RHEA })
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel/settings.local.toml'), `references = [${JSON.stringify(reference)}]\n`)
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-live-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-live-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      hookPort: await freePort(), worktreeRoot: join(home, 'wt'),
      workspace: { baseRef: 'main' },
      models: { engineers: 'claude-sonnet-5-5', effort: 'low', agentTeams: true, workspacePlanMode: false },
      permissions: { mode: 'acceptEdits', network: false, alwaysAsk: ['git log'], neverAllow: [] },
      hooks: { requireTestOutput: true, keepTeammatesWorking: true }
    }))

    const activity: ActivityEvent[] = []
    const k = new Kernel({ dataDir, home, claudeSettingsFile: join(home, 'claude-settings.json') })
    // Every card is recorded as it arrives, then allowed, so the teammates carry on.
    const onPush = (e: PushEvent) => {
      if (e.type !== 'approval') return
      note('approval', { approval: clip(e.approval) })
      if (e.approval.status === 'pending') setTimeout(() => { try { k.approvals.decide(e.approval.id, { behavior: 'allow' }) } catch { /* already decided */ } }, 2000)
    }
    const onActivity = (e: ActivityEvent) => activity.push(e)
    bus.on('push', onPush); bus.on('activity', onActivity)
    await k.start()
    const h = k.handlers()
    const evidence: Record<string, unknown> = { reference, bg: process.env.KERNEL_LIVE_BG ?? 'on' }
    const phases: Record<string, string> = {}
    const phase = async (name: string, fn: () => Promise<void>) => {
      note('phase', { name })
      try { await fn(); phases[name] = 'ok' } catch (e) { phases[name] = String((e as Error).message ?? e); note('phase.failed', { name, error: phases[name] }) }
    }
    const live = (chatId: string) => (k.sessions as any).live.get(chatId) as { running: boolean; tasks: Set<string> } | undefined
    const state = (chatId: string, label: string) => {
      const l = live(chatId)
      note('state', { label, chatId, alive: !!l, running: l?.running, tasks: l ? [...l.tasks] : undefined })
    }
    const teamTasks = () => (msgs((m) => m.subtype === 'background_tasks_changed').at(-1)?.msg?.tasks ?? []) as { task_id: string; description: string; task_type: string; subagent_type?: string }[]
    const taskOf = (name: string) => teamTasks().find((t) => JSON.stringify(t).toLowerCase().includes(name))

    let roomId = ''
    let main = { ws: '', chat: '' }
    try {
      const room = await h['rooms.add']({ path: repo })
      roomId = room.id
      const newChat = async (agentId: string, prompt: string) => {
        const ws = await h['workspaces.create']({ roomId, agentId, prompt })
        const chat = (await h['chats.list']({ workspaceId: ws.id }))[0]
        return { ws: ws.id, chat: chat.id, path: ws.path }
      }
      const results = (chatId: string) => k.store.items(chatId).filter((i) => i.kind === 'result').length

      // Q1, Q2, Q3, Q4: a team of two whose steps cross each of Kernel's rules, with the lead's turn ending at once.
      await phase('spawn', async () => {
        const c = await newChat('noor', [
          'Use an agent team for this. Create the team, then spawn two teammates with the Agent tool, named alpha and kai, and put one task for each on the team task list.',
          'alpha\'s task, "alpha checks", in order, one Bash call or tool call each: run `echo alpha-done`; run `git log --oneline -1`; fetch https://example.com with WebFetch;',
          `write the file ${join(reference, 'alpha.txt')} with the Write tool; then run \`sleep 120\`; then mark the task completed.`,
          'kai\'s task, "kai checks", in order: run `echo kai-done`; run `sleep 45`; run `echo kai-after-pause`; run `sleep 240`; then mark the task completed.',
          'Each teammate reports any refusal it gets word for word and carries on with its next step. Tell them so.',
          'Once both are spawned, end your turn at once with one line naming the team, the tools you used and the teammates. Do not wait for them.'
        ].join(' '))
        main = c
        evidence.main = c
        await waitFor('lead turn', () => results(c.chat) >= 1, 600_000)
        state(c.chat, 'after lead turn')
        await waitFor('both teammates sleeping', () => bashRan('sleep 120').length && bashRan('sleep 45').length, 600_000)
        state(c.chat, 'teammates sleeping')
      })

      // Q7 (part): what is on disk while the team works.
      await phase('disk while working', async () => { evidence.diskWorking = await snapshot('working') })

      // Q2: a paused room's hold. kai's next step after `sleep 45` should wait while the room is paused.
      await phase('pause', async () => {
        await h['rooms.setPaused']({ roomId, paused: true })
        await waitFor('kai sleep 45 done', () => bashDone('sleep 45').length, 180_000)
        await sleep(20_000)
        evidence.pause = { startedWhilePaused: bashRan('kai-after-pause').length, finishedWhilePaused: bashDone('kai-after-pause').length }
        await h['rooms.setPaused']({ roomId, paused: false })
        await waitFor('kai after pause', () => bashDone('kai-after-pause').length, 120_000).catch(() => undefined)
        state(main.chat, 'after pause')
      })

      // Q5: stopTask on alpha's task, if alpha is a task at all, while kai keeps working.
      await phase('stopTask', async () => {
        const alpha = taskOf('alpha')
        evidence.alphaTask = alpha ?? null
        if (!alpha) throw new Error(`alpha is not in background_tasks_changed: ${JSON.stringify(teamTasks())}`)
        const sid = k.store.chat(main.chat)?.sessionId
        const q = queries.filter((x) => x.sessionId === sid).at(-1)!.q
        await q.stopTask(alpha.task_id)
        await sleep(10_000)
        evidence.afterStop = { tasks: teamTasks(), notifications: msgs((m) => m.subtype === 'task_notification').map((m) => m.msg) }
        state(main.chat, 'after stopTask')
      })

      // Q1: Stop on a running lead turn. Kernel declares no per-task stop control, so the SDK says the interrupt kills teammates.
      await phase('interrupt', async () => {
        await waitFor('kai on its long sleep', () => bashRan('sleep 240').length, 180_000).catch(() => undefined)
        const n = results(main.chat)
        await h['chats.send']({ chatId: main.chat, parts: [{ type: 'text', text: 'Run exactly `sleep 60` with the Bash tool, then say done. Do not message your teammates.' }] })
        await waitFor('lead sleep 60', () => bashRan('sleep 60').length, 120_000)
        const beforeStop = teamTasks()
        await h['chats.interrupt']({ chatId: main.chat })
        await waitFor('interrupt settles', () => results(main.chat) > n || !live(main.chat)?.running, 60_000)
        await sleep(10_000)
        evidence.interrupt = { beforeStop, afterStop: teamTasks(), kaiFinishedLongSleep: bashDone('sleep 240').length }
        state(main.chat, 'after interrupt')
      })

      // Q7: the lead's process ends, as the idle timer, a mode change or a quit end it, and the next message resumes it.
      await phase('restart', async () => {
        await sleep(5_000)
        const n = results(main.chat)
        evidence.diskBeforeRestart = await snapshot('before-restart')
        k.sessions.stop(main.chat)
        await sleep(3_000)
        state(main.chat, 'stopped')
        await h['chats.send']({ chatId: main.chat, parts: [{ type: 'text', text: 'Who is on your team now, and is each teammate still running? Call TaskList and give each task\'s subject, status and owner, one per line. Do not spawn anyone.' }] })
        await waitFor('reply after restart', () => results(main.chat) > n, 300_000)
        state(main.chat, 'resumed')
        evidence.diskAfterRestart = await snapshot('after-restart')
      })

      // Q6: a second chat of the same agent, in the same room, names the first chat's team.
      await phase('second chat', async () => {
        const team = hooks('TaskCreated').map((x) => x.input.team_name).find(Boolean) ?? hooks('TeammateIdle').map((x) => x.input.team_name).find(Boolean)
        evidence.firstTeam = team ?? null
        const c = await newChat('noor', [
          `Call TaskList and report every task you see with its subject, status and owner. Then try to join or create an agent team named "${team ?? 'unknown'}" and spawn one teammate named beta,`,
          'who calls TaskList, reports what it sees, claims any task that is not completed with TaskUpdate, and stops. End your turn once beta is spawned; do not wait.'
        ].join(' '))
        evidence.second = c
        await waitFor('second lead turn', () => results(c.chat) >= 1, 600_000)
        await sleep(60_000)
        evidence.diskSecond = await snapshot('second-chat')
      })

      // Q2: an agent file's tools line, without Write, and a teammate asked to write.
      await phase('tools line', async () => {
        const c = await newChat('rhea', [
          'Use an agent team. Spawn one teammate named gamma with the Agent tool, whose job is to create the file gamma.txt containing "hi" with the Write tool and report any refusal word for word.',
          'Then wait for gamma to report, and reply with its report in one line.'
        ].join(' '))
        evidence.rhea = c
        await waitFor('rhea turn', () => results(c.chat) >= 1, 600_000)
        await sleep(30_000)
        evidence.gammaWrote = existsSync(join(c.path, 'gamma.txt'))
      })

      evidence.tasksTable = k.store.tasks(roomId)

      // Q7: Archive, then what is left on disk and in the tasks table.
      await phase('archive', async () => {
        for (const w of k.store.workspaces()) if (w.mode === 'worktree' && w.roomId === roomId) await k.archiveWorkspace(w.id, true)
        await sleep(5_000)
        evidence.diskAfterArchive = await snapshot('after-archive')
        evidence.tasksAfterArchive = k.store.tasks(roomId)
      })
    } finally {
      bus.off('push', onPush); bus.off('activity', onActivity)
      evidence.phases = phases
      evidence.sessions = queries.map((q) => ({ cwd: q.chat, sessionId: q.sessionId }))
      evidence.approvals = roomId ? k.store.approvals({ roomId }).map((a) => clip(a)) : []
      evidence.activity = activity.filter((a) => a.roomId === roomId).map((a) => ({ kind: a.kind, text: a.text, object: a.object, agentId: a.agentId, workspaceId: a.workspaceId, data: a.data }))
      evidence.items = Object.fromEntries(k.store.workspaces().flatMap((w) => k.store.chats(w.id)).map((c) => [c.id, k.store.items(c.id).map((i) => clip(i, 300))]))
      await writeFile(join(out, 'log.jsonl'), log.map((l) => JSON.stringify(l)).join('\n'))
      await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2))
      for (const w of k.store.workspaces()) if (w.mode === 'worktree' && w.status !== 'archived') await k.archiveWorkspace(w.id, true).catch(() => undefined)
      await k.stop({ budgetMs: 0 })
      // Whatever the run made in ~/.claude goes into the evidence and out of the user's folder.
      const left = await snapshot('end')
      for (const kind of ['teams', 'tasks'] as const) for (const name of left[kind]) await rm(join(claudeDir, kind, name), { recursive: true, force: true })
      for (const dir of [home, dataDir, repo, reference]) await rm(dir, { recursive: true, force: true })
      process.env = saved
      console.log(`[live] evidence: ${out}\n[live] phases: ${JSON.stringify(phases, null, 1)}`)
    }
    expect(phases.spawn).toBe('ok')
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(what: string, check: () => T | undefined | false | 0, timeoutMs = 240_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = check()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await sleep(300)
  }
}
