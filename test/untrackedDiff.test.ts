import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { git } from '../src/main/services/exec'
import { readImage } from '../src/main/services/files'
import { diffText } from '../src/main/services/worktrees'
import { tempRepo } from './helpers'

// KERNEL-409: a file the agent created and hasn't committed shows in the diff tab, and the diff tab can load images.

/** A PNG's first bytes. The zero bytes make git treat it as binary. */
const png = (n: number) => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, n])
const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`

describe('the diff of untracked files (KERNEL-409)', () => {
  it('shows a new text file as all added lines, alone or after the tracked diff', async () => {
    const repo = await tempRepo({ 'README.md': '# demo\n' })
    await writeFile(join(repo, 'README.md'), '# demo\nmore\n')
    await writeFile(join(repo, 'notes.txt'), 'one\ntwo\n')
    const one = await diffText(repo, 'HEAD', 'notes.txt')
    expect(one).toContain('diff --git a/notes.txt b/notes.txt')
    expect(one).toContain('new file mode')
    expect(one).toContain('+one\n+two\n')
    expect(one).not.toContain('README.md')
    const all = await diffText(repo, 'HEAD')
    expect(all.indexOf('b/README.md')).toBeGreaterThan(-1)
    expect(all.indexOf('b/notes.txt')).toBeGreaterThan(all.indexOf('b/README.md'))
    expect(await diffText(repo, 'HEAD', 'README.md')).not.toContain('notes.txt')
  })

  it('lists a new PNG as a binary entry', async () => {
    const repo = await tempRepo({ 'README.md': '# demo\n' })
    await writeFile(join(repo, 'logo.png'), png(1))
    const text = await diffText(repo, 'HEAD', 'logo.png')
    expect(text).toContain('diff --git a/logo.png b/logo.png')
    expect(text).toMatch(/Binary files .* differ/)
  })
})

describe('workspaces.readImage (KERNEL-409)', () => {
  it('reads a new PNG from the worktree, and nothing at the base', async () => {
    const repo = await tempRepo({ 'README.md': '# demo\n' })
    await writeFile(join(repo, 'logo.png'), png(1))
    expect(await readImage(repo, 'logo.png')).toEqual({ dataUrl: dataUrl(png(1)) })
    expect(await readImage(repo, 'logo.png', 'HEAD')).toBeNull()
  })

  it('reads both versions of a committed PNG the agent changed', async () => {
    const repo = await tempRepo({ 'README.md': '# demo\n' })
    await writeFile(join(repo, 'logo.png'), png(1))
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-qm', 'logo')
    await writeFile(join(repo, 'logo.png'), png(2))
    expect(await readImage(repo, 'logo.png')).toEqual({ dataUrl: dataUrl(png(2)) })
    expect(await readImage(repo, 'logo.png', 'HEAD')).toEqual({ dataUrl: dataUrl(png(1)) })
  })

  it('refuses paths outside the workspace and files that are not images', async () => {
    const repo = await tempRepo({ 'README.md': '# demo\n', 'src/a.ts': 'a\n' })
    await expect(readImage(repo, '../outside.png')).rejects.toThrow('outside')
    await expect(readImage(repo, '../outside.png', 'HEAD')).rejects.toThrow('outside')
    await expect(readImage(repo, 'src/../../outside.png')).rejects.toThrow('outside')
    await expect(readImage(repo, 'src/a.ts')).rejects.toThrow('not an image')
  })

  it('reads the base at the merge base of a worktree workspace', async () => {
    const repo = await tempRepo({
      'README.md': '# demo\n',
      '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    })
    await writeFile(join(repo, 'logo.png'), png(1))
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-qm', 'logo')
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop())
    k.sessions.send = async () => ({ queued: false })
    const room = await k.rooms.addRoom(repo)
    const ws = await k.workspaces.createWorkspace(room.id, { prompt: 'Swap the logo', agentId: 'kai' })
    // The agent commits a new logo, then adds a page it hasn't committed yet.
    await writeFile(join(ws.path, 'logo.png'), png(2))
    await git(ws.path, 'commit', '-qam', 'new logo')
    await writeFile(join(ws.path, 'page.txt'), 'hello\n')
    const h = k.handlers()
    expect(await h['workspaces.readImage']({ workspaceId: ws.id, path: 'logo.png', at: 'base' })).toEqual({ dataUrl: dataUrl(png(1)) })
    expect(await h['workspaces.readImage']({ workspaceId: ws.id, path: 'logo.png', at: 'worktree' })).toEqual({ dataUrl: dataUrl(png(2)) })
    expect(await h['workspaces.diff']({ workspaceId: ws.id, file: 'page.txt' })).toContain('+hello\n')
  })
})
