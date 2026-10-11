import { expect, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { run } from '../src/main/services/exec'
import type { Kernel } from '../src/main/kernel'

export async function tempRepo(files: Record<string, string> = { 'README.md': '# demo\n' }) {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-'))
  await run('git', ['init', '-q', '-b', 'main', dir])
  await run('git', ['-C', dir, 'config', 'user.email', 't@t.dev'])
  await run('git', ['-C', dir, 'config', 'user.name', 'Test'])
  for (const [f, c] of Object.entries(files)) { await mkdir(dirname(join(dir, f)), { recursive: true }); await writeFile(join(dir, f), c) }
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-q', '-m', 'init'])
  return dir
}

/**
 * A `gh` first on PATH that answers `gh issue list` with `list` and `gh issue view` with `view`, and fails anything else.
 * `calls` lists the issue commands it ran, by their arguments (KERNEL-462). `vi.unstubAllEnvs()` takes it off PATH.
 */
export async function fakeGh(o: { list?: unknown; view?: unknown }) {
  const bin = await mkdtemp(join(tmpdir(), 'kernel-gh-'))
  const log = join(bin, 'calls.log')
  await writeFile(join(bin, 'list.json'), JSON.stringify(o.list ?? []))
  await writeFile(join(bin, 'view.json'), JSON.stringify(o.view ?? {}))
  await writeFile(join(bin, 'gh'), [
    '#!/bin/sh',
    `case "$1 $2" in`,
    `  "issue list") echo "$*" >> "${log}"; cat "${bin}/list.json" ;;`,
    `  "issue view") echo "$*" >> "${log}"; cat "${bin}/view.json" ;;`,
    '  *) echo "not stubbed" >&2; exit 1 ;;',
    'esac',
    ''
  ].join('\n'), { mode: 0o755 })
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  return { calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) }
}

/** The user trusts the room's scripts, as they would when Kernel asks (KERNEL-209). For tests whose repo brings a script. */
export async function trustRoom(k: Kernel, roomId: string) {
  const pending = await k.handlers()['rooms.scriptTrust']({ roomId })
  if (pending) await k.handlers()['rooms.trust']({ roomId, hash: pending.hash })
}

/**
 * Waits until a workspace has finished setting up: a new chat with Rowan, a restore or a fork sets up in the background
 * (KERNEL-405). Takes the workspace's id or one of its chats. Returns the workspace as it is then.
 */
export async function setUp(k: Kernel, id: string, status: 'ready' | 'failed' | 'trust' | 'settled' = 'ready') {
  const wsId = k.store.chat(id)?.workspaceId ?? id
  // `settled` is whatever setup ended in: ready, failed, or waiting for trust.
  if (status === 'settled') await vi.waitFor(() => expect(k.store.workspace(wsId)?.status).not.toBe('setup'), { timeout: 10_000, interval: 10 })
  else await vi.waitFor(() => expect(k.store.workspace(wsId)?.status).toBe(status), { timeout: 10_000, interval: 10 })
  return k.store.workspace(wsId)!
}
