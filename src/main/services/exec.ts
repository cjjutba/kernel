import { spawn } from 'node:child_process'

/** `timedOut` is set when `timeoutMs` ran out and Kernel killed the command. */
export interface ExecResult { code: number; stdout: string; stderr: string; timedOut?: boolean }

/** Run a command without a shell. Never throws on a non-zero exit; callers decide. */
export function exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, opts.timeoutMs) : undefined
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr + String(err) }) })
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr, ...(timedOut ? { timedOut } : {}) }) })
    if (opts.input) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

/** Like exec, but throws with stderr when the command fails. */
export async function run(cmd: string, args: string[], opts: Parameters<typeof exec>[2] = {}): Promise<string> {
  const r = await exec(cmd, args, opts)
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
  return r.stdout
}

export const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args])
