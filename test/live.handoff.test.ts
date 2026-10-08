import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityEvent } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { tempRepo } from './helpers'

// KERNEL-67 against real Claude Code: a Lead whose own file only plans, briefed in plan mode, then "Approve and hand off".
// It spends a short Sonnet planning turn and one Haiku turn on the Claude plan, so it only runs when asked:
//   KERNEL_LIVE=1 npm test -- test/live.handoff.test.ts
// The repo is a temp one, and it never writes to ~/.claude/settings.json.

// The kernel repo's own Lead, which says nothing about create_workspace, moved to Sonnet.
const ROWAN = `---
name: rowan
description: Lead. Plans sprint work, splits issues that are too big, and keeps Linear honest.
model: sonnet
role: Lead
lead: true
tools: Read, Grep, Glob, Bash, mcp__linear
---
You are Rowan, the lead for building this project. You plan, you don't write feature code.
- Read the README before planning.
- Break work so each piece fits one PR and stays inside one lane's files.
`
const NOOR = `---
name: noor
description: Engine engineer.
model: haiku
role: Backend
---
You build the engine. Reply in one sentence and stop.
`

describe.skipIf(!process.env.KERNEL_LIVE)('live hand-off', () => {
  it('a plan-only Lead creates a workspace after Approve and hand off', { timeout: 600_000 }, async () => {
    const repo = await tempRepo({ 'README.md': '# demo\n', '.claude/agents/rowan.md': ROWAN, '.claude/agents/noor.md': NOOR })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-live-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-live-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'),
      workspace: { baseRef: 'main' },
      models: { lead: 'claude-sonnet-5-5', engineers: 'claude-haiku-4-5-20251001', effort: 'low', leadPlanMode: true },
      permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [] }
    }))
    const activity: ActivityEvent[] = []
    const onActivity = (e: ActivityEvent) => activity.push(e)
    bus.on('activity', onActivity)
    const k = new Kernel({ dataDir, home, claudeSettingsFile: join(home, 'claude-settings.json') })
    // Counts Stop reminders, to tell "handed off on its own" from "handed off after one reminder".
    let reminders = 0
    const reminder = k.sessions.handoffs.reminder.bind(k.sessions.handoffs)
    k.sessions.handoffs.reminder = (id: string) => { const r = reminder(id); if (r) reminders++; return r }
    await k.start()
    const h = k.handlers()
    try {
      const room = await h['rooms.add']({ path: repo })
      const { chatId } = await h['rooms.brief']({ roomId: room.id, text: 'Plan this: add the line "Kernel was here" to README.md. Keep the plan short.' })
      const plan = await waitFor('plan card', () => k.store.approvals({ roomId: room.id }).find((a) => a.status === 'pending' && a.kind === 'plan'))
      console.log(`[live] plan card from ${plan.toolName ?? 'request_plan_approval'}:\n${(plan.detail ?? '').slice(0, 400)}`)
      k.approvals.decide(plan.id, { behavior: 'allow' })
      const created = await waitFor('a workspace from the Lead', () => activity.find((a) => a.kind === 'workspace.created' && a.roomId === room.id), 300_000)
      const said = k.store.items(chatId).flatMap((i) => (i.kind === 'text' ? [i.text.slice(0, 200)] : []))
      console.log(`[live] ${created.text} ${created.object}. Stop reminders: ${reminders}. Rowan's last words: ${JSON.stringify(said.slice(-2))}`)
      expect(created.object).toBe('noor')
    } finally {
      bus.off('activity', onActivity)
      for (const w of k.store.workspaces()) if (w.mode === 'worktree') await k.archiveWorkspace(w.id, true).catch(() => undefined)
      await k.stop()
      for (const dir of [home, dataDir, repo]) await rm(dir, { recursive: true, force: true })
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
