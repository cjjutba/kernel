import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseReplay, show, type ReplayHeader } from './replayMatch.mjs'

/** A `codex` executable that plays a recording (replayCodexServer.mjs), and what it says about how the replay went. */
export interface CodexReplay {
  bin: string
  env: Record<string, string>
  header: ReplayHeader
  /** The messages Kernel sent, in order. */
  sent(): Promise<any[]>
  /** Throws when Kernel sent something the recording did not expect, naming the frame. */
  assertNoMismatch(): Promise<void>
  /** Throws on a mismatch, or when the recording was not played to its end. */
  assertDone(): Promise<void>
}

export async function codexReplay(file: string): Promise<CodexReplay> {
  const { header, frames } = parseReplay(await readFile(file, 'utf8'), file)
  const dir = await mkdtemp(join(tmpdir(), 'kernel-replay-codex-'))
  const bin = join(dir, 'codex')
  const log = join(dir, 'log.jsonl')
  await writeFile(log, '')
  await writeFile(bin, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${join(__dirname, 'replayCodexServer.mjs')}" "$@"\n`)
  await chmod(bin, 0o755)
  const lines = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const assertNoMismatch = async () => {
    const failed = (await lines()).find((l) => l.failed)?.failed
    if (failed) throw new Error(`${header.scenario}: frame ${failed.frame} (line ${failed.line} of ${file}) did not match: ${failed.reason}\nexpected ${failed.expected}\nKernel sent ${JSON.stringify(failed.actual)}`)
  }
  return {
    bin, header, env: { ...(process.env as Record<string, string>), REPLAY_FILE: file, REPLAY_LOG: log },
    sent: async () => (await lines()).filter((l) => l.out).map((l) => l.out),
    assertNoMismatch,
    assertDone: async () => {
      await assertNoMismatch()
      const consumed = (await lines()).filter((l) => l.consumed !== undefined).at(-1)?.consumed ?? 0
      if (consumed < frames.length) throw new Error(`${header.scenario}: the replay stopped at frame ${consumed + 1} of ${frames.length} (line ${consumed + 2} of ${file}): Kernel never sent what the recording expects next: ${show(frames[consumed])}`)
    }
  }
}
