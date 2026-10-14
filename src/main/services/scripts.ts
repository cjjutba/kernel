import * as pty from 'node-pty'
import { appendFile, copyFile, lstat, mkdir, realpath, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { bus } from '../bus'
import { exec, git } from './exec'
import { Batcher } from './batch'
import { resolveCopySources, within } from './filesToCopy'
import type { Readable } from 'node:stream'
import { PORT_BLOCK, type ScriptLine } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { localUrlIn } from '@shared/previewUrl'
import { keepData, keepLines, SCRIPT_COLS, SCRIPT_ROWS, scriptKey } from '@shared/scriptLog'

const canBind = (p: number) => new Promise<boolean>((res) => {
  const srv = createServer()
  srv.once('error', () => res(false))
  srv.listen(p, '127.0.0.1', () => srv.close(() => res(true)))
})

/** Ports in the block range that browsers refuse to load (SIP), so a preview on one could never open (KERNEL-830). */
export const BROWSER_BLOCKED_PORTS = [5060, 5061]

/**
 * The first port of each block a workspace can get: 4300, 4310 and so on to 5990, short of 6000, which browsers refuse, and
 * well below the hook ports. A block holding a port browsers refuse is left out (KERNEL-244, KERNEL-830).
 */
export const BLOCK_STARTS = Array.from({ length: (5990 - 4300) / PORT_BLOCK + 1 }, (_, i) => 4300 + i * PORT_BLOCK)
  .filter((start) => !BROWSER_BLOCKED_PORTS.some((p) => p >= start && p < start + PORT_BLOCK))

/** Every block is taken or has a port in use. `withPort` turns it into a message the user can act on (KERNEL-830). */
export class NoFreePortBlock extends Error {
  constructor() { super(`No free block of ports between ${BLOCK_STARTS[0]} and ${BLOCK_STARTS.at(-1)! + PORT_BLOCK - 1}`) }
}

/** Whether the blocks starting at `a` and `b` share a port. A legacy port that isn't a multiple of 10 still has a whole block. */
export const blocksOverlap = (a: number, b: number) => Math.abs(a - b) < PORT_BLOCK

/**
 * A free block of `PORT_BLOCK` ports for a workspace, as its first port ($KERNEL_PORT). `taken` is read again for each candidate,
 * and the port goes in `reserved` before the bind check awaits, so two calls in one turn never get the same block. The caller
 * drops it from `reserved` once the workspace that holds it is saved. Throws `NoFreePortBlock` when every block is taken.
 */
export async function portBlock(taken: () => number[], reserved: Set<number>): Promise<number> {
  for (const start of BLOCK_STARTS) {
    if ([...taken(), ...reserved].some((p) => blocksOverlap(p, start))) continue
    reserved.add(start)
    let free = true
    for (let p = start; p < start + PORT_BLOCK && free; p++) free = await canBind(p)
    if (free) return start
    reserved.delete(start)
  }
  throw new NoFreePortBlock()
}

/**
 * Would writing `to` land outside the worktree? True when `to` is a symlink, or a folder on its way is one that points
 * out: a repo can commit either, and the copy would follow it. Checked before any folder is made (KERNEL-209).
 */
async function leavesWorktree(worktreeRoot: string, to: string): Promise<boolean> {
  if (await lstat(to).then((s) => s.isSymbolicLink(), () => false)) return true
  let dir = dirname(to)
  while (!(await lstat(dir).then(() => true, () => false))) dir = dirname(dir)
  return !within(worktreeRoot, await realpath(dir))
}

/**
 * Copy gitignored files (like .env.local) from the main checkout into a fresh worktree. `entries` are exact paths and
 * patterns (KERNEL-245), resolved by `resolveFilesToCopy`, which keeps every file inside the repo once symlinks are
 * followed and names the entries it refused. Each copy must also land inside the worktree, so a symlink the worktree
 * checked out can't carry it out (KERNEL-209). A file `exclude` names stays behind (KERNEL-449). A worktree an archive
 * already removed gets nothing.
 */
export async function copyLocalFiles(repo: string, worktree: string, entries: string[], exclude: string[] = []): Promise<{ copied: string[]; refused: string[] }> {
  const copied: string[] = [], refused: string[] = []
  const worktreeRoot = await realpath(worktree).catch(() => undefined)
  if (!worktreeRoot) return { copied, refused }
  for (const { path, from } of await resolveCopySources(repo, entries, refused, exclude)) {
    const to = join(worktree, path)
    try {
      if (await leavesWorktree(worktreeRoot, to)) { refused.push(path); continue }
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
      copied.push(path)
    } catch { /* a file that went away is fine */ }
  }
  return { copied, refused }
}

/** Link the main checkout's node_modules into a fresh worktree. Skips when either side is missing or the worktree already has one. */
export async function linkNodeModules(repo: string, worktree: string): Promise<boolean> {
  const target = join(repo, 'node_modules')
  const link = join(worktree, 'node_modules')
  if (!existsSync(target)) return false
  if (await lstat(link).then(() => true, () => false)) return false
  await symlink(target, link, 'dir')
  // Git sees the link as a file, so a `node_modules/` line in .gitignore misses it. Exclude it locally instead.
  if ((await exec('git', ['-C', worktree, 'check-ignore', '-q', 'node_modules'])).code !== 0) {
    const exclude = resolve(worktree, (await git(worktree, 'rev-parse', '--git-path', 'info/exclude')).trim())
    await mkdir(dirname(exclude), { recursive: true })
    await appendFile(exclude, '/node_modules\n')
  }
  return true
}

/** The user's login shell so nvm, pnpm and PATH tweaks apply. Falls back to sh. */
export function loginShell(): string {
  if (process.env.SHELL && existsSync(process.env.SHELL)) return process.env.SHELL
  return existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh'
}

/** The most characters a line can hold before it is cut and shown. A spinner writes `\r` and never a newline (KERNEL-246). */
export const MAX_LINE = 64 * 1024

/**
 * Calls `onLine` with each whole line of the text `add` is given, however the chunks split it. A line longer than
 * `MAX_LINE` characters goes out in pieces of `MAX_LINE`, never splitting an emoji. `flush` hands over a last line with no
 * newline, for when the process closes.
 */
export function lineSplitter(onLine: (line: string) => void): { add: (d: string) => void; flush: () => void } {
  let buf = ''
  return {
    add: (d) => {
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop()!
      for (const line of lines) onLine(line)
      while (buf.length >= MAX_LINE) {
        // A high surrogate at the cut would leave half an emoji on each side.
        const cut = /[\uD800-\uDBFF]/.test(buf[MAX_LINE - 1]) ? MAX_LINE - 1 : MAX_LINE
        onLine(buf.slice(0, cut))
        buf = buf.slice(cut)
      }
    },
    flush: () => { if (buf) onLine(buf); buf = '' }
  }
}

/** `lineSplitter` on a stream, and a character split across two chunks stays whole. Returns the flush. */
export function pipeLines(stream: Readable | null, onLine: (line: string) => void): () => void {
  const lines = lineSplitter(onLine)
  stream?.setEncoding('utf8')
  stream?.on('data', lines.add)
  return lines.flush
}

/** Escape sequences a terminal reads: CSI (colors, cursor moves), OSC (titles, links) and the two-character ones. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]/g

/**
 * A line of terminal output as plain text: no escape sequences, and only what the last `\r` redraw left, the way a
 * spinner or progress bar ends up on screen (KERNEL-655).
 */
export function plainLine(line: string): string {
  const text = line.replace(ESCAPES, '').replace(/\r+$/, '')
  return text.slice(text.lastIndexOf('\r') + 1).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

type Kind = 'setup' | 'run' | 'archive'
/** Every script still running, by workspace, kind and run script name. Setup and archive have no name. */
const running = new Map<string, { workspaceId: string; kind: Kind; name?: string; proc: pty.IPty }>()
/** Run scripts a restart stopped to start the same script again. Their log goes on as the new run's, so they get no closing line (KERNEL-679). */
const restarted = new WeakSet<pty.IPty>()
/** The size each script's view last asked for, by `key`, so a script run again starts at it (KERNEL-655). */
const sizes = new Map<string, { cols: number; rows: number }>()
const key = (workspaceId: string, kind: Kind, name?: string) => JSON.stringify([workspaceId, kind, name ?? null])
/** A run script is named, `run` when none is given. Setup and archive aren't. */
const nameOf = (kind: Kind, name?: string) => (kind === 'run' ? name ?? 'run' : undefined)

/**
 * Each workspace's scripts as the window was told: their lines, trimmed as the window trims them, the exit code of each
 * script that stopped, the URL of each run script still running and each script's terminal output by `scriptKey`. A window
 * that reloads or reopens gets them back from `replayScripts`, since they only ever went out as pushes (KERNEL-340).
 */
const kept = new Map<string, { lines: ScriptLine[]; exit: Record<string, number | null>; url: Record<string, string>; data: Record<string, string> }>()
/** Archived workspaces. Their scripts' last lines and exits come after the archive and aren't kept. */
const archived = new Set<string>()

/**
 * Keeps a pushed script event, whoever pushed it: Kernel adds setup and archive lines of its own. Kernel's push listener
 * calls it for every push. An archived workspace's record goes, and a restored one keeps lines again.
 */
export function keepScript(e: PushEvent) {
  if (e.type === 'workspace') {
    if (e.workspace.status !== 'archived') archived.delete(e.workspace.id)
    else { archived.add(e.workspace.id); kept.delete(e.workspace.id) }
    return
  }
  if ((e.type !== 'script.output' && e.type !== 'script.data' && e.type !== 'script.exit' && e.type !== 'script.url') || archived.has(e.workspaceId)) return
  let k = kept.get(e.workspaceId)
  if (!k) kept.set(e.workspaceId, (k = { lines: [], exit: {}, url: {}, data: {} }))
  if (e.type === 'script.output') k.lines = keepLines(k.lines, e.kind, e.name, e.lines)
  else if (e.type === 'script.data') k.data[scriptKey(e.kind, e.name)] = keepData(k.data[scriptKey(e.kind, e.name)], e.data)
  else if (e.type === 'script.exit') k.exit[scriptKey(e.kind, e.name)] = e.code
  else if (e.url) k.url[e.name] = e.url
  else delete k.url[e.name]
}

/** Pushes everything kept for the workspace's scripts as one `script.state`, which takes the place of what the window has. */
export function replayScripts(workspaceId: string) {
  const k = kept.get(workspaceId)
  // What waits to go out is pushed first, so the state holds it and nothing comes after it twice.
  for (const r of running.values()) if (r.workspaceId === workspaceId) flushScript(key(workspaceId, r.kind, r.name))
  bus.push({ type: 'script.state', workspaceId, lines: k?.lines ?? [], exit: { ...k?.exit }, url: { ...k?.url }, data: { ...k?.data } })
}

/**
 * Each script's lines from the last 50 ms, pushed as one `script.output`, so `pnpm install` doesn't send the window a
 * message per line (KERNEL-216). Keyed by `key`.
 */
const tagOf = (k: string) => {
  const [workspaceId, kind, name] = JSON.parse(k) as [string, Kind, string | null]
  return { workspaceId, kind, ...(name ? { name } : {}) }
}
const output = new Batcher<{ line: string; stream: 'stdout' | 'stderr' }>((k, lines) => bus.push({ type: 'script.output', ...tagOf(k), lines }))
/** Each script's terminal output from the last 50 ms, pushed as one `script.data`, the way `terminal.data` goes (KERNEL-655). */
const data = new Batcher<string>((k, chunks) => bus.push({ type: 'script.data', ...tagOf(k), data: chunks.join('') }))
/** Both, raw output first, so a view of either has everything printed before what comes next. */
const flushScript = (k: string) => { data.flush(k); output.flush(k) }

/**
 * A line of Kernel's own in a script's log, like "Setup failed with exit code 1": a plain line in `script.output` and a
 * line in its terminal output, after whatever the script printed (KERNEL-655). `name` is the run script's, for a line in
 * a run script's log (KERNEL-679).
 */
export function scriptNote(workspaceId: string, kind: Kind, line: string, stream: 'stdout' | 'stderr' = 'stderr', name?: string) {
  const named = nameOf(kind, name)
  flushScript(key(workspaceId, kind, named))
  const tag = { workspaceId, kind, ...(named ? { name: named } : {}) }
  bus.push({ type: 'script.data', ...tag, data: `${line}\r\n` })
  bus.push({ type: 'script.output', ...tag, lines: [{ line, stream }] })
}

/** How long a setup or archive script may run, from Settings > Scripts. Run scripts are servers and have no limit (KERNEL-216). */
export const scriptTimeout = (s: { scripts: { timeoutMinutes: number } }) => s.scripts.timeoutMinutes * 60_000
/** That limit as the log says it: "15 minutes". */
export const timeoutText = (s: { scripts: { timeoutMinutes: number } }) => `${s.scripts.timeoutMinutes} minute${s.scripts.timeoutMinutes === 1 ? '' : 's'}`

/** How a script ended: its exit code, null when it was stopped, or `timeout` when it ran past `timeoutMs` and Kernel stopped it. */
export type ScriptEnd = number | null | 'timeout'

/**
 * How a script ended, from what its terminal reported: a timeout wins, then a stop or signal (null), then the exit code.
 * A shell a signal ended has no exit code, as a stopped script had none before. On Linux node-pty reports SIGHUP, with
 * exit code 0, for a short script that finished before its terminal closed. Kernel stops scripts with SIGTERM and
 * SIGKILL, so a hangup on a script nobody stopped is a normal end, not a stop.
 */
export function scriptEndOf(e: { exitCode: number; signal?: number; stopped: boolean; timedOut: boolean }): ScriptEnd {
  if (e.timedOut) return 'timeout'
  const hungUp = e.signal === 1 && e.exitCode === 0 && !e.stopped
  return e.signal && !hungUp ? null : e.exitCode
}

/**
 * Run a workspace script in a login shell, in a terminal of its own, so it prints colors and redraws its progress as it
 * would in the user's terminal (KERNEL-655). Its output goes out twice: as it printed it in `script.data`, and as plain
 * lines in `script.output`, which the URL check reads. Resolves with the exit code. `env` is the whole environment, from
 * `Kernel.envFor` (KERNEL-247). Its stdin is /dev/null, so a script that asks a question gets no answer instead of
 * waiting for one, and `timeoutMs` stops its process group once that long has passed (KERNEL-216).
 */
export function runScript(o: { workspaceId: string; kind: Kind; name?: string; script: string; cwd: string; env: Record<string, string>; timeoutMs?: number }): Promise<ScriptEnd> {
  const name = nameOf(o.kind, o.name)
  const k = key(o.workspaceId, o.kind, name)
  const before = running.get(k)?.proc
  if (before) restarted.add(before)
  stopScript(o.workspaceId, o.kind, name)
  const tag = { workspaceId: o.workspaceId, kind: o.kind, ...(name ? { name } : {}) }
  // Settings read from a repo are checked as text before they get here; anything else never reaches the shell (KERNEL-209).
  if (typeof o.script !== 'string') return Promise.resolve(null)
  return new Promise((resolve) => {
    const header = `$ ${o.script.split('\n').join(' && ')}`
    output.add(k, { line: header, stream: 'stdout' })
    data.add(k, `${header}\r\n`)
    let proc: pty.IPty
    try {
      // The terminal's stdin is the script's, and nothing types into it. /dev/null ends every read at once, where an EOF
      // typed in would echo `^D` and end only the first.
      proc = pty.spawn(loginShell(), ['-lc', `exec </dev/null; ${o.script}`], {
        name: 'xterm-256color', cwd: o.cwd, env: { ...o.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, ...(sizes.get(k) ?? { cols: SCRIPT_COLS, rows: SCRIPT_ROWS })
      })
    } catch (err) {
      output.add(k, { line: String(err), stream: 'stderr' })
      data.add(k, `${String(err)}\r\n`)
      flushScript(k)
      bus.push({ type: 'script.exit', ...tag, code: null })
      return resolve(null)
    }
    running.set(k, { workspaceId: o.workspaceId, kind: o.kind, name, proc })
    // Running again, so the last run's exit code no longer says it stopped.
    delete kept.get(o.workspaceId)?.exit[scriptKey(o.kind, name)]
    const current = () => running.get(k)?.proc === proc
    // A run script's URL starts empty. The first local URL it prints is its URL until it exits (KERNEL-246).
    let url: string | null = null
    if (name) bus.push({ type: 'script.url', workspaceId: o.workspaceId, name, url })
    const lines = lineSplitter((raw) => {
      const line = plainLine(raw)
      if (!line) return
      output.add(k, { line, stream: 'stdout' })
      // A process a restart replaced may still be printing. Its URL isn't the new run's.
      if (name && !url && current()) {
        url = localUrlIn(line)
        // The URL goes out right after the line that printed it.
        if (url) { flushScript(k); bus.push({ type: 'script.url', workspaceId: o.workspaceId, name, url }) }
      }
    })
    proc.onData((d) => { data.add(k, d); lines.add(d) })
    let timedOut = false
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; killGroup(proc) }, o.timeoutMs) : undefined
    proc.onExit(({ exitCode, signal }) => {
      clearTimeout(timer)
      lines.flush()
      // Everything before the exit, so the window has the whole log when it reads the code.
      flushScript(k)
      // A restart already holds the slot with the new process, and its URL.
      const replaced = running.has(k) && !current()
      // Stop took the script out of `running` before it signalled it. One still there ended by itself.
      const stopped = !current()
      if (current()) running.delete(k)
      // The event carries what the terminal reported even after a timeout. Only the promise says `timeout`.
      const code = scriptEndOf({ exitCode, signal, stopped, timedOut: false }) as number | null
      // A run script says how it ended, so a server that quit doesn't look like a button that did nothing (KERNEL-679).
      if (name && !restarted.has(proc)) {
        if (stopped || code === null) scriptNote(o.workspaceId, 'run', 'Run script was stopped', 'stdout', name)
        else if (code === 0) scriptNote(o.workspaceId, 'run', 'Run script ended', 'stdout', name)
        else scriptNote(o.workspaceId, 'run', `Run script exited with code ${code}`, 'stderr', name)
      }
      if (name && !replaced) bus.push({ type: 'script.url', workspaceId: o.workspaceId, name, url: null })
      bus.push({ type: 'script.exit', ...tag, code })
      resolve(scriptEndOf({ exitCode, signal, stopped, timedOut }))
    })
  })
}

/** Resizes a running script's terminal, and the next run of it starts at that size (KERNEL-655). */
export function resizeScript(workspaceId: string, kind: Kind, name: string | undefined, cols: number, rows: number) {
  if (!(cols >= 2 && rows >= 1)) return
  const k = key(workspaceId, kind, nameOf(kind, name))
  const size = { cols: Math.floor(cols), rows: Math.floor(rows) }
  sizes.set(k, size)
  try { running.get(k)?.proc.resize(size.cols, size.rows) } catch { /* the process is already gone */ }
}

/** How long a stopped script's processes get to exit on SIGTERM before they get SIGKILL. */
const STOP_GRACE_MS = 3000

/** Kill the whole process group so dev servers started by the script die too. A run script without a name is `run`. */
export function stopScript(workspaceId: string, kind: Kind, name?: string, o: { now?: boolean } = {}) {
  const k = key(workspaceId, kind, nameOf(kind, name))
  const proc = running.get(k)?.proc
  if (proc && o.now) {
    // Kernel is quitting and no timer would outlive it, so the group dies now.
    try { process.kill(-proc.pid, 'SIGKILL') } catch { proc.kill('SIGKILL') }
  } else if (proc) killGroup(proc)
  running.delete(k)
}

/**
 * SIGTERM to the script's process group, and SIGKILL to whatever is left of it `STOP_GRACE_MS` later. A server that
 * ignores SIGTERM, or a command the shell forked just as the signal came, would keep running. The terminal gives the
 * script its own session, so its shell leads the group. The SIGKILL goes even when the shell already exited, since a
 * process it started can outlive it in the group.
 */
function killGroup(proc: pty.IPty) {
  const group = -proc.pid
  try { process.kill(group, 'SIGTERM') } catch { proc.kill('SIGTERM') }
  const force = setTimeout(() => { try { process.kill(group, 'SIGKILL') } catch { /* already gone */ } }, STOP_GRACE_MS)
  force.unref()
}

/** The names of the run scripts running in a workspace. */
export const runningRuns = (workspaceId: string): string[] =>
  [...running.values()].filter((r) => r.workspaceId === workspaceId && r.kind === 'run').map((r) => r.name!)

/** Stop every run script in a workspace (KERNEL-244). */
export function stopRuns(workspaceId: string) { for (const name of runningRuns(workspaceId)) stopScript(workspaceId, 'run', name) }

/** On quit: every script's process group gets SIGKILL at once, so a server that ignores SIGTERM doesn't outlive Kernel. */
export function stopAllScripts() { for (const r of [...running.values()]) stopScript(r.workspaceId, r.kind, r.name, { now: true }) }
