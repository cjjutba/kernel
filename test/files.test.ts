import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { listTree, parseMention, readImage, readWorkspaceFile, resolvePaths, scratchpadDir } from '../src/main/services/files'
import { Kernel } from '../src/main/kernel'
import { freePort, setUp, tempRepo } from './helpers'

describe('workspace files', () => {
  it('lists tracked and untracked files with their directories, directories first', async () => {
    const repo = await tempRepo({ 'src/app/page.tsx': 'a\n', 'src/app/table.tsx': 'b\n', 'src/db/schema.ts': 'c\n', 'README.md': '# r\n', '.gitignore': 'node_modules\n' })
    await mkdir(join(repo, 'node_modules/x'), { recursive: true })
    await writeFile(join(repo, 'node_modules/x/index.js'), 'ignored\n')
    await writeFile(join(repo, 'src/app/empty-state.tsx'), 'new\n')
    const tree = await listTree(repo, [{ path: 'src/app/table.tsx', status: 'M', added: 1, removed: 0 }, { path: 'src/app/empty-state.tsx', status: 'A', added: 1, removed: 0 }])
    expect(tree.map((e) => e.path)).toEqual([
      'src', 'src/app', 'src/app/empty-state.tsx', 'src/app/page.tsx', 'src/app/table.tsx', 'src/db', 'src/db/schema.ts', '.gitignore', 'README.md'
    ])
    expect(tree.find((e) => e.path === 'src/app/table.tsx')).toMatchObject({ dir: false, status: 'M' })
    expect(tree.find((e) => e.path === 'src/app/empty-state.tsx')?.status).toBe('A')
    expect(tree.find((e) => e.path === 'src/app')?.dir).toBe(true)
    expect(tree.find((e) => e.path === 'src/app/page.tsx')?.status).toBeUndefined()
  })

  it('reads a text file and refuses anything outside the worktree, binaries and folders', async () => {
    const repo = await tempRepo({ 'src/a.ts': 'export const a = 1\n' })
    await writeFile(join(repo, 'logo.png'), Buffer.from([137, 80, 78, 71, 0, 1, 2]))
    expect(await readWorkspaceFile(repo, 'src/a.ts')).toBe('export const a = 1\n')
    await expect(readWorkspaceFile(repo, '../outside.txt')).rejects.toThrow('outside')
    await expect(readWorkspaceFile(repo, '/etc/hosts')).rejects.toThrow('outside')
    await expect(readWorkspaceFile(repo, 'src')).rejects.toThrow('not a file')
    await expect(readWorkspaceFile(repo, 'logo.png')).rejects.toThrow('binary')
    await expect(readWorkspaceFile(repo, 'missing.ts')).rejects.toThrow('not a file')
  })

  it('does not follow a symlink out of the worktree', async () => {
    const repo = await tempRepo({ 'a.txt': 'a\n' })
    await symlink('/etc/hosts', join(repo, 'link'))
    await expect(readWorkspaceFile(repo, 'link')).rejects.toThrow('outside')
  })
})

