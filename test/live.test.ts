import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityEvent, Approval, ChatItem, RateLimit } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { exec } from '../src/main/services/exec'

// The KERNEL-6 round trip against real Claude Code. It spends a few short Sonnet turns on the Claude plan, so it
// only runs when asked:
//   KERNEL_LIVE=1 KERNEL_LIVE_REPO=~/Projects/quarters npm test -- test/live.test.ts
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

      // AC2: worktree, branch, setup and the first prompt
      const ws = await h['workspaces.create']({ roomId: room.id, agentId: agent.id, prompt: 'Check the working tree. First think it through: which is larger, 2^10 or 10^3, and by how much? Then run exactly `git status --short` with the Bash tool and reply in two short sentences. Run nothing else.' })
      wsId = ws.id
      const chat = (await h['chats.list']({ workspaceId: ws.id }))[0]
      const setup = pushes.flatMap((e) => (e.type === 'script.output' && e.workspaceId === ws.id && e.kind === 'setup' ? [e.line] : []))
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

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs = 180_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = check()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}
