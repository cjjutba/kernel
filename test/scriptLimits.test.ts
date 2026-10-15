import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { tempRepo, freePort } from './helpers'
import { Kernel } from '../src/main/kernel'
import { exec, MAX_OUTPUT, run } from '../src/main/services/exec'
import { runScript, scriptEndOf, timeoutText } from '../src/main/services/scripts'
import { Ptys } from '../src/main/services/pty'

// KERNEL-216: commands and scripts can't run forever, and their output reaches the window in batches.

// A plain sh starts fast, as in runScripts.test.ts.
process.env.SHELL = '/bin/sh'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (ok: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) } }

const pushes: PushEvent[] = []
const record = (e: PushEvent) => { if (e.type === 'script.output' || e.type === 'script.exit' || e.type === 'terminal.data') pushes.push(e) }
bus.on('push', record)
const kernels: Kernel[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const k of kernels.splice(0)) await k.stop()
  pushes.length = 0
})

const linesOf = (workspaceId: string) => pushes.flatMap((e) => (e.type === 'script.output' && e.workspaceId === workspaceId ? e.lines.map((l) => l.line) : []))

describe('exec', () => {
  it('stops a command after a minute when the caller gives no limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const done = exec('sleep', ['120'])
    vi.advanceTimersByTime(60_000)
    vi.useRealTimers()
    expect(await done).toMatchObject({ timedOut: true })
  })

  it('kills the whole process group, with SIGKILL when SIGTERM is ignored', async () => {
    const started = Date.now()
    // The shell and the sleep it starts both ignore SIGTERM, so only SIGKILL to the group stops them.
    const r = await exec('sh', ['-c', 'trap "" TERM; sleep 30 & echo $!; wait'], { timeoutMs: 200, graceMs: 300 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
    const pid = Number(r.stdout.trim())
    expect(pid).toBeGreaterThan(0)
    await until(() => !alive(pid), 2_000)
  })

  it('says a command ran out of time when it throws', async () => {
    await expect(run('sleep', ['5'], { timeoutMs: 1_000 })).rejects.toThrow("sleep 5 didn't finish in 1 second")
  })

  it('keeps 10 MB of output and drops the rest', async () => {
    const r = await exec('head', ['-c', String(MAX_OUTPUT + 2_000_000), '/dev/zero'])
    expect(r.code).toBe(0)
    expect(r.stdout.length).toBe(MAX_OUTPUT)
  })
})

describe('setup and archive scripts', () => {
  async function kernelWith(scripts: string, minutes: number) {
    const repo = await tempRepo({ 'README.md': '# demo\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nKai.', '.kernel/settings.toml': scripts })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    kernels.push(k)
    k.sessions.send = async () => ({ queued: false })
    // Below the setting's one minute floor, so the test doesn't wait one.
    k.settings.scripts.timeoutMinutes = minutes
    const project = await k.addProject(repo)
    return { k, project }
  }

  it('has 15 minutes by default', () => {
    expect(timeoutText({ scripts: { timeoutMinutes: 15 } })).toBe('15 minutes')
    expect(timeoutText({ scripts: { timeoutMinutes: 1 } })).toBe('1 minute')
  })

  it('fails a setup that never exits, says why, and leaves none of its processes', async () => {
    const { k, project } = await kernelWith('[scripts]\nsetup = "sleep 600 & echo pid-$!; wait"\n', 0.01)
    const started = Date.now()
    const ws = await k.workspaces.createWorkspace(project.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(ws.status).toBe('failed')
    const lines = linesOf(ws.id)
    expect(lines.at(-1)).toBe("Setup didn't finish in 0.01 minutes")
    expect(k.setup.setupFailures.get(ws.id)).toBe('timeout')
    const pid = Number(lines.find((l) => l.startsWith('pid-'))?.slice(4))
    expect(pid).toBeGreaterThan(0)
    await until(() => !alive(pid), 5_000)
  })

  it('stops an archive script that never exits and archives anyway', async () => {
    const { k, project } = await kernelWith('[scripts]\narchive = "sleep 600"\n', 0.01)
    const ws = await k.workspaces.createWorkspace(project.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })
    await k.archive.archiveWorkspace(ws.id)
    await k.archive.cleanedUp(ws.id)
    expect(k.store.workspace(ws.id)?.status).toBe('archived')
    expect(linesOf(ws.id)).toContain("The archive script didn't finish in 0.01 minutes, so Kernel stopped it.")
  })

  it('closes stdin, so a script that reads it gets nothing instead of waiting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-stdin-'))
    const code = await runScript({ workspaceId: 'w-stdin', kind: 'setup', script: 'read answer; echo "got [$answer]"', cwd: dir, env: process.env as Record<string, string>, timeoutMs: 5_000 })
    expect(code).not.toBe('timeout')
    expect(linesOf('w-stdin')).toContain('got []')
  })
})

