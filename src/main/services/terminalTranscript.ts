import { open, stat } from 'node:fs/promises'
import { unwatchFile, watchFile } from 'node:fs'
import type { ChatItem } from '@shared/types'
import { bus } from '../bus'
import { describeTool } from './approvals'
import { clipInput, TOOL_TEXT_MAX, toolDetail } from './providers/claude'
import { Feature } from '../features/feature'

type Tool = ChatItem & { kind: 'tool' }

/** How often the file is looked at for new lines, and how much of it one read takes. */
const POLL_MS = 400
const CHUNK = 1 << 20

/** A user entry that is Claude Code's own bookkeeping: a slash command's echo, its output, a reminder or a background notice. */
const NOISE = /^<(local-command|command-name|command-message|command-args|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr)/

const text = (v: unknown) => typeof v === 'string' ? v : ''

/**
 * Turns the lines of one Claude Code session file (`transcript_path`) into chat items, one line at a time. Ids come from the
 * file's own ids, so reading a line twice, or the whole file again after it was rewritten, saves the same rows.
 */
export class TranscriptParser {
  private tools = new Map<string, Tool>()

  /** The items one JSONL line adds or changes. A line that is not JSON, or that isn't a message, adds none. */
  parse(line: string): ChatItem[] {
    let e: any
    try { e = JSON.parse(line) } catch { return [] }
    if (!e || typeof e !== 'object' || e.isSidechain || e.isMeta) return []
    if (e.type !== 'user' && e.type !== 'assistant') return []
    const content = e.message?.content
    const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    const parsed = Date.parse(e.timestamp)
    const ts = Number.isFinite(parsed) ? parsed : Date.now()
    const key = text(e.uuid) || `${ts}`
    const out: ChatItem[] = []
    const strings: string[] = []
    blocks.forEach((b, i) => {
      if (!b || typeof b !== 'object') return
      const id = `tt-${key}-${i}`
      if (e.type === 'user') {
        if (b.type === 'text' && text(b.text).trim()) strings.push(b.text)
        else if (b.type === 'tool_result') out.push(...this.result(b, ts))
        return
      }
      if (b.type === 'text' && text(b.text).trim()) out.push({ kind: 'text', id, ts, text: b.text, source: 'terminal' })
      else if (b.type === 'thinking' && text(b.thinking).trim()) out.push({ kind: 'thinking', id, ts, text: b.thinking, source: 'terminal' })
      else if (b.type === 'tool_use' && text(b.id)) out.push(...this.call(b, ts))
    })
    if (e.type === 'user' && strings.length && !e.isCompactSummary) {
      const joined = strings.join('\n\n')
      const id = `tt-${key}`
      if (joined.startsWith('[Request interrupted by user')) out.unshift({ kind: 'interrupted', id, ts })
      else if (!NOISE.test(joined.trimStart())) out.unshift({ kind: 'user', id, ts, parts: [{ type: 'text', text: joined }], source: 'terminal' })
    }
    return out
  }

  private call(b: any, ts: number): ChatItem[] {
    const name = text(b.name)
    const plan = text(b.input?.plan).trim()
    if (name === 'ExitPlanMode' && plan) return [{ kind: 'plan', id: `tt-plan-${b.id}`, ts, text: plan, source: 'terminal' }]
    const item: Tool = { kind: 'tool', id: `tt-tool-${b.id}`, ts, toolUseId: b.id, name, label: describeTool(name, b.input).title, detail: toolDetail(name, b.input), status: 'running', input: clipInput(b.input), source: 'terminal' }
    this.tools.set(b.id, item)
    return [item]
  }

  private result(b: any, ts: number): ChatItem[] {
    const item = this.tools.get(b.tool_use_id)
    if (!item) return []
    const raw = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => text(c?.text)).join('\n') : ''
    const done: Tool = { ...item, status: b.is_error ? 'failed' : 'done', output: raw.slice(0, TOOL_TEXT_MAX), outputCut: raw.length > TOOL_TEXT_MAX || undefined, durationMs: Math.max(0, ts - item.ts) }
    this.tools.set(b.tool_use_id, done)
    return [done]
  }
}

interface Follow {
  path: string
  parser: TranscriptParser
  /** Bytes of the file already turned into lines, and the start of a last line that has no newline yet. */
  offset: number
  tail: Buffer
  /** The file's identity when last read, so a replacement of the file is told from an append. */
  ino?: number
  busy: Promise<void>
}

/**
 * A terminal seat's Claude Code session as a read-only transcript (KERNEL-1002). Follows the JSONL at the `transcript_path`
 * its hooks reported and stores each line's items on the chat like a chat's own, so history and search find them. It opens
 * the file to read and never writes to it. A file that shrinks or is replaced is read again from its start, which saves the
 * same rows because their ids come from the file. A file that is missing or unreadable is tried again on the next look.
 */
export class TerminalTranscripts extends Feature {
  private follows = new Map<string, Follow>()

  /** Follow `path` for the chat, or look again at it now. A new path replaces the old one. */
  follow(chatId: string, path: string) {
    let f = this.follows.get(chatId)
    if (f && f.path !== path) { this.unfollow(chatId); f = undefined }
    if (!f) {
      f = { path, parser: new TranscriptParser(), offset: 0, tail: Buffer.alloc(0), busy: Promise.resolve() }
      this.follows.set(chatId, f)
      watchFile(path, { interval: POLL_MS, persistent: false }, () => { void this.sync(chatId) })
    }
    return this.sync(chatId)
  }

  unfollow(chatId: string) {
    const f = this.follows.get(chatId)
    if (!f) return
    unwatchFile(f.path)
    this.follows.delete(chatId)
  }

  stop() { for (const id of [...this.follows.keys()]) this.unfollow(id) }

  /** Reads what the file gained since the last look. Reads queue, so two looks never read the same bytes twice. */
  sync(chatId: string): Promise<void> {
    const f = this.follows.get(chatId)
    if (!f) return Promise.resolve()
    f.busy = f.busy.then(() => this.read(chatId, f)).catch(() => undefined)
    return f.busy
  }

  private async read(chatId: string, f: Follow) {
    if (this.stopped || this.follows.get(chatId) !== f) return
    const s = await stat(f.path).catch(() => undefined)
    if (!s?.isFile()) return
    if (s.size < f.offset || (f.ino !== undefined && s.ino !== f.ino)) {
      f.offset = 0
      f.tail = Buffer.alloc(0)
      f.parser = new TranscriptParser()
    }
    f.ino = s.ino
    if (s.size === f.offset) return
    const fh = await open(f.path, 'r')
    try {
      while (f.offset < s.size && !this.stopped && this.follows.get(chatId) === f) {
        const buf = Buffer.alloc(Math.min(CHUNK, s.size - f.offset))
        const { bytesRead } = await fh.read(buf, 0, buf.length, f.offset)
        if (!bytesRead) break
        f.offset += bytesRead
        const data = Buffer.concat([f.tail, buf.subarray(0, bytesRead)])
        const end = data.lastIndexOf(0x0a)
        f.tail = end < 0 ? data : data.subarray(end + 1)
        if (end < 0) continue
        for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
          if (line.trim()) for (const item of f.parser.parse(line)) this.place(chatId, item)
        }
      }
    } finally {
      await fh.close()
    }
  }

  private place(chatId: string, item: ChatItem) {
    if (this.stopped || !this.store.chat(chatId)) return
    this.store.saveItem(chatId, item)
    bus.push({ type: 'chat.item', chatId, item })
  }
}
