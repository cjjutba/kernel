import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freeSlot, isAlive, isGroupAlive, runInSlot, slotCount, takeSlot, waitForSlot } from '../scripts/testSlots.ts'
import { workerCount } from './support/workerCount'

let dir: string
const children: ChildProcess[] = []
// A live pid other than ours, standing in for another teammate's test run.
const otherRun = () => {
  const child = spawn('sleep', ['30'])
  children.push(child)
  return child.pid!
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kernel-slots-'))
})
afterEach(() => {
  for (const c of children.splice(0)) c.kill()
  rmSync(dir, { recursive: true, force: true })
})

describe('test slots', () => {
  it('makes a third run wait while two hold slots, until one frees', async () => {
    const first = takeSlot(dir, 2, otherRun()).file!
    expect(takeSlot(dir, 2, otherRun()).file).toBeDefined()
    expect(takeSlot(dir, 2, otherRun())).toEqual({ busy: 2 })

    const lines: string[] = []
    let got: string | undefined
    const waiting = waitForSlot(dir, 2, { pid: otherRun(), intervalMs: 20, log: (l) => lines.push(l) }).then((f) => (got = f))
    await new Promise((r) => setTimeout(r, 100))
    expect(got).toBeUndefined()
    expect(lines).toEqual(['Waiting for a test slot, 2 runs in progress'])

    rmSync(first)
    expect(await waiting).toBe(first)
    expect(lines).toHaveLength(1)
  })

  it('frees a slot whose run is dead', () => {
    const dead = spawnSync('true').pid
    writeFileSync(join(dir, 'slot-0'), String(dead))
    writeFileSync(join(dir, 'slot-1'), String(otherRun()))
    expect(takeSlot(dir, 2, process.pid).file).toBe(join(dir, 'slot-0'))
    expect(readFileSync(join(dir, 'slot-0'), 'utf8')).toBe(String(process.pid))
  })

  it('leaves a slot alone that another run holds', () => {
    const file = takeSlot(dir, 1, otherRun()).file!
    freeSlot(file, process.pid)
    expect(readdirSync(dir)).toEqual(['slot-0'])
  })

  it('passes the exit code through and frees the slot', async () => {
    expect(await runInSlot(process.execPath, ['-e', 'process.exit(3)'], { dir, env: {} })).toBe(3)
    expect(readdirSync(dir)).toEqual([])
  })

  it('takes no slot under CI', async () => {
    takeSlot(dir, 2, otherRun())
    takeSlot(dir, 2, otherRun())
    expect(await runInSlot(process.execPath, ['-e', ''], { dir, env: { CI: 'true', KERNEL_TEST_SLOTS: '2' } })).toBe(0)
  })

  it('reads the slot count from KERNEL_TEST_SLOTS', () => {
    expect(slotCount({})).toBe(2)
    expect(slotCount({ KERNEL_TEST_SLOTS: '4' })).toBe(4)
    expect(slotCount({ KERNEL_TEST_SLOTS: 'many' })).toBe(2)
  })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end && !cond(); ) await wait(25)
  return cond()
}
const guardModule = resolve(import.meta.dirname, 'support/orphanGuard.ts')
const nodeTs = (code: string, env: NodeJS.ProcessEnv = {}) => {
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } })
  children.push(child)
  return child
}
const readPid = (child: ChildProcess) => new Promise<number>((r) => child.stdout!.once('data', (d) => r(Number(String(d).trim()))))

