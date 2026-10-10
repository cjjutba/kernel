import { describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readlink, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { saveRepoSettings } from '../src/main/services/settings'
import { changedFiles, mergeBase } from '../src/main/services/worktrees'

async function setup(o: { link: boolean; modules?: boolean; copy?: string[]; local?: Record<string, string> }) {
  const repo = await tempRepo({
    'README.md': '# client\n',
    '.gitignore': 'node_modules/\n.env*\n!.env.example\n',
    '.env.example': 'KEY=\n',
    'apps/web/index.ts': '',
    '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
    '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
  })
  if (o.modules ?? true) {
    await mkdir(join(repo, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(repo, 'node_modules/pkg/index.js'), 'module.exports = 1\n')
  }
  if (o.link) await saveRepoSettings(repo, { files: { symlinkNodeModules: true } }, true)
  if (o.copy) await saveRepoSettings(repo, { files: { copy: o.copy } }, true)
  for (const [f, c] of Object.entries(o.local ?? {})) { await mkdir(dirname(join(repo, f)), { recursive: true }); await writeFile(join(repo, f), c) }
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  const room = await k.addRoom(repo)
  const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
  return { k, repo, ws }
}

describe('symlink node_modules into worktrees', () => {
  it('links the main checkout and keeps the link out of the changes', async () => {
    const { repo, ws } = await setup({ link: true })
    const link = join(ws.path, 'node_modules')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(join(repo, 'node_modules'))
    expect((await stat(join(link, 'pkg/index.js'))).isFile()).toBe(true)
    // .gitignore says node_modules/ (a folder), which git doesn't apply to a link.
    const files = await changedFiles(ws.path, await mergeBase(ws.path, ws.baseRef))
    expect(files.map((f) => f.path)).not.toContain('node_modules')
  }, 30000)

  it('does nothing when the option is off', async () => {
    const { ws } = await setup({ link: false })
    await expect(lstat(join(ws.path, 'node_modules'))).rejects.toThrow()
  }, 30000)

  it('skips a main checkout without node_modules', async () => {
    const { ws } = await setup({ link: true, modules: false })
    expect(ws.status).toBe('ready')
    await expect(lstat(join(ws.path, 'node_modules'))).rejects.toThrow()
  }, 30000)

  it('leaves the main folder alone on archive and links again on restore', async () => {
    const { k, repo, ws } = await setup({ link: true })
    await k.archiveWorkspace(ws.id, false)
    await expect(stat(ws.path)).rejects.toThrow()
    expect((await stat(join(repo, 'node_modules/pkg/index.js'))).isFile()).toBe(true)

    await k.restoreWorkspace(ws.id)
    const link = join(ws.path, 'node_modules')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(join(repo, 'node_modules'))
  }, 30000)
})

describe('Files to copy patterns in worktrees (KERNEL-245)', () => {
  const local = { '.env': 'KEY=1\n', '.env.local': 'KEY=2\n', 'apps/web/.env': 'WEB=1\n', 'node_modules/pkg/.env': 'no\n' }

  it('copies what files.preview lists on create and again on restore', async () => {
    const { k, ws } = await setup({ link: false, copy: ['.env*', 'apps/**/.env', 'missing.txt'], local })
    const preview = await k.handlers()['files.preview']({ roomId: ws.roomId })
    expect(preview).toEqual([{ path: '.env', size: 6 }, { path: '.env.local', size: 6 }, { path: 'apps/web/.env', size: 6 }])
    for (const f of preview) expect(await readFile(join(ws.path, f.path), 'utf8')).toBe(local[f.path as keyof typeof local])
    // The tracked .env.example comes from git, not from the copy.
    expect(await readFile(join(ws.path, '.env.example'), 'utf8')).toBe('KEY=\n')
    await expect(lstat(join(ws.path, 'node_modules'))).rejects.toThrow()

    await k.archiveWorkspace(ws.id, false)
    await k.restoreWorkspace(ws.id)
    for (const f of preview) expect(await readFile(join(ws.path, f.path), 'utf8')).toBe(local[f.path as keyof typeof local])
  }, 30000)
})
