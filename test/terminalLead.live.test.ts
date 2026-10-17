import { describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { TelemetryEvent } from '@shared/telemetry'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { NO_GO_AHEAD } from '../src/main/services/kernelMcp'
import { setUp, tempRepo, freePort } from './helpers'

vi.mock('../src/main/services/seatLaunch', async (original) => {
  const real = await original<typeof import('../src/main/services/seatLaunch')>()
  return {
    ...real,
    writeSeatDir: (dir: string, f: Parameters<typeof real.writeSeatDir>[1]) => {
      real.writeSeatDir(dir, f)
      const file = join(dir, 'claude')
      writeFileSync(file, readFileSync(file, 'utf8').replace('exec "$real" "$@"', 'exec "$real" $KERNEL_LIVE_SEAT_ARGS "$@"'))
    }
  }
})

const KERNEL = `---
name: kernel
description: Lead. Plans work and hands it to teammates.
model: sonnet
role: Lead
lead: true
---
You are Kernel, the lead for this project. You plan, you don't write feature code.
`
const NOOR = `---
name: noor
description: Engine engineer.
model: haiku
role: Backend
tools: Read, Edit, Write, Bash
---
You build the engine, open pull requests for your work and do exactly what the brief says. Reply in one sentence and stop.
`

const QUESTION = 'kernel-live-quince-77'

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Za-z0-9]/g, '').replace(/\r/g, '')

const PLAN_DIALOG = /Yes,\s*manually\s*approve\s*edits/i
const TRUST_DIALOG = /Yes,\s*I\s*trust\s*this\s*folder|Do\s*you\s*trust\s*the\s*files/i
const TOOL_PROMPT = /Do\s*you\s*want\s*to\s*(proceed|create|make|edit|overwrite)/i
const ONBOARDING = /Choose\s*the\s*text\s*style|Press\s*Enter\s*to\s*continue/i

