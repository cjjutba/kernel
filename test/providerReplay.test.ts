import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Approval, Chat, ChatItem, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { Sessions } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'
import { claudeReplay, type ClaudeReplay } from './helpers/replayClaude'
import { codexReplay, type CodexReplay } from './helpers/replayCodex'
import { mismatch, parseReplay } from './helpers/replayMatch.mjs'
import { fakeCodex, item, script } from './helpers/fakeCodex'
import { tempRepo } from './helpers'

// Replays recorded provider sessions through Kernel's real runners, with no model: the Claude runner against a fake `query()`
// and the Codex runner against a fake `codex app-server` process. The format and the recorder are in
// test/fixtures/replay/README.md.
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...(await original<object>()), query: (await import('./helpers/replayClaude')).replayQuery }))

const recording = (name: string) => join(__dirname, 'fixtures/replay', `${name}.ndjson`)

const sean = { id: 'sean', file: '.claude/agents/sean.md', name: 'Sean', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Sean.' } as AgentDef

type Replay = ClaudeReplay | CodexReplay

/** Everything a scenario looks at: what Kernel stored, what it showed and which statuses the agent went through. */
async function start(provider: 'claude' | 'codex', scenario: string, o: { chat?: Partial<Chat>; seed?: (store: Store) => void } = {}) {
  const file = recording(`${provider}-${scenario}`)
  const replay: Replay = provider === 'claude' ? await claudeReplay(file) : await codexReplay(file)
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-replay-')), 'kernel.db'))
  const repo = await tempRepo()
  const ws: Workspace = { id: 'ws', projectId: 'project', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: repo, mode: 'worktree', agentId: sean.id, port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
  const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', provider, model: provider === 'claude' ? 'claude-sonnet-5-5' : 'gpt-6-astra', effort: 'low', plan: false, createdAt: 1, ...o.chat }
  store.saveWorkspace(ws)
  store.saveChat(chat)
  o.seed?.(store)
  const statuses: string[] = []
  bus.on('push', (e: PushEvent) => { if (e.type === 'agent.status' && statuses.at(-1) !== e.status) statuses.push(e.status) })
  const approvals = new Approvals(store)
  const settings = { permissions: { mode: 'acceptEdits', network: true, alwaysAsk: ['drizzle-kit push'], neverAllow: ['git push origin main'], protectedBranches: ['main'], approvalTimeoutSec: 300 }, providers: { codex: { path: (replay as CodexReplay).bin, useSystem: false, personality: 'pragmatic' } } } as unknown as AppSettings
  const allow: string[] = []
  const sessions = new Sessions({
    store, approvals, settings: () => settings, agentFor: () => sean, mcpFor: () => undefined, envFor: () => (provider === 'codex' ? (replay as CodexReplay).env : {}),
    projectAllow: () => allow, allowInProject: (_p, rule) => { allow.push(rule) },
    codexFor: () => ({ bin: (replay as CodexReplay).bin, personality: 'pragmatic', tools: [] })
  })
  live.push(sessions)

  /** Resolves when `check` passes, tried at every event Kernel pushes. A replay mismatch rejects it at once, naming the frame. */
  const until = (check: () => boolean | undefined | Promise<boolean | undefined>) => new Promise<void>((resolve, reject) => {
    let done = false
    const look = async () => {
      if (done) return
      try {
        if (provider === 'claude') (replay as ClaudeReplay).assertNoMismatch(); else await (replay as CodexReplay).assertNoMismatch()
        if (!(await check()) || done) return
        done = true; bus.off('push', look); resolve()
      } catch (e) { done = true; bus.off('push', look); reject(e) }
    }
    bus.on('push', look)
    void look()
  })
  const idle = () => until(() => !sessions.isRunning(chat.id))
  const pending = async () => { await until(() => store.approvals({ pendingOnly: true }).length > 0); return store.approvals({ pendingOnly: true })[0] }
  /** Throws unless Kernel did everything the recording expects, and nothing else. */
  const finish = async () => { await (replay as { assertDone(): Promise<void> | void }).assertDone() }
  return { replay, store, sessions, approvals, chat, statuses, until, idle, pending, finish, items: () => store.items(chat.id) }
}

const live: Sessions[] = []
afterEach(() => { for (const s of live.splice(0)) s.stopAll(); bus.removeAllListeners('push') })

/** A chat item as the transcript shows it, in a line a test can compare. */
function row(i: ChatItem): string {
  switch (i.kind) {
    case 'user': return `user: ${i.parts.map((p) => (p.type === 'text' ? p.text : p.type)).join(' ')}`
    case 'text': return `text: ${i.text}`
    case 'thinking': return `thinking: ${i.text}`
    case 'tool': return `tool: ${i.name} ${i.status}${i.output ? ` (${i.output})` : ''}`
    case 'approval': return 'approval'
    case 'result': return `result: ${i.ok ? 'ok' : 'failed'}`
    default: return i.kind
  }
}
const rows = (items: ChatItem[]) => items.map(row)

/** What an approval row held at the end: who asked, for what, and how it ended. */
const approvalOf = (a: Approval) => ({ kind: a.kind, toolName: a.toolName, title: a.title, status: a.status })

describe('the replay format', () => {
  it('reads a header and frames, and names the line of a bad one', () => {
    const ok = parseReplay('{"provider":"claude","scenario":"s","description":"d"}\n{"dir":"in","msg":{}}\n{"dir":"out","user":{"text":"hi"}}\n')
    expect(ok.header.scenario).toBe('s')
    expect(ok.frames.map((f) => f.dir)).toEqual(['in', 'out'])
    expect(() => parseReplay('{"provider":"claude","scenario":"s"}\n', 'x.ndjson')).toThrow('x.ndjson, line 1: the header needs "description"')
    expect(() => parseReplay('{"provider":"claude","scenario":"s","description":"d"}\n{"dir":"up"}\n', 'x.ndjson')).toThrow('x.ndjson, line 2: "dir" must be "in" or "out"')
    expect(() => parseReplay('{"provider":"claude","scenario":"s","description":"d"}\nnope\n', 'x.ndjson')).toThrow('x.ndjson, line 2: not JSON')
  })

  it('matches the fields a recording names, with * for any value and ~ for text that contains', () => {
    expect(mismatch({ a: 1, b: { c: '*' } }, { a: 1, b: { c: 0, d: 2 }, e: 3 })).toBeUndefined()
    expect(mismatch({ text: '~column' }, { text: 'Add a pdf_url column now' })).toBeUndefined()
    expect(mismatch({ a: [1, 2] }, { a: [1] })).toContain('$.a: expected 2 items')
    expect(mismatch({ a: { b: 1 } }, { a: { b: 2 } })).toBe('$.a.b: expected 1, got 2')
    expect(mismatch({ a: '*' }, {})).toBe('$.a: missing')
  })

  it('has a recording for every scenario of both providers, each with its own header', async () => {
    for (const provider of ['claude', 'codex']) {
      for (const scenario of ['plain-turn', 'approval-allowed', 'interrupt', 'resume']) {
        const { header } = parseReplay(await readFile(recording(`${provider}-${scenario}`), 'utf8'))
        expect(header).toMatchObject({ provider, scenario })
      }
    }
  })
})

describe.each(['claude', 'codex'] as const)('%s replay', (provider) => {
  it('plays a plain turn: thinking, streamed text, a tool call and the result', async () => {
    const t = await start(provider, 'plain-turn')
    await t.sessions.send('chat', [{ type: 'text', text: 'Add a pdf_url column' }])
    await t.idle()
    await t.finish()
    if (provider === 'claude') {
      expect(rows(t.items())).toEqual([
        'user: Add a pdf_url column', 'thinking: Schema first.', "text: I'll read the schema first.", 'tool: Read done (export const invoices = {})', `text: Added the column.`, 'result: ok'
      ])
      expect(t.store.chat('chat')?.sessionId).toBe('sess-1')
    } else {
      // Codex's text deltas are ignored: the finished message is the row.
      expect(rows(t.items())).toEqual([
        'user: Add a pdf_url column', 'thinking: **Reading the schema**', 'tool: Bash done (export const invoices = {})', `text: Added the column.`, 'result: ok'
      ])
      expect(t.store.chat('chat')?.sessionId).toBe('thread-1')
    }
    expect(t.statuses).toEqual(['working', 'idle'])
    expect(t.store.approvals({})).toEqual([])
    expect(t.sessions.isRunning('chat')).toBe(false)
  })

  it('asks for an approval, shows it as a row, and runs the step once the user allows it', async () => {
    const t = await start(provider, 'approval-allowed')
    await t.sessions.send('chat', [{ type: 'text', text: 'Install the dependencies' }])
    const ask = await t.pending()
    expect(ask).toMatchObject({ kind: 'tool', toolName: 'Bash', title: 'Run pnpm install', chatId: 'chat', workspaceId: 'ws', status: 'pending' })
    expect(t.statuses.at(-1)).toBe('needs')
    t.approvals.decide(ask.id, { behavior: 'allow' })
    await t.idle()
    await t.finish()
    expect(rows(t.items())).toEqual(['user: Install the dependencies', 'approval', 'tool: Bash done (Done in 2s)', 'text: Installed.', 'result: ok'])
    expect(t.store.approvals({}).map(approvalOf)).toEqual([{ kind: 'tool', toolName: 'Bash', title: 'Run pnpm install', status: 'allowed' }])
    expect(t.statuses).toEqual(['working', 'needs', 'working', 'idle'])
  })

  it('stops a turn the user interrupts, and shows it as interrupted instead of failed', async () => {
    const t = await start(provider, 'interrupt')
    await t.sessions.send('chat', [{ type: 'text', text: 'Run the whole suite' }])
    await t.until(() => t.items().some((i) => i.kind === 'tool' && i.status === 'running'))
    await t.sessions.interrupt('chat')
    await t.idle()
    await t.finish()
    const kinds = t.items().map((i) => i.kind)
    expect(kinds).toContain('interrupted')
    expect(kinds).not.toContain('result')
    expect(rows(t.items())[0]).toBe('user: Run the whole suite')
    expect(t.statuses.at(-1)).toBe('idle')
  })

  it('resumes the chat by the id saved before a restart, and keeps what the chat already had', async () => {
    const earlier: ChatItem[] = [
      { kind: 'user', id: 'u0', ts: 1, parts: [{ type: 'text', text: 'Add a pdf_url column' }] } as ChatItem,
      { kind: 'text', id: 't0', ts: 2, text: 'Added the column.' }
    ]
    const t = await start(provider, 'resume', { chat: { sessionId: provider === 'claude' ? 'sess-1' : 'thread-1' }, seed: (store) => { for (const i of earlier) store.saveItem('chat', i) } })
    await t.sessions.send('chat', [{ type: 'text', text: 'Carry on' }])
    await t.idle()
    await t.finish()
    expect(rows(t.items())).toEqual(['user: Add a pdf_url column', 'text: Added the column.', 'user: Carry on', 'text: Picking up where we left off.', 'result: ok'])
    expect(t.store.chat('chat')?.sessionId).toBe(provider === 'claude' ? 'sess-1' : 'thread-1')
  })
})

describe('a replay that goes wrong', () => {
  it('fails Claude with the frame number when Kernel sends something the recording did not expect', async () => {
    const t = await start('claude', 'plain-turn')
    // The recording expects "Add a pdf_url column" as frame 2, after the options.
    await t.sessions.send('chat', [{ type: 'text', text: 'Something else' }])
    await expect(t.until(() => false)).rejects.toThrow(/plain-turn: frame 2 \(line 3 of .*claude-plain-turn\.ndjson\) did not match: \$\.text: expected "Add a pdf_url column", got "Something else"/)
  })

  it('fails Claude when the recording ends before Kernel did everything it expects', async () => {
    const t = await start('claude', 'interrupt')
    await t.sessions.send('chat', [{ type: 'text', text: 'Run the whole suite' }])
    await t.until(() => t.items().some((i) => i.kind === 'tool' && i.status === 'running'))
    expect(() => (t.replay as ClaudeReplay).assertDone()).toThrow(/the replay stopped at frame 5 of 7 .*expects next: out \{"interrupt":true\}/)
  })

  it('fails Codex with the frame number when Kernel sends something the recording did not expect', async () => {
    const t = await start('codex', 'plain-turn')
    await t.sessions.send('chat', [{ type: 'text', text: 'Something else' }])
    await expect(t.until(() => false)).rejects.toThrow(/plain-turn: frame 6 \(line 7 of .*codex-plain-turn\.ndjson\) did not match: \$\.params\.input\[0\]\.text: expected "Add a pdf_url column", got "Something else"/)
  })

  it('fails Codex when the recording ends before Kernel did everything it expects', async () => {
    const t = await start('codex', 'interrupt')
    await t.sessions.send('chat', [{ type: 'text', text: 'Run the whole suite' }])
    await t.until(() => t.items().some((i) => i.kind === 'tool' && i.status === 'running'))
    await expect(t.finish()).rejects.toThrow(/the replay stopped at frame 10 of 12 \(line 11 of .*codex-interrupt\.ndjson\)/)
  })
})

describe('the recorder', () => {
  const record = async (env: Record<string, string>, args: string[]) => {
    await promisify(execFile)(process.execPath, [join(__dirname, '..', 'scripts', 'record-replay.ts'), ...args], { env: { ...process.env, ...env, KERNEL_LIVE: '1' } })
  }

  it('refuses to run without KERNEL_LIVE=1, so CI never spends a turn', async () => {
    const run = promisify(execFile)(process.execPath, [join(__dirname, '..', 'scripts', 'record-replay.ts'), 'codex', 'x', '--prompt', 'hi'], { env: { ...process.env, KERNEL_LIVE: '' } })
    await expect(run).rejects.toThrow('Set KERNEL_LIVE=1 to record')
  })

  it('writes a Codex session as a recording that plays back to the same frames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-recorder-'))
    const fake = await fakeCodex()
    const first = join(dir, 'first.ndjson')
    const prompt = script(...item({ type: 'agentMessage', id: 'a1', text: 'Done.', phase: 'final_answer' }))
    await record({}, ['codex', 'recorded', '--prompt', prompt, '--description', 'A recorded turn', '--model', 'gpt-6-astra', '--codex', fake.bin, '--cwd', dir, '--out', first])
    const { header, frames } = parseReplay(await readFile(first, 'utf8'), first)
    expect(header).toEqual({ provider: 'codex', scenario: 'recorded', description: 'A recorded turn' })
    expect(frames.filter((f) => f.dir === 'out').map((f) => (f.msg as { method: string }).method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
    expect(frames.some((f) => (f.msg as { method?: string }).method === 'turn/completed')).toBe(true)

    // Played back to the recorder, the recording gives it the same session.
    const again = join(dir, 'again.ndjson')
    const player = await codexReplay(first)
    await record(player.env, ['codex', 'recorded', '--prompt', prompt, '--description', 'A recorded turn', '--model', 'gpt-6-astra', '--codex', player.bin, '--cwd', dir, '--out', again])
    await player.assertDone()
    expect(await readFile(again, 'utf8')).toBe(await readFile(first, 'utf8'))
  })
})
