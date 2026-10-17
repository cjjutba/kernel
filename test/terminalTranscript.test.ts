import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, rename, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatItem } from '@shared/types'
import { TerminalTranscripts, TranscriptParser } from '../src/main/services/terminalTranscript'

// KERNEL-1002: a terminal seat's Claude Code session file becomes read-only chat items.

const FIXTURE = join(__dirname, 'fixtures', 'terminal-session.jsonl')

const parseAll = (raw: string) => { const p = new TranscriptParser(); return raw.split('\n').filter(Boolean).flatMap((l) => p.parse(l)) }
const line = (o: object) => JSON.stringify(o) + '\n'
const user = (uuid: string, text: string) => line({ type: 'user', uuid, timestamp: '2026-10-17T05:00:00.000Z', message: { role: 'user', content: text } })

describe('parsing a recorded session', () => {
  it('turns user messages, text, thinking, tool calls with results and plans into items', async () => {
    const items = parseAll(await readFile(FIXTURE, 'utf8'))
    expect(items.map((i) => i.kind)).toEqual(['user', 'thinking', 'text', 'tool', 'tool', 'tool', 'tool', 'plan', 'interrupted', 'user'])
    const [first, , text, read, readDone, bash, bashDone, plan, , last] = items as any[]
    expect(first).toMatchObject({ id: 'tt-u1', source: 'terminal', parts: [{ type: 'text', text: 'Add a cart badge' }], ts: Date.parse('2026-10-17T04:00:01.000Z') })
    expect(text).toMatchObject({ text: "I'll check the header.", source: 'terminal' })
    expect(read).toMatchObject({ id: 'tt-tool-toolu_1', name: 'Read', status: 'running', detail: '/repo/Header.tsx', source: 'terminal' })
    expect(readDone).toMatchObject({ id: read.id, status: 'done', output: 'export const Header = () => null', durationMs: 1000 })
    expect(bash).toMatchObject({ name: 'Bash', detail: 'pnpm test' })
    expect(bashDone).toMatchObject({ id: bash.id, status: 'failed', output: '1 failed', durationMs: 3000 })
    expect(plan).toMatchObject({ kind: 'plan', text: '# Cart badge\n\n1. Count items\n2. Show it', source: 'terminal' })
    expect(last.parts).toEqual([{ type: 'text', text: 'Thanks' }])
  })

  it('leaves out subagent chatter, meta entries, command echoes, bad lines and unknown types', () => {
    const p = new TranscriptParser()
    expect(p.parse('{"type":"assistant","uuid":"x","isSidechain":true,"message":{"content":[{"type":"text","text":"hi"}]}}')).toEqual([])
    expect(p.parse(user('c', '<command-name>/clear</command-name>'))).toEqual([])
    expect(p.parse('{"type":"attachment"}')).toEqual([])
    expect(p.parse('{"type":"user","message":')).toEqual([])
    expect(p.parse('null')).toEqual([])
    expect(p.parse('{"type":"user","uuid":"r","message":{"content":[{"type":"tool_result","tool_use_id":"never-seen","content":"x"}]}}')).toEqual([])
  })

  it('clips a long output and says so', () => {
    const p = new TranscriptParser()
    p.parse(line({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'cat big' } }] } }))
    const [done] = p.parse(line({ type: 'user', uuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(30_000) }] } })) as any[]
    expect(done.output).toHaveLength(20_000)
    expect(done.outputCut).toBe(true)
  })
})

describe('following the file', () => {
  const made: TerminalTranscripts[] = []
  afterEach(() => { for (const t of made.splice(0)) t.stop() })

  /** A transcripts feature on a fake Kernel that keeps items in a map, which is all it reads. */
  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-transcript-'))
    const rows = new Map<string, ChatItem>()
    const k: any = { stopped: false, store: { chat: () => ({ id: 'c1' }), saveItem: (_: string, i: ChatItem) => rows.set(i.id, i) } }
    const t = new TerminalTranscripts(k)
    made.push(t)
    return { dir, rows, t, ids: () => [...rows.keys()] }
  }

  it('reads what is there, then only what is appended, and holds back a line with no newline', async () => {
    const { dir, rows, t, ids } = await setup()
    const path = join(dir, 's.jsonl')
    await writeFile(path, user('u1', 'one') + user('u2', 'two').slice(0, 30))
    await t.follow('c1', path)
    expect(ids()).toEqual(['tt-u1'])
    await appendFile(path, user('u2', 'two').slice(30))
    await t.sync('c1')
    expect(ids()).toEqual(['tt-u1', 'tt-u2'])
    const before = rows.get('tt-u1')
    await appendFile(path, user('u3', 'three'))
    await t.sync('c1')
    expect(ids()).toEqual(['tt-u1', 'tt-u2', 'tt-u3'])
    expect(rows.get('tt-u1')).toBe(before)
  })

  it('picks appends up by itself from the watch', async () => {
    const { dir, t, ids } = await setup()
    const path = join(dir, 's.jsonl')
    await writeFile(path, user('u1', 'one'))
    await t.follow('c1', path)
    await appendFile(path, user('u2', 'two'))
    await expect.poll(ids, { timeout: 5000 }).toEqual(['tt-u1', 'tt-u2'])
  })

  it('does not split a multi-byte character across reads', async () => {
    const { dir, rows, t } = await setup()
    const path = join(dir, 's.jsonl')
    const bytes = Buffer.from(user('u1', 'café \u{1F680}'))
    await writeFile(path, bytes.subarray(0, bytes.length - 10))
    await t.follow('c1', path)
    await appendFile(path, bytes.subarray(bytes.length - 10))
    await t.sync('c1')
    expect((rows.get('tt-u1') as any).parts[0].text).toBe('café \u{1F680}')
  })

  it('survives a missing file, a truncated file and a replaced file', async () => {
    const { dir, t, ids } = await setup()
    const path = join(dir, 's.jsonl')
    await expect(t.follow('c1', path)).resolves.toBeUndefined()
    await writeFile(path, user('u1', 'one') + user('u2', 'two'))
    await t.sync('c1')
    expect(ids()).toEqual(['tt-u1', 'tt-u2'])
    await truncate(path, 0)
    await t.sync('c1')
    await writeFile(path, user('u1', 'one') + user('u9', 'nine'))
    await t.sync('c1')
    expect(ids()).toEqual(['tt-u1', 'tt-u2', 'tt-u9'])
    await rename(path, join(dir, 'old.jsonl'))
    await writeFile(path, user('u7', 'seven'))
    await t.sync('c1')
    expect(ids()).toContain('tt-u7')
  })

  it('never changes the file', async () => {
    const { dir, t } = await setup()
    const path = join(dir, 's.jsonl')
    const raw = user('u1', 'one') + 'not json\n'
    await writeFile(path, raw)
    await t.follow('c1', path)
    expect(await readFile(path, 'utf8')).toBe(raw)
  })
})
