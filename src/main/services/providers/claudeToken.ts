import * as pty from 'node-pty'

// Claude's sign-in in a pty (KERNEL-406, KERNEL-567): `claude auth login` in an account's folder, its sign-in link and code
// prompt passed on. The CLI draws with Ink, which wraps text at the terminal's width and leaves out what doesn't fit, so a
// narrow terminal splits the link. Accounts added before KERNEL-567 still run on the `claude setup-token` token they kept,
// until Sign in again moves them to a full login.

/** Wide enough that the sign-in link fits on one line. */
export const TOKEN_COLS = 1000

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

/** The CLI's own word for a finished login. */
const LOGGED_IN = /Login successful/i

/** Why a login failed, in the CLI's words: its last line of output, when it said anything. */
function failure(out: string): string {
  const last = plainText(out).split(/\r\n|\n|\r/).map((l) => l.trim()).filter(Boolean).at(-1)
  return last && !asksForCode(last) ? `Claude Code said: ${last}` : 'Claude Code stopped before the sign-in finished.'
}

export interface ClaudeLoginRun {
  /** Resolves once the CLI says "Login successful." and exits 0. Rejects when it ends any other way, on Cancel, or after `timeoutMs`. */
  done: Promise<void>
  /** Types the code from the sign-in page into the CLI's prompt. */
  sendCode(code: string): void
  cancel(): void
}

/**
 * Runs `bin auth login` in a pty `TOKEN_COLS` wide, with `env` carrying the account's CLAUDE_CONFIG_DIR (KERNEL-567). The
 * CLI opens its sign-in in the browser. `onLink` gets the page, and `onCode` fires once when the CLI shows its code
 * prompt, which it does from the start.
 */
export function loginClaude(bin: string, o: { env: Record<string, string>; cwd: string; timeoutMs: number; onLink?: (url: string) => void; onCode?: () => void }): ClaudeLoginRun {
  const proc = pty.spawn(bin, ['auth', 'login'], { name: 'xterm-256color', cols: TOKEN_COLS, rows: 50, cwd: o.cwd, env: { ...o.env, TERM: 'xterm-256color' } })
  let out = ''
  let link: string | undefined
  let asked = false
  let settle: { resolve: () => void; reject: (e: Error) => void } | undefined
  const done = new Promise<void>((resolve, reject) => { settle = { resolve, reject } })
  const end = (error?: string) => {
    if (!settle) return
    const s = settle
    settle = undefined
    clearTimeout(timer)
    try { proc.kill() } catch { /* already gone */ }
    if (error) s.reject(new Error(error))
    else s.resolve()
  }
  const timer = setTimeout(() => end('Sign-in took too long, so Kernel stopped waiting.'), o.timeoutMs)
  timer.unref?.()
  proc.onData((data) => {
    out = (out + data).slice(-200_000)
    const url = signInLink(out)
    if (url && url !== link) { link = url; o.onLink?.(url) }
    if (!asked && asksForCode(out)) { asked = true; o.onCode?.() }
  })
  proc.onExit(({ exitCode }) => end(exitCode === 0 && LOGGED_IN.test(plainText(out)) ? undefined : failure(out)))
  return {
    done,
    sendCode: (code) => { if (settle) proc.write(`${code.trim()}\r`) },
    cancel: () => end('Sign-in canceled.')
  }
}
