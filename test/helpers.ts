import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
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

/** The user trusts the room's scripts, as they would when Kernel asks (KERNEL-209). For tests whose repo brings a script. */
export async function trustRoom(k: Kernel, roomId: string) {
  const pending = await k.handlers()['rooms.scriptTrust']({ roomId })
  if (pending) await k.handlers()['rooms.trust']({ roomId, hash: pending.hash })
}
