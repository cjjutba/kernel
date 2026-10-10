import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { tempRepo } from './helpers'
import { MAX_FILES_TO_COPY, resolveFilesToCopy } from '../src/main/services/filesToCopy'
import { copyLocalFiles } from '../src/main/services/scripts'
import { run } from '../src/main/services/exec'

async function put(root: string, files: Record<string, string>) {
  for (const [f, c] of Object.entries(files)) { await mkdir(dirname(join(root, f)), { recursive: true }); await writeFile(join(root, f), c) }
}
const paths = async (repo: string, entries: string[]) => (await resolveFilesToCopy(repo, entries)).map((f) => f.path)

describe('Files to copy patterns (KERNEL-245)', () => {
  it('.env* copies the ignored .env and .env.local and never the tracked .env.example', async () => {
    const repo = await tempRepo({ 'README.md': '# r\n', '.gitignore': '.env*\n!.env.example\n', '.env.example': 'KEY=\n' })
    await put(repo, { '.env': 'KEY=1\n', '.env.local': 'KEY=22\n' })
    expect(await resolveFilesToCopy(repo, ['.env*'])).toEqual([{ path: '.env', size: 6 }, { path: '.env.local', size: 7 }])

    const wt = await mkdtemp(join(tmpdir(), 'kernel-wt-'))
    expect(await copyLocalFiles(repo, wt, ['.env*'])).toEqual(['.env', '.env.local'])
    expect(await readFile(join(wt, '.env.local'), 'utf8')).toBe('KEY=22\n')
    expect((await readdir(wt)).sort()).toEqual(['.env', '.env.local'])
  })

  it('src/**/.env finds nested files, in tracked folders and in a folder git does not know yet', async () => {
    const repo = await tempRepo({ '.gitignore': '.env\n', 'src/index.ts': '', 'src/api/routes.ts': '' })
    await put(repo, { '.env': 'root\n', 'src/.env': 'a\n', 'src/api/.env': 'b\n', 'src/new/deep/.env': 'c\n', 'other/.env': 'd\n' })
    expect(await paths(repo, ['src/**/.env'])).toEqual(['src/.env', 'src/api/.env', 'src/new/deep/.env'])
    expect(await paths(repo, ['**/.env'])).toEqual(['.env', 'other/.env', 'src/.env', 'src/api/.env', 'src/new/deep/.env'])
  })

  it('never walks a large ignored node_modules', async () => {
    const repo = await tempRepo({ '.gitignore': 'node_modules/\n.env\n', 'src/index.ts': '' })
    await put(repo, { '.env': 'x\n', 'src/.env': 'y\n' })
    // Thousands of files that every pattern below would match if anything listed them one by one.
    for (let i = 0; i < 40; i++) await put(repo, Object.fromEntries(Array.from({ length: 50 }, (_, j) => [`node_modules/pkg${i}/f${j}/.env`, 'no\n'])))
    // Git reports the wholly ignored folder as one entry and doesn't list what is inside it.
    const listed = (await run('git', ['-C', repo, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])).split('\0').filter(Boolean)
    expect(listed.sort()).toEqual(['.env', 'node_modules/', 'src/.env'])
    expect(await paths(repo, ['**/.env', '**/*', 'node_modules/**'])).toEqual(['.env', 'src/.env'])
  }, 60000)

  it('skips node_modules and .git segments even when git lists them, plus symlinks and folders', async () => {
    // No node_modules line, so git lists the ignored files inside it one by one.
    const repo = await tempRepo({ '.gitignore': '*.local\nlinked\n', 'README.md': '' })
    await put(repo, { 'a.local': 'a\n', 'node_modules/pkg/b.local': 'b\n', 'sub/.git/c.local': 'c\n', 'dir.local/inner.txt': 'd\n' })
    await symlink(join(repo, 'a.local'), join(repo, 'link.local'))
    await symlink(join(repo, 'dir.local'), join(repo, 'linked'))
    expect(await paths(repo, ['**/*.local', '*.local', 'linked', '**'])).toEqual(['a.local'])
  })

  it('rejects patterns that leave the folder or are absolute', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kernel-parent-'))
    await put(parent, { 'secret.env': 's\n' })
    const repo = join(parent, 'repo')
    await mkdir(repo)
    await run('git', ['init', '-q', '-b', 'main', repo])
    await put(repo, { '.gitignore': '*.env\n', 'inside.env': 'i\n' })
    expect(await paths(repo, ['../*.env', `${parent}/*.env`, 'sub/../../*.env', '/*.env'])).toEqual([])
    expect(await paths(repo, ['*.env'])).toEqual(['inside.env'])
    // Exact paths can't leave the folder either.
    expect(await paths(repo, ['../secret.env'])).toEqual([])
  })

  it(`stops at ${MAX_FILES_TO_COPY} files`, async () => {
    const repo = await tempRepo({ '.gitignore': '*.env\n', 'README.md': '' })
    await put(repo, Object.fromEntries(Array.from({ length: MAX_FILES_TO_COPY + 20 }, (_, i) => [`e${String(i).padStart(4, '0')}.env`, ''])))
    const found = await paths(repo, ['*.env'])
    expect(found).toHaveLength(MAX_FILES_TO_COPY)
    expect(found[0]).toBe('e0000.env')
  }, 30000)

  it('gives a folder that is not a git repo its exact paths only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-plain-'))
    await put(dir, { '.env': 'a\n', '.env.local': 'b\n' })
    expect(await paths(dir, ['.env*', '.env'])).toEqual(['.env'])
  })

  it('keeps exact paths as they were: any file there is copied and a missing one is skipped', async () => {
    const repo = await tempRepo({ '.gitignore': '.env.local\n', 'config/app.json': '{}\n' })
    await put(repo, { '.env.local': 'L\n', 'notes.txt': 'untracked, not ignored\n' })
    const wt = await mkdtemp(join(tmpdir(), 'kernel-wt-'))
    expect(await copyLocalFiles(repo, wt, ['.env.local', 'missing.env', 'notes.txt', 'config/app.json', 'config'])).toEqual(['.env.local', 'config/app.json', 'notes.txt'])
    expect(await readFile(join(wt, 'notes.txt'), 'utf8')).toBe('untracked, not ignored\n')
    expect(await paths(repo, [])).toEqual([])
  })
})