describe('batched output', () => {
  it("sends a script's lines in a few pushes, all of them in order, before its exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-batch-'))
    const started = Date.now()
    const code = await runScript({ workspaceId: 'w-batch', kind: 'setup', script: 'i=0; while [ $i -lt 3000 ]; do echo line-$i; i=$((i+1)); done', cwd: dir, env: process.env as Record<string, string> })
    const took = Date.now() - started
    expect(code).toBe(0)
    const mine = pushes.filter((e) => 'workspaceId' in e && e.workspaceId === 'w-batch')
    const outputs = mine.filter((e) => e.type === 'script.output')
    expect(linesOf('w-batch').slice(1)).toEqual(Array.from({ length: 3000 }, (_, i) => `line-${i}`))
    // About one push each 50 ms, and the exit after the last line.
    expect(outputs.length).toBeLessThanOrEqual(Math.ceil(took / 50) + 2)
    expect(mine.at(-1)?.type).toBe('script.exit')
  })

  it('sends a busy terminal about 20 pushes a second, with its output unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-pty-'))
    const ptys = new Ptys()
    try {
      ptys.start('t-batch', { cwd: dir, env: process.env as Record<string, string> })
      await until(() => pushes.length > 0)
      const from = pushes.length
      const started = Date.now()
      // As chatty as `pnpm install`: tens of thousands of short writes.
      ptys.write('t-batch', 'seq 1 40000; echo done-$((20+22))\r')
      const out = () => pushes.slice(from).map((e) => (e.type === 'terminal.data' ? e.data : '')).join('')
      await until(() => out().includes('done-42'), 20_000)
      const took = Date.now() - started
      const sent = pushes.slice(from).filter((e) => e.type === 'terminal.data').length
      expect(sent).toBeLessThanOrEqual(Math.ceil(took / 50) + 2)
      const numbers = out().split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l))
      expect(numbers).toEqual(Array.from({ length: 40000 }, (_, i) => String(i + 1)))
    } finally { ptys.kill('t-batch') }
  })
})

describe('how a script ended', () => {
  const SIGHUP = 1, SIGTERM = 15, SIGKILL = 9
  it('counts a hangup on a script nobody stopped as a normal end (Linux reports one for a script that finished)', () => {
    expect(scriptEndOf({ exitCode: 0, signal: SIGHUP, stopped: false, timedOut: false })).toBe(0)
  })
  it('counts SIGTERM or SIGKILL after a stop as a stop, and a hangup after a stop too', () => {
    for (const signal of [SIGTERM, SIGKILL, SIGHUP]) expect(scriptEndOf({ exitCode: 0, signal, stopped: true, timedOut: false })).toBeNull()
  })
  it('counts a signal nobody asked for as a stop, not a finish', () => {
    for (const signal of [SIGTERM, SIGKILL]) expect(scriptEndOf({ exitCode: 0, signal, stopped: false, timedOut: false })).toBeNull()
  })
  it('keeps a timeout a timeout, whatever the terminal reported', () => {
    for (const signal of [undefined, SIGHUP, SIGTERM, SIGKILL]) expect(scriptEndOf({ exitCode: 0, signal, stopped: false, timedOut: true })).toBe('timeout')
  })
  it('keeps a non-zero exit a failure', () => {
    expect(scriptEndOf({ exitCode: 2, signal: undefined, stopped: false, timedOut: false })).toBe(2)
    expect(scriptEndOf({ exitCode: 1, signal: SIGHUP, stopped: false, timedOut: false })).toBeNull()
  })
})
