import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TelemetryEvent } from '@shared/telemetry'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { tempRepo } from './helpers'

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

async function boot() {
  const repo = await tempRepo({ 'README.md': '# demo\n', '.claude/agents/checker.md': CHECKER, '.claude/agents/web.md': WEB })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-live-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-live-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
    hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'),
    workspace: { baseRef: 'main' },
    models: { lead: 'claude-haiku-4-5-20251001', engineers: 'claude-haiku-4-5-20251001', reviewer: 'claude-haiku-4-5-20251001', effort: 'low', leadPlanMode: false },
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

  it("Kernel's Rowan leads a room whose agents have no Lead", { timeout: 600_000 }, async () => {
    const { k, room, done } = await boot()
    try {
      const chat = await k.startLeadChat(room.id, { prompt: 'Who is on this team, and who takes tasks? Call list_agents and answer in two sentences.', plan: false })
      await waitFor('the Lead to answer', () => k.store.items(chat.id).some((i) => i.kind === 'result') && !k.sessions.isRunning(chat.id))
      const said = k.store.items(chat.id).flatMap((i) => (i.kind === 'text' ? [i.text] : []))
      console.log(`[live] Rowan said ${JSON.stringify(said.slice(-1))}`)
      expect(k.store.workspace(chat.workspaceId)?.agentId).toBe('kernel-lead')
      expect(k.store.items(chat.id).some((i) => i.kind === 'tool' && i.name === 'mcp__kernel__list_agents')).toBe(true)
    } finally {
      await done()
    }
  })
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
