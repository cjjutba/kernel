import { spawn } from 'node:child_process'

/** `timedOut` is set when `timeoutMs` ran out and Kernel killed the command. */
export interface ExecResult { code: number; stdout: string; stderr: string; timedOut?: boolean }

/** How long a command runs when its caller doesn't say, so a hung `git` or `gh` can't wait forever (KERNEL-216). */
export const EXEC_TIMEOUT_MS = 60_000
/** For git work that grows with the repo or the network: checking out a worktree, pushing (and its hooks), hashing every file. */
export const SLOW_MS = 10 * 60_000
/** How long a command that ran out of time gets to exit on SIGTERM before its process group gets SIGKILL. */
export const KILL_GRACE_MS = 5_000
/** The most bytes kept of a command's stdout, and of its stderr. The rest is read and dropped. */
export const MAX_OUTPUT = 10 * 1024 * 1024

/**
 * Nothing Kernel starts can answer a credential prompt, so git fails at once instead of waiting for one: no terminal prompt,
 * and no Git Credential Manager window. Applied last, over the caller's variables (KERNEL-460).
 */
export const NO_PROMPTS = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } as const

/** A stream's first `MAX_OUTPUT` bytes, read as UTF-8 once it ends, so a character split across two chunks stays whole. */
function capped() {
  const chunks: Buffer[] = []
  let size = 0
  return {
    add: (d: Buffer) => { if (size < MAX_OUTPUT) { chunks.push(d.subarray(0, MAX_OUTPUT - size)); size += d.length } },
    text: () => Buffer.concat(chunks).toString('utf8')
  }
}

/**
 * Run a command without a shell. Never throws on a non-zero exit; callers decide. The command gets its own process group,
 * so when its time runs out the processes it started, such as a git hook or gh's pager, stop with it. It never prompts for
 * a git login (`NO_PROMPTS`).
 */
export function exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; graceMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env, ...NO_PROMPTS }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const out = capped(), err = capped()
    let timedOut = false
    let force: NodeJS.Timeout | undefined
    const signal = (s: NodeJS.Signals) => { try { process.kill(-child.pid!, s) } catch { child.kill(s) } }
    const timer = setTimeout(() => {
      timedOut = true
      signal('SIGTERM')
      force = setTimeout(() => signal('SIGKILL'), opts.graceMs ?? KILL_GRACE_MS)
    }, opts.timeoutMs ?? EXEC_TIMEOUT_MS)
    const done = () => { clearTimeout(timer); clearTimeout(force) }
    child.stdout.on('data', out.add)
    child.stderr.on('data', err.add)
    child.on('error', (e) => { done(); resolve({ code: 127, stdout: out.text(), stderr: err.text() + String(e) }) })
    child.on('close', (code) => { done(); resolve({ code: code ?? 1, stdout: out.text(), stderr: err.text(), ...(timedOut ? { timedOut } : {}) }) })
    // A command that exits before reading its input closes the pipe, and writing to it then fails.
    child.stdin.on('error', () => undefined)
    if (opts.input) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

/** Throws for a command that timed out or failed, with its stderr, else returns the result. */
function succeeded(cmd: string, args: string[], opts: NonNullable<Parameters<typeof exec>[2]>, r: ExecResult): ExecResult {
  if (r.timedOut) {
    const s = Math.max(1, Math.round((opts.timeoutMs ?? EXEC_TIMEOUT_MS) / 1000))
    throw new Error(`${cmd} ${args.join(' ')} didn't finish in ${s} second${s === 1 ? '' : 's'}`)
  }
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
  return r
}

/** Like exec, but throws with stderr when the command fails. */
export async function run(cmd: string, args: string[], opts: Parameters<typeof exec>[2] = {}): Promise<string> {
  return succeeded(cmd, args, opts, await exec(cmd, args, opts)).stdout
}

/** Like `run`, but returns what the command printed on stdout and stderr together, for a log (KERNEL-1117). */
export async function runLogged(cmd: string, args: string[], opts: Parameters<typeof exec>[2] = {}): Promise<string> {
  const r = succeeded(cmd, args, opts, await exec(cmd, args, opts))
  return [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n')
}

export const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args])
/** `git` with `SLOW_MS` to finish, for a worktree checkout, a push or a commit of every file. */
export const gitSlow = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args], { timeoutMs: SLOW_MS })
