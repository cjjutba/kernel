// Test slots (KERNEL-736). Every test run on the Mac takes one of a few slots before it starts vitest, so
// however many teammates run tests, only that many runs share the memory. A slot is a file named
// slot-<n> holding the pid of the run that took it, created with exclusive create so two runs can't
// take the same one. A slot whose pid is dead belongs to a run that was killed, and gets freed.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_SLOTS = 2

export const slotsDir = () => join(tmpdir(), 'kernel-test-slots')

export function slotCount(env: NodeJS.ProcessEnv): number {
  const n = Number(env.KERNEL_TEST_SLOTS)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SLOTS
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// A run writes its pid right after creating the file, so an empty file is a run in that gap. One that stays
// empty this long lost its run between the two steps.
const EMPTY_GRACE_MS = 10_000

// The pid holding the slot, or undefined when the file is gone or its run is dead (the file is removed then).
function holder(file: string): number | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8').trim()
  } catch {
    return undefined
  }
  const pid = Number(text)
  if (text && Number.isInteger(pid) && pid > 0) {
    if (isAlive(pid)) return pid
  } else {
    try {
      if (Date.now() - statSync(file).mtimeMs < EMPTY_GRACE_MS) return -1
    } catch {
      return undefined
    }
  }
  try {
    unlinkSync(file)
  } catch {
    // Another run freed it first.
  }
  return undefined
}

// Takes a free slot for pid and returns its file. Without one, busy is the number of runs holding slots.
export function takeSlot(dir: string, slots: number, pid = process.pid): { file?: string; busy: number } {
  mkdirSync(dir, { recursive: true })
  let busy = 0
  for (let i = 0; i < slots; i++) {
    const file = join(dir, `slot-${i}`)
    if (holder(file) !== undefined) {
      busy++
      continue
    }
    try {
      writeFileSync(file, String(pid), { flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      busy++
      continue
    }
    // Two runs that freed the same dead slot at once could both create it. The one whose pid isn't in the
    // file lost and keeps looking.
    if (readFileSync(file, 'utf8').trim() === String(pid)) return { file, busy }
    busy++
  }
  return { busy }
}

export function freeSlot(file: string, pid = process.pid) {
  try {
    if (readFileSync(file, 'utf8').trim() === String(pid)) unlinkSync(file)
  } catch {
    // Already gone.
  }
}

// Waits for a slot, saying once that it is waiting, then checking again every interval.
export async function waitForSlot(
  dir: string,
  slots: number,
  opts: { pid?: number; intervalMs?: number; log?: (line: string) => void } = {}
): Promise<string> {
  const { pid = process.pid, intervalMs = 1000, log = console.log } = opts
  let said = false
  for (;;) {
    const { file, busy } = takeSlot(dir, slots, pid)
    if (file) return file
    if (!said) log(`Waiting for a test slot, ${busy} ${busy === 1 ? 'run' : 'runs'} in progress`)
    said = true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// The shell's convention: a run ended by a signal exits with 128 plus the signal's number.
const signalCode = (signal: NodeJS.Signals) => 128 + constants.signals[signal]

// Runs command with a slot held (none when CI is set) and resolves with its exit code. The slot is freed
// when the command ends, when this process exits, and on SIGINT and SIGTERM, which go on to the command.
export async function runInSlot(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; dir?: string; intervalMs?: number; log?: (line: string) => void } = {}
): Promise<number> {
  const env = opts.env ?? process.env
  let slot: string | undefined
  const free = () => {
    if (slot) freeSlot(slot)
    slot = undefined
  }
  let child: ReturnType<typeof spawn> | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    if (child && child.exitCode === null && child.signalCode === null) return void child.kill(signal)
    free()
    process.exit(signalCode(signal))
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  process.on('exit', free)
  try {
    if (!env.CI) slot = await waitForSlot(opts.dir ?? slotsDir(), slotCount(env), { intervalMs: opts.intervalMs, log: opts.log })
    child = spawn(command, args, { stdio: 'inherit', env })
    const running = child
    return await new Promise<number>((resolve, reject) => {
      running.on('error', reject)
      running.on('exit', (code, signal) => {
        resolve(code ?? signalCode(signal ?? 'SIGTERM'))
      })
    })
  } finally {
    free()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.off('exit', free)
  }
}