describe('process groups (KERNEL-812)', () => {
  it('keeps a slot taken while a worker of its group lives, and frees it after', async () => {
    const leader = spawn('sh', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' })
    const pgid = leader.pid!
    await new Promise((r) => leader.on('exit', r))
    try {
      expect(isAlive(pgid)).toBe(false)
      expect(isGroupAlive(pgid)).toBe(true)
      writeFileSync(join(dir, 'slot-0'), `${pgid} ${pgid}`)
      expect(takeSlot(dir, 1, process.pid)).toEqual({ busy: 1 })
      process.kill(-pgid, 'SIGKILL')
      expect(await until(() => !isGroupAlive(pgid))).toBe(true)
      expect(takeSlot(dir, 1, process.pid).file).toBe(join(dir, 'slot-0'))
    } finally {
      try {
        process.kill(-pgid, 'SIGKILL')
      } catch {
        // Gone already.
      }
    }
  })

  it('stops what the command left running before it frees the slot', async () => {
    const pidFile = join(dir, 'worker.pid')
    const code = await runInSlot('sh', ['-c', `sleep 30 & echo $! > ${pidFile}; exit 0`], { dir, env: {}, graceMs: 500 })
    expect(code).toBe(0)
    expect(isAlive(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
    expect(readdirSync(dir).filter((f) => f.startsWith('slot-'))).toEqual([])
  })

  it('leaves nothing running when the run is killed with SIGKILL', async () => {
    const runner = nodeTs(`
      import(${JSON.stringify(resolve(import.meta.dirname, '../scripts/testSlots.ts'))}).then(({ runInSlot }) =>
        runInSlot('sh', ['-c', 'sleep 30 & echo $!; wait'], { dir: ${JSON.stringify(dir)}, env: {} }))`)
    const worker = await readPid(runner)
    expect(isAlive(worker)).toBe(true)
    process.kill(runner.pid!, 'SIGKILL')
    await new Promise((r) => runner.on('exit', r))
    expect(takeSlot(dir, 1, process.pid)).toEqual({ busy: 1 })
    process.kill(worker, 'SIGKILL')
    let taken: string | undefined
    expect(await until(() => (taken ??= takeSlot(dir, 1, process.pid).file) !== undefined)).toBe(true)
  })

  it('gives the command its runner pid', async () => {
    const out = join(dir, 'out')
    await runInSlot('sh', ['-c', `echo $KERNEL_TEST_RUNNER_PID > ${out}`], { dir, env: {} })
    expect(readFileSync(out, 'utf8').trim()).toBe(String(process.pid))
  })
})

describe('orphan guard (KERNEL-812)', () => {
  it('ends vitest main within 3 seconds of the runner dying, and not without a runner pid', async () => {
    const runner = spawn('sleep', ['30'])
    children.push(runner)
    const main = nodeTs(`import(${JSON.stringify(guardModule)}).then((m) => { m.exitWhenRunnerDies(); setTimeout(() => {}, 30000) })`, { KERNEL_TEST_RUNNER_PID: String(runner.pid) })
    const bare = nodeTs(`import(${JSON.stringify(guardModule)}).then((m) => { m.exitWhenRunnerDies(); setTimeout(() => {}, 30000) })`, { KERNEL_TEST_RUNNER_PID: '' })
    await wait(300)
    runner.kill('SIGKILL')
    expect(await until(() => main.exitCode !== null || main.signalCode !== null, 3000)).toBe(true)
    expect(bare.exitCode).toBeNull()
    expect(bare.signalCode).toBeNull()
  })

  it('ends a worker within 3 seconds of its parent being killed', async () => {
    const parent = nodeTs(`
      const { spawn } = require('node:child_process')
      const w = spawn(process.execPath, ['-e', ${JSON.stringify(`import(${JSON.stringify(guardModule)}).then((m) => { m.exitWhenParentDies(); setTimeout(() => {}, 30000) })`)}], { stdio: 'ignore' })
      console.log(w.pid)
      setTimeout(() => {}, 30000)`)
    const worker = await readPid(parent)
    await wait(300)
    expect(isAlive(worker)).toBe(true)
    process.kill(parent.pid!, 'SIGKILL')
    expect(await until(() => !isAlive(worker), 3000)).toBe(true)
  })
})

describe('worker count (KERNEL-812)', () => {
  it('is 2 locally, 4 in CI, and follows KERNEL_TEST_WORKERS', () => {
    expect(workerCount({})).toBe(2)
    expect(workerCount({ CI: 'true' })).toBe(4)
    expect(workerCount({ KERNEL_TEST_WORKERS: '3', CI: 'true' })).toBe(3)
    expect(workerCount({ KERNEL_TEST_WORKERS: 'lots' })).toBe(2)
  })
})
