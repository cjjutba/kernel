import { describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { tempRepo, trustRoom } from './helpers'
import { Kernel } from '../src/main/kernel'
import { saveRepoSettings } from '../src/main/services/settings'
import { copyLocalFiles } from '../src/main/services/scripts'
import { resolveFilesToCopy } from '../src/main/services/filesToCopy'
import { bus } from '../src/main/bus'
import type { PushEvent } from '../src/shared/ipc'
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
  // A copy list from settings.toml is the repo's text, which the user trusts before it copies (KERNEL-209).
  await trustRoom(k, room.id)
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

describe('files.copy stays inside the repo (KERNEL-209)', () => {
  // home/.ssh/id_rsa next to home/code/repo, so ../../.ssh/id_rsa from the repo is the key.
  async function layout() {
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await mkdir(join(home, '.ssh'))
    await writeFile(join(home, '.ssh/id_rsa'), 'PRIVATE KEY\n')
    const repo = join(home, 'code/repo'), worktree = join(home, 'wt/feature')
    await mkdir(repo, { recursive: true })
    await mkdir(worktree, { recursive: true })
    await writeFile(join(repo, '.env.local'), 'SECRET=1\n')
    return { home, repo, worktree }
  }

  it('copies files in the repo and refuses entries that leave it', async () => {
    const { home, repo, worktree } = await layout()
    await mkdir(join(repo, 'config'))
    await writeFile(join(repo, 'config/app.env'), 'A=1\n')
    // A link that stays inside the repo is fine; one that points out is not.
    await symlink(join(repo, 'config/app.env'), join(repo, 'inner.env'))
    await symlink(join(home, '.ssh/id_rsa'), join(repo, 'key.env'))
    await symlink(join(home, '.ssh'), join(repo, 'dotssh'))
    const r = await copyLocalFiles(repo, worktree, ['.env.local', 'config/app.env', 'inner.env', '../../.ssh/id_rsa', join(home, '.ssh/id_rsa'), 'key.env', 'dotssh/id_rsa', 'missing.env'])
    expect(r.copied).toEqual(['.env.local', 'config/app.env', 'inner.env'])
    // A leading slash reads as relative (KERNEL-245), so the absolute path is a missing file in the repo, never the key.
    expect(r.refused).toEqual(['../../.ssh/id_rsa', 'key.env', 'dotssh/id_rsa'])
    expect(await readFile(join(worktree, 'inner.env'), 'utf8')).toBe('A=1\n')
    await expect(stat(join(worktree, 'key.env'))).rejects.toThrow()
    await expect(stat(join(worktree, 'dotssh'))).rejects.toThrow()
  })

  it('copies nothing, and throws nothing, into a worktree an archive already removed', async () => {
    const { repo, worktree } = await layout()
    expect(await copyLocalFiles(repo, join(worktree, 'gone'), ['.env.local'])).toEqual({ copied: [], refused: [] })
  })

  it('keeps patterns inside the repo: ../**, an absolute pattern and linked folders match nothing outside', async () => {
    const { k, repo, ws } = await setup({ link: false, local: { '.env': 'A=1\n' } })
    const outside = await mkdtemp(join(tmpdir(), 'kernel-outside-'))
    await writeFile(join(outside, 'id_rsa'), 'PRIVATE KEY\n')
    await writeFile(join(outside, '.env.prod'), 'PROD=1\n')
    // A linked folder at the top, and one inside an ignored folder a pattern names.
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n.env*\n!.env.example\nlinked\nsecrets/\n')
    await symlink(outside, join(repo, 'linked'))
    await mkdir(join(repo, 'secrets'))
    await symlink(outside, join(repo, 'secrets', 'keys'))
    const entries = ['../**', '../*/id_rsa', `${outside}/*`, 'linked/*', 'linked/**', 'secrets/keys/*', 'secrets/**', '**/id_rsa', '.env*']

    const refused: string[] = []
    expect(await resolveFilesToCopy(repo, entries, refused)).toEqual([{ path: '.env', size: 4 }])
    expect(refused).toEqual(expect.arrayContaining(['../**', '../*/id_rsa', `${outside}/*`]))
    // The preview lists the same, so it shows nothing outside the repo either.
    expect(await k.handlers()['files.preview']({ roomId: ws.roomId, patterns: entries })).toEqual([{ path: '.env', size: 4 }])
    const wt = await mkdtemp(join(tmpdir(), 'kernel-wt-'))
    expect((await copyLocalFiles(repo, wt, entries)).copied).toEqual(['.env'])
    expect(await readdir(wt)).toEqual(['.env'])
    await k.stop()
  }, 30000)

  it("refuses to write through a symlink the worktree checked out", async () => {
    const { home, repo, worktree } = await layout()
    const outside = join(home, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'mine\n')
    // The repo commits `.env.local` and `conf` as links out of it, so the worktree has them too.
    await symlink(join(outside, 'keep'), join(worktree, '.env.local'))
    await symlink(outside, join(worktree, 'conf'))
    await mkdir(join(repo, 'conf'))
    await writeFile(join(repo, 'conf/new.env'), 'B=2\n')
    const r = await copyLocalFiles(repo, worktree, ['.env.local', 'conf/new.env'])
    expect(r).toEqual({ copied: [], refused: ['.env.local', 'conf/new.env'] })
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('mine\n')
    await expect(stat(join(outside, 'new.env'))).rejects.toThrow()
  })

  it("says in the workspace's setup output which entry was refused", async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const room = await k.addRoom(repo)
    // Saved in Settings, so trusted: confinement still applies to trusted text.
    await k.handlers()['settings.setRoom']({ roomId: room.id, patch: { files: { copy: ['../../.ssh/id_rsa'] } }, shared: true })
    const lines: string[] = []
    const on = (e: PushEvent) => { if (e.type === 'script.output' && e.kind === 'setup') lines.push(e.line) }
    bus.on('push', on)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })
    bus.off('push', on)
    expect(ws.status).toBe('ready')
    expect(lines).toContain('Did not copy ../../.ssh/id_rsa: files.copy can only copy files inside the repo.')
    await k.stop()
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
