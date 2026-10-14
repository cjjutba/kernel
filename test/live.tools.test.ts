import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tracker } from '@shared/types'
import type { TelemetryEvent } from '@shared/telemetry'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { tempRepo, freePort } from './helpers'

// KERNEL-397 against real Claude Code: a repo's own agents, with no Lead and a read-only checker. Haiku turns on the Claude
// plan, so it only runs when asked:
//   KERNEL_LIVE=1 pnpm test test/live.tools.test.ts
// The repo is a temp one, and it never writes to ~/.claude/settings.json.

const CHECKER = `---
name: checker
description: Checks code. Read-only.
tools: Read, Grep, Glob, Bash
---
You check code and change nothing. Reply in one sentence.
`
const WEB = `---
name: web
description: Frontend engineer.
---
You build the UI. Reply in one sentence and stop.
`

async function boot(o: { models?: object } = {}) {
  const repo = await tempRepo({ 'README.md': '# demo\n', '.claude/agents/checker.md': CHECKER, '.claude/agents/web.md': WEB })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-live-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-live-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
    hookPort: await freePort(), worktreeRoot: join(home, 'wt'),
    workspace: { baseRef: 'main' },
    models: o.models ?? { lead: 'claude-haiku-4-5-20251001', engineers: 'claude-haiku-4-5-20251001', reviewer: 'claude-haiku-4-5-20251001', effort: 'low', leadPlanMode: false },
    permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [] }
  }))
  const k = new Kernel({ dataDir, home, claudeSettingsFile: join(home, 'claude-settings.json'), starterDir: join(__dirname, '..', 'docs', 'starter-agents') })
  await k.start()
  const room = await k.addRoom(repo)
  const done = async () => {
    for (const w of k.store.workspaces()) if (w.mode === 'worktree') await k.archiveWorkspace(w.id, true).catch(() => undefined)
    await k.stop()
    for (const dir of [home, dataDir, repo]) await rm(dir, { recursive: true, force: true })
  }
  return { k, room, repo, done }
}

describe.skipIf(!process.env.KERNEL_LIVE)('live agent files', () => {
  it('a read-only agent is refused a write and carries on', { timeout: 600_000 }, async () => {
    const { k, room, done } = await boot()
    const tracked: TelemetryEvent[] = []
    const onTrack = (e: TelemetryEvent) => tracked.push(e)
    bus.on('track', onTrack)
    try {
      const ws = await k.createWorkspace(room.id, { agentId: 'checker', title: 'Write test', prompt: 'Use the Write tool to create hello.txt containing "hi". If you cannot, say why in one sentence.' })
      const chat = k.chatTabs(ws.id)[0]
      await waitFor('the turn to end', () => k.store.items(chat.id).some((i) => i.kind === 'result') && !k.sessions.isRunning(chat.id))
      const tools = k.store.items(chat.id).flatMap((i) => (i.kind === 'tool' ? [`${i.name}:${i.status}`] : []))
      const said = k.store.items(chat.id).flatMap((i) => (i.kind === 'text' ? [i.text] : []))
      console.log(`[live] tools ${JSON.stringify(tools)}, said ${JSON.stringify(said.slice(-1))}, tracked ${JSON.stringify(tracked)}`)
      expect(existsSync(join(ws.path, 'hello.txt'))).toBe(false)
      expect(said.length).toBeGreaterThan(0)
    } finally {
      bus.off('track', onTrack)
      await done()
    }
  })

  it("Kernel's Kernel leads a room whose agents have no Lead", { timeout: 600_000 }, async () => {
    const { k, room, done } = await boot()
    try {
      const chat = await k.startLeadChat(room.id, { prompt: 'Who is on this team, and who takes tasks? Call list_agents and answer in two sentences.', plan: false })
      await waitFor('the Lead to answer', () => k.store.items(chat.id).some((i) => i.kind === 'result') && !k.sessions.isRunning(chat.id))
      const said = k.store.items(chat.id).flatMap((i) => (i.kind === 'text' ? [i.text] : []))
      console.log(`[live] Kernel said ${JSON.stringify(said.slice(-1))}`)
      expect(k.store.workspace(chat.workspaceId)?.agentId).toBe('kernel-lead')
      expect(k.store.items(chat.id).some((i) => i.kind === 'tool' && i.name === 'mcp__kernel__list_agents')).toBe(true)
    } finally {
      await done()
    }
  })
})

// KERNEL-473: a teammate reads its task's issue through Kernel's get_issue, with no tracker MCP server, on each provider. The
// room's tracker is a stand-in Linear whose issue holds a codeword found nowhere else. Claude runs with KERNEL_LIVE=1. Codex
// also needs KERNEL_LIVE_CODEX=1 and the ChatGPT sign-in, as in live.test.ts:
//   KERNEL_LIVE=1 KERNEL_LIVE_CODEX=1 pnpm test test/live.tools.test.ts -t "reads its issue"
const codexModel = process.env.KERNEL_LIVE_CODEX_MODEL ?? 'gpt-5.6-luna'
const codexRole = { provider: 'codex', model: codexModel, effort: 'low' }

describe.skipIf(!process.env.KERNEL_LIVE)('live issue without a tracker MCP server', () => {
  for (const provider of ['claude', 'codex'] as const) {
    it.skipIf(provider === 'codex' && !process.env.KERNEL_LIVE_CODEX)(`a ${provider} teammate reads its issue with get_issue (KERNEL-473)`, { timeout: 600_000 }, async () => {
      const { k, room, done } = await boot(provider === 'codex' ? { models: { roles: { lead: codexRole, engineers: codexRole, qa: codexRole, reviewer: codexRole }, leadPlanMode: false } } : {})
      const word = `fence-${randomUUID().slice(0, 8)}`
      const tracker: Tracker = {
        kind: 'linear', search: async () => [], start: async () => undefined,
        issue: async (id) => ({ id, title: 'Paint the fence', description: `Paint it green. The codeword is ${word}.`, comments: [], labels: [] })
      }
      k.integrations.trackerFor = async () => tracker
      try {
        const ws = await k.workspaces.createWorkspace(room.id, {
          agentId: 'web', title: 'Paint the fence', source: { kind: 'issue', id: 'DEMO-7', title: 'Paint the fence', tracker: 'linear' },
          prompt: "Read this workspace's issue with Kernel's get_issue tool, then reply with the codeword from its description in one sentence. Change no files."
        })
        const chat = k.chatTabs(ws.id)[0]
        expect(k.store.chat(chat.id)?.provider ?? 'claude').toBe(provider)
        await waitFor('the turn to end', () => k.store.items(chat.id).some((i) => i.kind === 'result') && !k.sessions.isRunning(chat.id))
        const tools = k.store.items(chat.id).flatMap((i) => (i.kind === 'tool' ? [i.name] : []))
        const said = k.store.items(chat.id).flatMap((i) => (i.kind === 'text' ? [i.text] : []))
        console.log(`[live] ${provider} tools ${JSON.stringify(tools)}, said ${JSON.stringify(said.slice(-1))}`)
        expect(tools).toContain('mcp__kernel__get_issue')
        expect(tools.filter((t) => /linear/i.test(t))).toEqual([])
        expect(said.join('\n')).toContain(word)
      } finally {
        await done()
      }
    })
  }
})

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs = 240_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = check()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}