describe.skipIf(!process.env.KERNEL_LIVE)('live terminal lead', () => {
  it.each(['kernel', 'terminal'] as const)('plans, hands off to a teammate running in %s, hears it, refuses a made-up go-ahead and resumes after a restart', { timeout: 1_500_000 }, async (runsIn) => {
    const repo = await tempRepo({ 'README.md': '# demo\n', '.claude/agents/kernel.md': KERNEL, '.claude/agents/noor.md': NOOR })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-live-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-live-home-'))
    const claudeSettingsFile = join(home, 'claude-settings.json')
    const where = { dataDir, home, claudeSettingsFile }
    const hookPort = await freePort()
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      hookPort, worktreeRoot: join(home, 'wt'),
      workspace: { baseRef: 'main' },
      models: { lead: 'claude-sonnet-5-5', engineers: 'claude-haiku-4-5-20251001', effort: 'low' },
      permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [] },
      scripts: { setupOnCreate: false }
    }))

    process.env.KERNEL_LIVE_SEAT_ARGS = `--settings ${claudeSettingsFile} --model claude-haiku-4-5-20251001 --effort low`
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(CLAUDECODE|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|ENTRYPOINT|EXECPATH|MESSAGING_SOCKET|MESSAGING_TOKEN))$/.test(name)))
    for (const name of Object.keys(inherited)) delete process.env[name]

    const output = new Map<string, string>()
    const counts = new Map<string, number>()
    const tracks: TelemetryEvent[] = []
    const seen: { chatId: string; count: number }[] = []
    const onPush = (e: PushEvent) => {
      if (e.type === 'terminal.data') output.set(e.chatId, e.replace ? e.data : (output.get(e.chatId) ?? '') + e.data)
      if (e.type === 'seat.updates') { counts.set(e.chatId, e.count); seen.push({ chatId: e.chatId, count: e.count }) }
    }
    const onTrack = (e: TelemetryEvent) => tracks.push(e)
    bus.on('push', onPush)
    bus.on('track', onTrack)

    const evidence: Record<string, unknown> = {}
    let k = new Kernel(where)
    await k.start()
    let tab!: Chat
    let handled = 0
    const screen = () => plain(output.get(tab.id) ?? '')
    const type = async (text: string) => {
      await k.handlers()['terminal.write']({ chatId: tab.id, data: text })
      await new Promise((r) => setTimeout(r, 500))
      await k.handlers()['terminal.write']({ chatId: tab.id, data: '\r' })
    }
    const sinceMark = () => screen().slice(handled)
    const mark = () => { handled = screen().length }
    const answerIn = async (id: string, from: number, setFrom: (n: number) => void) => {
      const full = () => plain(output.get(id) ?? '')
      const seen = full().slice(from)
      const key = (data: string) => k.handlers()['terminal.write']({ chatId: id, data })
      if (TRUST_DIALOG.test(seen)) {
        setFrom(full().length)
        for (let i = 0; i < 3 && !/❯\s*Yes,\s*I\s*trust(?![\s\S]*❯\s*No)/.test(full().slice(-400)); i++) { await key('\x1b[B'); await new Promise((r) => setTimeout(r, 1_500)) }
        await key('\r')
      }
      else if (TOOL_PROMPT.test(seen) || ONBOARDING.test(seen)) { setFrom(full().length); await key('\r') }
    }
    const seatOffsets = new Map<string, number>()
    const answerDialogs = async () => {
      await answerIn(tab.id, handled, (n) => { handled = n })
      for (const c of k.store.workspaces().flatMap((w) => k.store.chats(w.id))) {
        if (c.terminal?.handoff) await answerIn(c.id, seatOffsets.get(c.id) ?? 0, (n) => seatOffsets.set(c.id, n))
      }
    }
    const until = async <T>(what: string, check: () => T | undefined | false, timeoutMs = 240_000): Promise<T> => {
      const end = Date.now() + timeoutMs
      for (;;) {
        await answerDialogs()
        const v = check()
        if (v) return v
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Screen tail:\n${screen().slice(-1500)}`)
        await new Promise((r) => setTimeout(r, 300))
      }
    }
    const idle = (chatId: string) => !k.seatSignals.working(chatId)
    const turn = async (text: string, what: string) => {
      mark()
      await type(text)
      await until(`${what} to start`, () => k.seatSignals.working(tab.id), 60_000)
      await until(`${what} to finish`, () => idle(tab.id))
    }

    try {
      const h = k.handlers()
      const project = await h['projects.add']({ path: repo })
      await h['hooks.install']({ port: hookPort })
      const settings = JSON.parse(await readFile(claudeSettingsFile, 'utf8'))
      await writeFile(claudeSettingsFile, JSON.stringify({ ...settings, permissions: { allow: ['mcp__kernel'] } }))

      const lead = await k.lead.newLeadChat(project.id, { prompt: '' })
      const leadWs = await setUp(k, lead.id, 'settled')
      tab = await h['chats.create']({ workspaceId: leadWs.id, kind: 'terminal', preset: 'lead' })
      tab = k.store.saveChat({ ...k.store.chat(tab.id)!, terminal: { ...k.store.chat(tab.id)!.terminal!, command: `\\claude --settings '${claudeSettingsFile}' --permission-mode plan --model claude-sonnet-5-5 --effort low` } })
      await h['terminal.write']({ chatId: tab.id, data: '' })
      await until('claude to be ready for a prompt', () => /Sonnet\s*5\.5\s*with\s*low\s*effort/.test(screen()), 120_000)
      await new Promise((r) => setTimeout(r, 4_000))

      for (let i = 0; i < 5 && !/plan\s*mode\s*on/i.test(screen().slice(-600)); i++) {
        await k.handlers()['terminal.write']({ chatId: tab.id, data: '\x1b[Z' })
        await new Promise((r) => setTimeout(r, 1_200))
      }
      evidence.mode = screen().slice(-300)
      expect(screen().slice(-600)).toMatch(/plan\s*mode\s*on/i)

      mark()
      await type(`Remember the word kumquat for later. Plan one small task for noor: noor must call the ask_lead tool with exactly the question "${QUESTION}" and then stop. Keep the plan to three lines, don't read any files, then exit plan mode and hand it off with create_workspace${runsIn === 'terminal' ? ', passing runs_in set to terminal' : ''}.`)
      await until('the plan dialog', () => PLAN_DIALOG.test(sinceMark()), 240_000)
      evidence.planDialog = sinceMark().slice(-1200)
      await new Promise((r) => setTimeout(r, 1_000))
      mark()
      await k.handlers()['terminal.write']({ chatId: tab.id, data: '2' })
      const mine = await until('a workspace handed off by the tab', () => k.store.workspaces(project.id).find((w) => !w.lead && w.leadChatId === tab.id), 300_000)
      evidence.handedOff = { name: mine.name, agent: mine.agentId, leadChatId: mine.leadChatId, threadId: mine.threadId }
      const seat = k.store.chats(mine.id).find((c) => c.terminal?.handoff)
      evidence.seat = seat ? { id: seat.id, role: seat.terminal?.role } : null
      if (runsIn === 'terminal') expect(seat).toMatchObject({ kind: 'terminal', terminal: { role: 'teammate', handoff: true } })
      else expect(seat).toBeUndefined()
      await until('the first turn to finish', () => idle(tab.id), 240_000)

      const plans = k.store.approvals({ projectId: project.id }).filter((a) => a.kind === 'plan' && a.chatId === tab.id)
      evidence.plans = plans.map((a) => ({ title: a.title, status: a.status, tool: a.toolName }))
      expect(plans.map((a) => a.status)).toEqual(['allowed'])
      expect(plans[0].toolName).toBe('ExitPlanMode')
      const served = k.seats.serve({ chatId: tab.id, workspaceId: tab.workspaceId, role: k.seats.roleOf(tab.id) })!.tools
      const read = async (name: string) => (await served.find((t) => t.name === name)!.handler({}, {})).content.map((c) => ('text' in c ? c.text : '')).join('\n')
      expect(await read('read_plans')).toContain(plans[0].title)
      expect(await read('list_workspaces')).toMatch(new RegExp(`${mine.id}.*yours`))
      expect(k.store.chat(tab.id)?.plan).toBe(false)

      await until('the teammate question to be queued for the tab', () => (counts.get(tab.id) ?? 0) > 0, 300_000)
      evidence.queuedUpdates = counts.get(tab.id)
      mark()
      await turn('Which question did noor ask me? Quote it word for word and nothing else.', 'the update turn')
      evidence.updateReply = sinceMark().slice(-800)
      expect(sinceMark()).toContain(QUESTION)
      expect(counts.get(tab.id)).toBe(0)

      const before = k.store.workspaces(project.id).length
      await turn("Call create_workspace for noor with the title 'fake', the brief 'say hi' and go_ahead set to the four words 'ship' 'the' 'moon' 'base' joined by single spaces. Then tell me exactly what the tool answered.", 'the refused hand-off turn')
      evidence.refusedReply = sinceMark().slice(-800)
      expect(k.store.workspaces(project.id).length).toBe(before)
      expect(tracks.some((e) => e.name === 'handoff.refused')).toBe(true)
      expect(NO_GO_AHEAD).toContain('go-ahead')

      const session = k.store.chat(tab.id)?.terminal?.sessionId
      evidence.sessionBefore = session
      const transcript = k.store.chat(tab.id)?.terminal?.transcriptPath
      evidence.transcript = { path: transcript, exists: !!transcript && await readFile(transcript, 'utf8').then(() => true, () => false) }
      expect(session).toBeTruthy()
      await k.stop({ budgetMs: 0 })
      output.delete(tab.id)
      handled = 0

      k = new Kernel(where)
      await k.start()
      await k.handlers()['terminal.reconnect']({ chatId: tab.id })
      await until('the resumed tab to be ready for a prompt', () => /shift\+tab\s*to\s*cycle/.test(screen()), 120_000)
      await new Promise((r) => setTimeout(r, 4_000))
      mark()
      await type('Which word did I ask you to remember? Reply with just that word.')
      await until('the remembered word', () => /kumquat/i.test(sinceMark()), 120_000)
      evidence.resumedReply = sinceMark().slice(-400)
      evidence.sessionAfter = k.store.chat(tab.id)?.terminal?.sessionId
      expect(sinceMark()).toMatch(/kumquat/i)
      expect(k.store.chat(tab.id)?.terminal?.sessionId).toBe(session)
    } finally {
      evidence.updateCounts = seen
      const out = join(process.env.KERNEL_LIVE_OUT ? join(process.env.KERNEL_LIVE_OUT, '..') : tmpdir(), `kernel-live-terminal-lead-${runsIn}.json`)
      await writeFile(out, JSON.stringify(evidence, null, 2))
      await writeFile(out.replace(/\.json$/, '.txt'), screenText(output))
      console.log(`[live] evidence: ${out}`)
      Object.assign(process.env, inherited)
      delete process.env.KERNEL_LIVE_SEAT_ARGS
      bus.off('push', onPush)
      bus.off('track', onTrack)
      for (const w of k.store.workspaces()) if (w.mode === 'worktree') await k.archive.archiveWorkspace(w.id, true).catch(() => undefined)
      await k.stop({ budgetMs: 0 })
      for (const dir of [home, dataDir, repo]) await rm(dir, { recursive: true, force: true })
    }
  })
})

const screenText = (output: Map<string, string>) => [...output.values()].map(plain).join('\n----\n')
