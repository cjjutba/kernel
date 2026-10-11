import * as pty from 'node-pty'

// Add account for Claude (KERNEL-406): `claude setup-token` in a pty, its sign-in link and code prompt passed on, and the
// token it prints picked out of the output. The CLI draws with Ink, which wraps text at the terminal's width and leaves out
// what doesn't fit, so a narrow terminal splits the token over two lines or doesn't show it at all.

/** Wide enough that the token and the sign-in link each fit on one line. */
export const TOKEN_COLS = 1000

/** A `setup-token` token: about 108 characters. Anything much shorter or longer is a piece of one, or something else. */
const TOKEN_PREFIX = 'sk-ant-oat01-'
const TOKEN_LENGTH = { min: 100, max: 116 }
const TOKEN_CHARS = /^[A-Za-z0-9_-]*/

export const isClaudeToken = (t: string) => t.startsWith(TOKEN_PREFIX) && t.length >= TOKEN_LENGTH.min && t.length <= TOKEN_LENGTH.max && TOKEN_CHARS.exec(t)![0] === t

/** The output as text: no colors, cursor moves or hyperlinks. */
export function plainText(out: string): string {
  return out
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
}

/** The sign-in page: the hyperlink the CLI wraps it in, else the URL in the text. */
export function signInLink(out: string): string | undefined {
  const linked = /\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/.exec(out)?.[1]
  return linked ?? /https:\/\/\S+oauth\S*/.exec(plainText(out))?.[0]
}

/** The CLI asks for the code its sign-in page shows, for when the browser can't reach its local listener. */
export const asksForCode = (out: string) => /Paste code here/i.test(plainText(out))

/**
 * The token in the output, or undefined. A token cut at the end of a line goes on at the start of the next while it is
 * still short, which joins one the terminal wrapped. Only a whole token of about 108 characters counts. While the CLI runs
 * (`done` false) the last line may still be arriving, so only finished lines are read.
 */
export function tokenFrom(out: string, o: { done?: boolean } = {}): string | undefined {
  const lines = plainText(out).split(/\r\n|\n|\r/)
  if (!o.done) lines.pop()
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf(TOKEN_PREFIX)
    if (at < 0) continue
    const rest = lines[i].slice(at)
    let token = TOKEN_CHARS.exec(rest)![0]
    let ranToEnd = rest.slice(token.length).trim() === ''
    for (let j = i + 1; ranToEnd && token.length < TOKEN_LENGTH.min && j < lines.length; j++) {
      const next = lines[j].trim()
      const piece = TOKEN_CHARS.exec(next)![0]
      if (!piece) break
      token += piece
      ranToEnd = piece === next
    }
    if (isClaudeToken(token)) return token
  }
  return undefined
}

export interface TokenCapture {
  /** The token, once the CLI printed it. Rejects when the CLI ends without one, on Cancel, or after `timeoutMs`. */
  token: Promise<string>
  /** Types the code from the sign-in page into the CLI's prompt. */
  sendCode(code: string): void
  cancel(): void
}

/**
 * Runs `bin setup-token` in a pty `TOKEN_COLS` wide. `onLink` gets the sign-in page the CLI opened in the browser, and
 * `onCode` fires once if the CLI asks for the code that page shows.
 */
export function captureClaudeToken(bin: string, o: { env: Record<string, string>; cwd: string; timeoutMs: number; onLink?: (url: string) => void; onCode?: () => void }): TokenCapture {
  const proc = pty.spawn(bin, ['setup-token'], { name: 'xterm-256color', cols: TOKEN_COLS, rows: 50, cwd: o.cwd, env: { ...o.env, TERM: 'xterm-256color' } })
  let out = ''
  let link: string | undefined
  let asked = false
  let settle: { resolve: (t: string) => void; reject: (e: Error) => void } | undefined
  const token = new Promise<string>((resolve, reject) => { settle = { resolve, reject } })
  const end = (r: { token: string } | { error: string }) => {
    if (!settle) return
    const s = settle
    settle = undefined
    clearTimeout(timer)
    try { proc.kill() } catch { /* already gone */ }
    if ('token' in r) s.resolve(r.token)
    else s.reject(new Error(r.error))
  }
  const timer = setTimeout(() => end({ error: 'Sign-in took too long, so Kernel stopped waiting.' }), o.timeoutMs)
  timer.unref?.()
  proc.onData((data) => {
    out = (out + data).slice(-200_000)
    const found = tokenFrom(out)
    if (found) return end({ token: found })
    const url = signInLink(out)
    if (url && url !== link) { link = url; o.onLink?.(url) }
    if (!asked && asksForCode(out)) { asked = true; o.onCode?.() }
  })
  proc.onExit(() => {
    const found = tokenFrom(out, { done: true })
    end(found ? { token: found } : { error: "Kernel couldn't read a token from claude setup-token." })
  })
  return {
    token,
    sendCode: (code) => { if (settle) proc.write(`${code.trim()}\r`) },
    cancel: () => end({ error: 'Sign-in canceled.' })
  }
}