describe('mentions in chat (clickable file mentions)', () => {
  let repo: string, home: string, pad: string, resolve: (paths: string[]) => ReturnType<typeof resolvePaths>
  beforeAll(async () => {
    repo = await tempRepo({ 'src/main/kernel.ts': 'export {}\n', 'src/tokens.css': ':root {}\n', 'a/index.ts': '\n', 'b/index.ts': '\n', 'logo.png': 'png\n', 'config/.env': 'PORT=1\n', 'notes.md': 'API_KEY=sk-123\n' })
    await symlink('/etc/hosts', join(repo, 'hosts'))
    home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await mkdir(join(home, '.ssh'))
    await writeFile(join(home, '.ssh/id_rsa'), 'key\n')
    pad = join(await mkdtemp(join(tmpdir(), 'kernel-pad-')), 'scratchpad')
    await mkdir(pad)
    await writeFile(join(pad, 'prompt.md'), '# prompt\n')
    resolve = (paths) => resolvePaths(repo, paths, { also: [pad], home })
  })

  it('splits a line range from the path, in every form agents print', () => {
    expect(parseMention('src/main/kernel.ts:209')).toEqual({ path: 'src/main/kernel.ts', line: 209 })
    expect(parseMention('src/main/kernel.ts:12-30')).toEqual({ path: 'src/main/kernel.ts', line: 12, endLine: 30 })
    expect(parseMention('src/main/kernel.ts#L12-L30')).toEqual({ path: 'src/main/kernel.ts', line: 12, endLine: 30 })
    expect(parseMention('src/main/kernel.ts#L12')).toEqual({ path: 'src/main/kernel.ts', line: 12 })
    expect(parseMention('src/main/kernel.ts:12:5')).toEqual({ path: 'src/main/kernel.ts', line: 12 })
    expect(parseMention('src\\main\\kernel.ts')).toEqual({ path: 'src/main/kernel.ts' })
  })

  it('resolves a worktree file with its lines, a folder, an image and a scratchpad file', async () => {
    const real = await realpath(pad)
    expect(await resolve(['src/main/kernel.ts:12-30', './src/main/kernel.ts#L12-L30', 'src\\main', 'logo.png', join(pad, 'prompt.md')])).toEqual({
      'src/main/kernel.ts:12-30': { kind: 'file', path: 'src/main/kernel.ts', line: 12, endLine: 30 },
      './src/main/kernel.ts#L12-L30': { kind: 'file', path: 'src/main/kernel.ts', line: 12, endLine: 30 },
      'src\\main': { kind: 'dir', path: 'src/main' },
      'logo.png': { kind: 'image', path: 'logo.png' },
      [join(pad, 'prompt.md')]: { kind: 'file', path: join(real, 'prompt.md') }
    })
  })

  it('answers null outside the worktree and the scratchpad, through a symlink, up with ../, and for a missing file', async () => {
    expect(await resolve(['~/.ssh/id_rsa', join(home, '.ssh/id_rsa'), 'hosts', '../README.md', 'src/../../README.md', 'src/missing.ts', '/etc/hosts'])).toEqual({
      '~/.ssh/id_rsa': null, [join(home, '.ssh/id_rsa')]: null, hosts: null, '../README.md': null, 'src/../../README.md': null, 'src/missing.ts': null, '/etc/hosts': null
    })
  })

  it('resolves a bare name only when one file has it, and lists them all when several do', async () => {
    expect(await resolve(['tokens.css', 'index.ts'])).toEqual({
      'tokens.css': { kind: 'file', path: 'src/tokens.css' },
      'index.ts': { matches: ['a/index.ts', 'b/index.ts'] }
    })
  })

  it('flags a .env file and one holding a secret as sensitive', async () => {
    expect(await resolve(['config/.env', 'notes.md', 'src/tokens.css'])).toEqual({
      'config/.env': { kind: 'file', path: 'config/.env', sensitive: true },
      'notes.md': { kind: 'file', path: 'notes.md', sensitive: true },
      'src/tokens.css': { kind: 'file', path: 'src/tokens.css' }
    })
  })

  it('reads a scratchpad file and image by their absolute path, and nothing else outside the worktree', async () => {
    await writeFile(join(pad, 'shot.png'), 'png\n')
    expect(await readWorkspaceFile(repo, join(pad, 'prompt.md'), [pad])).toBe('# prompt\n')
    expect(await readImage(repo, join(pad, 'shot.png'), undefined, [pad])).toEqual({ dataUrl: `data:image/png;base64,${Buffer.from('png\n').toString('base64')}` })
    await expect(readWorkspaceFile(repo, join(pad, 'prompt.md'))).rejects.toThrow('outside')
    await expect(readWorkspaceFile(repo, join(home, '.ssh/id_rsa'), [pad])).rejects.toThrow('outside')
  })

  it("allows the workspace's own chat scratchpad, built from its session, and forgets a mention once the files change", async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kernel-tmp-'))
    vi.stubEnv('CLAUDE_CODE_TMPDIR', tmp)
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const kHome = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(kHome, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home: kHome })
    try {
      await k.start()
      k.sessions.send = async () => ({ queued: false })
      const project = await k.addProject(await tempRepo({ 'README.md': '# client\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' }))
      const ws = await setUp(k, (await k.workspaces.createWorkspace(project.id, { prompt: 'Build it', agentId: 'kai', title: 'Build' })).id)
      const chat = k.store.chats(ws.id)[0]
      k.store.saveChat({ ...chat, sessionId: 'sess-1' })
      const dir = scratchpadDir(ws.path, 'sess-1')
      expect(dir.startsWith(tmp)).toBe(true)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'plan.md'), '# plan\n')
      const h = k.handlers()
      const plan = join(dir, 'plan.md')
      expect((await h['workspaces.resolvePaths']({ workspaceId: ws.id, paths: [plan, 'new.ts'] }))[plan]).toMatchObject({ kind: 'file' })
      expect(await h['workspaces.readFile']({ workspaceId: ws.id, path: plan })).toBe('# plan\n')
      // Another session's scratchpad is outside.
      const other = scratchpadDir(ws.path, 'sess-2')
      await mkdir(other, { recursive: true })
      await writeFile(join(other, 'x.md'), 'x\n')
      expect((await h['workspaces.resolvePaths']({ workspaceId: ws.id, paths: [join(other, 'x.md')] }))[join(other, 'x.md')]).toBeNull()
      await expect(h['workspaces.readFile']({ workspaceId: ws.id, path: join(other, 'x.md') })).rejects.toThrow('outside')
      // A miss in the worktree is kept until the changed files move.
      await h['workspaces.changes']({ workspaceId: ws.id })
      expect((await h['workspaces.resolvePaths']({ workspaceId: ws.id, paths: ['new.ts'] }))['new.ts']).toBeNull()
      await writeFile(join(ws.path, 'new.ts'), 'export {}\n')
      expect((await h['workspaces.resolvePaths']({ workspaceId: ws.id, paths: ['new.ts'] }))['new.ts']).toBeNull()
      await h['workspaces.changes']({ workspaceId: ws.id })
      expect((await h['workspaces.resolvePaths']({ workspaceId: ws.id, paths: ['new.ts'] }))['new.ts']).toEqual({ kind: 'file', path: 'new.ts' })
    } finally {
      vi.unstubAllEnvs()
      await k.stop({ budgetMs: 0 })
      await rm(tmp, { recursive: true, force: true })
    }
  }, 20_000)
})
