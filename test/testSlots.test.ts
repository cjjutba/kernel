import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freeSlot, runInSlot, slotCount, takeSlot, waitForSlot } from '../scripts/testSlots.ts'

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
