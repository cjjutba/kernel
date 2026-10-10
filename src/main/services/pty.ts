import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { bus } from '../bus'

export interface PtyOptions {
  cwd: string
  env: Record<string, string>
  /** Typed into the shell once it starts, for example `claude`. */
  command?: string
  cols?: number
  rows?: number
}

/** The user's login shell, falling back to zsh. */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SHELL
  return s && existsSync(s) ? s : '/bin/zsh'
}

/**
 * Real terminals for the big terminal tab and the bottom panel's Terminal tab. One pty per id:
 * a chat id for a big terminal, `shell:<workspaceId>` for the plain shell. Output goes out as `terminal.data`.
 */
export class Ptys {
  private procs = new Map<string, pty.IPty>()

  has(id: string) { return this.procs.has(id) }

  start(id: string, o: PtyOptions) {
    if (this.procs.has(id)) return
    const env = { ...o.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    // The Mac's SHELL picks the binary, so a SHELL from a room's variables or env files can't (KERNEL-247).
    const proc = pty.spawn(loginShell(process.env), ['-l'], { name: 'xterm-256color', cwd: o.cwd, env, cols: o.cols ?? 100, rows: o.rows ?? 30 })
    this.procs.set(id, proc)
    proc.onData((data) => bus.push({ type: 'terminal.data', chatId: id, data }))
    proc.onExit(({ exitCode }) => {
      // A replaced pty (killed, then started again under the same id) must not drop its successor.
      if (this.procs.get(id) !== proc) return
      this.procs.delete(id)
      bus.push({ type: 'terminal.data', chatId: id, data: `\r\n[process exited with code ${exitCode}]\r\n` })
    })
    if (o.command) proc.write(`${o.command}\r`)
  }

  write(id: string, data: string) { this.procs.get(id)?.write(data) }

  resize(id: string, cols: number, rows: number) {
    if (cols < 2 || rows < 1) return
    try { this.procs.get(id)?.resize(Math.floor(cols), Math.floor(rows)) } catch { /* the process is already gone */ }
  }

  kill(id: string) {
    const proc = this.procs.get(id)
    if (!proc) return
    this.procs.delete(id)
    try { proc.kill() } catch { /* already gone */ }
  }

  /** Every pty whose id is in `ids`, plus the workspace's plain shell. */
  killWorkspace(workspaceId: string, chatIds: string[]) {
    for (const id of [...chatIds, shellId(workspaceId)]) this.kill(id)
  }

  killAll() { for (const id of [...this.procs.keys()]) this.kill(id) }
}

export const shellId = (workspaceId: string) => `shell:${workspaceId}`
