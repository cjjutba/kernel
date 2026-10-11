import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A `codex` executable that runs the fake app-server (fakeCodexServer.mjs) on this Electron's Node, and the log it writes. */
export async function fakeCodex(): Promise<{ bin: string; log: string; env: Record<string, string>; messages: () => Promise<any[]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-fake-codex-'))
  const bin = join(dir, 'codex')
  const log = join(dir, 'log.jsonl')
  await writeFile(log, '')
  await writeFile(bin, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${join(__dirname, 'fakeCodexServer.mjs')}" "$@"\n`)
  await chmod(bin, 0o755)
  const messages = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { bin, log, env: { ...(process.env as Record<string, string>), FAKE_CODEX_LOG: log }, messages }
}

/** A turn's script for the fake app-server: what it sends Kernel, in order (see fakeCodexServer.mjs). */
export const script = (...steps: object[]) => JSON.stringify(steps)

/** Steps for the fake: an item Codex started and finished. */
export const item = (item: object) => [{ notify: 'item/started', params: { item } }, { notify: 'item/completed', params: { item } }]
