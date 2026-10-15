import { expect, vi } from 'vitest'
import { cp, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { run } from '../src/main/services/exec'
import { bus } from '../src/main/bus'
import type { PushEvent } from '../src/shared/ipc'
import type { Kernel } from '../src/main/kernel'

const templates = new Map<string, Promise<string>>()

async function buildRepo(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-template-'))
  await run('git', ['init', '-q', '-b', 'main', dir])
  await run('git', ['-C', dir, 'config', 'user.email', 't@t.dev'])
  await run('git', ['-C', dir, 'config', 'user.name', 'Test'])
  // A commit can start git's maintenance in the background, whose lock file comes and goes while `tempRepo` copies the
  // folder, and the copy fails on it. Test repos are small and short-lived, so neither the template nor its copies run it.
  await run('git', ['-C', dir, 'config', 'maintenance.auto', 'false'])
  await run('git', ['-C', dir, 'config', 'gc.auto', '0'])
  for (const [f, c] of Object.entries(files)) { await mkdir(dirname(join(dir, f)), { recursive: true }); await writeFile(join(dir, f), c) }
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-q', '-m', 'init'])
  return dir
}

/** A new git repo on main with `files` committed. Each distinct file set is built once per worker and copied, so every call gets its own folder. */
export async function tempRepo(files: Record<string, string> = { 'README.md': '# demo\n' }) {
  const key = JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))
  let template = templates.get(key)
  if (!template) { template = buildRepo(files); templates.set(key, template) }
  const dir = await mkdtemp(join(tmpdir(), 'kernel-'))
  await cp(await template, dir, { recursive: true })
  // The copy's files have new inodes and times, which leaves git's index stale until it looks again: `git stash create` fails on it.
  await run('git', ['-C', dir, 'update-index', '-q', '--refresh'])
  return dir
}

/**
 * A `gh` first on PATH that answers `gh issue list` with `list` and `gh issue view` with `view`, and fails anything else.
 * With `prs` it answers `gh pr list` too, and with `login` it is signed in as that user (KERNEL-479). `calls` lists the issue
 * and PR commands it ran, by their arguments (KERNEL-462). `vi.unstubAllEnvs()` takes it off PATH.
 */
export async function fakeGh(o: { list?: unknown; view?: unknown; prs?: unknown; login?: string }) {
  const bin = await mkdtemp(join(tmpdir(), 'kernel-gh-'))
  const log = join(bin, 'calls.log')
  await writeFile(join(bin, 'list.json'), JSON.stringify(o.list ?? []))
  await writeFile(join(bin, 'view.json'), JSON.stringify(o.view ?? {}))
  await writeFile(join(bin, 'prs.json'), JSON.stringify(o.prs ?? []))
  await writeFile(join(bin, 'auth.json'), JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, login: o.login ?? '' }] } }))
  await writeFile(join(bin, 'gh'), [
    '#!/bin/sh',
    `case "$1 $2" in`,
    `  "issue list") echo "$*" >> "${log}"; cat "${bin}/list.json" ;;`,
    `  "issue view") echo "$*" >> "${log}"; cat "${bin}/view.json" ;;`,
    ...(o.prs ? [`  "pr list") echo "$*" >> "${log}"; cat "${bin}/prs.json" ;;`] : []),
    ...(o.login ? [`  "auth status") cat "${bin}/auth.json" ;;`] : []),
    '  *) echo "not stubbed" >&2; exit 1 ;;',
    'esac',
    ''
  ].join('\n'), { mode: 0o755 })
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  return { calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) }
}

/**
 * Waits until a workspace has finished setting up: a new chat with Kernel, a restore or a fork sets up in the background
 * (KERNEL-405). Takes the workspace's id or one of its chats. Returns the workspace as it is then.
 */
export async function setUp(k: Kernel, id: string, status: 'ready' | 'failed' | 'settled' = 'ready') {
  const wsId = k.store.chat(id)?.workspaceId ?? id
  // What the setup script printed, for a failure to show.
  const log: string[] = []
  const on = (e: PushEvent) => { if (e.type === 'script.output' && e.workspaceId === wsId) log.push(...e.lines.map((l) => l.line)) }
  bus.on('push', on)
  try {
    // `settled` is whatever setup ended in: ready or failed.
    if (status === 'settled') await vi.waitFor(() => expect(k.store.workspace(wsId)?.status).not.toBe('setup'), { timeout: 10_000, interval: 10 })
    else await vi.waitFor(() => expect(k.store.workspace(wsId)?.status).toBe(status), { timeout: 10_000, interval: 10 })
  } catch (e) {
    throw new Error(`${(e as Error).message}\nSetup log:\n${log.join('\n') || '(none)'}\nWorkspace: ${JSON.stringify(k.store.workspace(wsId))}`, { cause: e })
  } finally { bus.off('push', on) }
  return k.store.workspace(wsId)!
}

/** A TCP port the OS just handed out. Use it for a Kernel's `hookPort`: a random pick can match the one another test file picked, and the second hook server then fails to bind. */
export function freePort() {
  return new Promise<number>((resolve, reject) => {
    const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) })
  })
}
