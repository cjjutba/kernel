import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'
import { exec } from './exec'
import { parseClaudeVersion, sessionClaude } from './preflight'

export type LogLevel = 'info' | 'warn' | 'error'

/** What `redact` hides: the home folder, and secrets known by value, like the hook token. */
export interface RedactOptions { home?: string; secrets?: () => (string | undefined)[] }

const HIDDEN = '[redacted]'
/** The console as it was before `captureConsole`, for the log's own trouble. */
const original = { error: console.error.bind(console), warn: console.warn.bind(console) }
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Shapes that are secrets wherever they show up. Long hex runs catch tokens like Kernel's own hook token (64 characters)
 * and leave 40-character commit hashes alone.
 */
const TOKENS: [RegExp, string][] = [
  [/(X-Kernel-Token:\s*)[^\s'"]+/gi, `$1${HIDDEN}`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, HIDDEN],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, HIDDEN],
  [/\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, HIDDEN],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, HIDDEN],
  [/\bAKIA[0-9A-Z]{16}\b/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, HIDDEN],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${HIDDEN}`],
  // user:password@ in a URL, as in https://x-access-token:<token>@github.com.
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${HIDDEN}@`],
  // token=..., "apiKey": "...", password: ... Short values, like input_tokens: 500, are counts and stay.
  [/\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|credential|authorization)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"'&,;]{8,}/gi, `$1$2${HIDDEN}`],
  [/\b[0-9a-f]{48,}\b/gi, HIDDEN]
]

/** Replaces the home folder with `~` and hides anything that looks like a token, so the text is safe to paste into a bug report. */
export function redact(text: string, o: RedactOptions = {}): string {
  let out = text
  for (const s of o.secrets?.() ?? []) if (s && s.length >= 8) out = out.split(s).join(HIDDEN)
  for (const [re, to] of TOKENS) out = out.replace(re, to)
  // Only the whole folder: /Users/cj must not eat the start of /Users/cjjutba.
  if (o.home && o.home !== '/') out = out.replace(new RegExp(`${escape(o.home.replace(/\/+$/, ''))}(?=$|[/\\s"'\`:;,)\\]])`, 'g'), '~')
  return out
}

/**
 * Kernel's log, `~/Library/Logs/Kernel/main.log` in the app (KERNEL-288). It gets main's errors and warnings, crashes and the
 * renderer's errors, redacted as they are written. At `maxBytes` the file moves to main.log.1, and so on up to `files` files.
 * Writes are synchronous, so the line is on disk before a crash ends the process. A write that fails, as on a full disk, is
 * dropped: the log must never be the reason something else fails.
 */
export class Log {
  readonly file: string
  private size: number
  private readonly max: number
  private readonly files: number
  private broken = false

  constructor(private o: RedactOptions & { dir: string; maxBytes?: number; files?: number; now?: () => Date }) {
    this.file = join(o.dir, 'main.log')
    this.max = o.maxBytes ?? 5 * 1024 * 1024
    this.files = o.files ?? 3
    try {
      mkdirSync(o.dir, { recursive: true })
      this.size = existsSync(this.file) ? statSync(this.file).size : 0
    } catch {
      this.size = 0
    }
  }

  info(...args: unknown[]) { this.write('info', args) }
  warn(...args: unknown[]) { this.write('warn', args) }
  error(...args: unknown[]) { this.write('error', args) }

  write(level: LogLevel, args: unknown[]) {
    try {
      const at = (this.o.now?.() ?? new Date()).toISOString()
      const line = `${at} ${level.toUpperCase()} ${this.redact(format(...args))}\n`
      const bytes = Buffer.byteLength(line)
      if (this.size > 0 && this.size + bytes > this.max) this.rotate()
      appendFileSync(this.file, line)
      this.size += bytes
      this.broken = false
    } catch (e) {
      // Said once per failing stretch, on the console the log doesn't hear, or a full disk would loop on its own error.
      if (!this.broken) original.error('[log] could not write the log', e)
      this.broken = true
    }
  }

  /** The last `n` lines, reaching into main.log.1 when main.log has fewer. */
  tail(n = 200): string[] {
    const lines: string[] = []
    for (let i = 0; i < this.files && lines.length < n; i++) {
      const file = i === 0 ? this.file : `${this.file}.${i}`
      let text: string
      try { text = readFileSync(file, 'utf8') } catch { break }
      const got = text.split('\n')
      if (got.at(-1) === '') got.pop()
      lines.unshift(...got.slice(-(n - lines.length)))
    }
    return lines.map((l) => this.redact(l))
  }

  redact(text: string) { return redact(text, this.o) }

  /** console.error and console.warn still print, and land here too. Returns the undo. */
  captureConsole(): () => void {
    console.error = (...a: unknown[]) => { original.error(...a); this.write('error', a) }
    console.warn = (...a: unknown[]) => { original.warn(...a); this.write('warn', a) }
    return () => { console.error = original.error; console.warn = original.warn }
  }

  private rotate() {
    rmSync(`${this.file}.${this.files - 1}`, { force: true })
    for (let i = this.files - 2; i >= 1; i--) if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`)
    renameSync(this.file, `${this.file}.1`)
    this.size = 0
  }
}

export interface DiagnosticsInfo {
  app: string
  macos: string
  arch: string
  electron: string
  hookPort?: number
  log?: Log
  /** For tests: a stubbed command runner and the session binary's path. */
  run?: typeof exec
  claude?: string | null
}

/**
 * The text Help, Copy diagnostics puts on the clipboard (KERNEL-288): versions, the hook port and the last 200 log lines,
 * redacted. The Claude Code version is the copy agents run, the same one the checks look at.
 */
export async function diagnostics(o: DiagnosticsInfo & RedactOptions): Promise<string> {
  const run = o.run ?? exec
  const bin = o.claude === undefined ? sessionClaude() : o.claude
  const [claude, gh] = await Promise.all([
    bin ? run(bin, ['--version'], { timeoutMs: 15000 }).then((r) => (r.code === 0 ? parseClaudeVersion(r.stdout) : null), () => null) : null,
    run('gh', ['--version'], { timeoutMs: 10000 }).then((r) => (r.code === 0 ? /gh version (\d+\.\d+(?:\.\d+)?)/.exec(r.stdout)?.[1] ?? null : null), () => null)
  ])
  const lines = o.log?.tail(200)
  const text = [
    'Kernel diagnostics',
    `Kernel ${o.app}`,
    `macOS ${o.macos} (${o.arch})`,
    `Electron ${o.electron}`,
    `Claude Code ${claude ? `v${claude}` : 'not found'}`,
    `GitHub CLI ${gh ? `v${gh}` : 'not found'}`,
    `Hook port ${o.hookPort ?? 'unknown'}`,
    '',
    o.log ? `Last ${lines!.length} lines of ${o.log.file}` : 'The log is off in this run.',
    ...(lines ?? [])
  ].join('\n')
  return redact(text, o) + '\n'
}
