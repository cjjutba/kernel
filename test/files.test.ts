import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listTree, readWorkspaceFile } from '../src/main/services/files'
import { tempRepo } from './helpers'

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
