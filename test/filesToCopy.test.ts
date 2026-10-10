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
    expect((await copyLocalFiles(repo, wt, ['.env*'])).copied).toEqual(['.env', '.env.local'])
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

  it('reaches into a wholly ignored folder when a pattern names it, and only then', async () => {
    const repo = await tempRepo({ '.gitignore': 'secrets/\n.vercel\ncerts/\n', 'README.md': '' })
    await put(repo, {
      'secrets/prod.env': 'p\n', 'secrets/dev.env': 'd\n', 'secrets/notes.txt': 'n\n', 'secrets/old/legacy.env': 'l\n',
      '.vercel/project.json': '{}\n', 'certs/local.pem': 'c\n', 'certs/node_modules/dep.pem': 'no\n'
    })
    expect(await paths(repo, ['secrets/*.env'])).toEqual(['secrets/dev.env', 'secrets/prod.env'])
    expect(await paths(repo, ['secrets/**/*.env', 'secrets/old/*.env'])).toEqual(['secrets/dev.env', 'secrets/old/legacy.env', 'secrets/prod.env'])
    expect(await paths(repo, ['.vercel/*.json', 'certs/**/*.pem'])).toEqual(['.vercel/project.json', 'certs/local.pem'])
    // A pattern that doesn't name the folder never walks it.
    expect(await paths(repo, ['**/*.env', '*/*.json', '**/*.pem'])).toEqual([])
  })

  it('never expands node_modules or .git, even when a pattern names them', async () => {
    const repo = await tempRepo({ '.gitignore': 'node_modules/\n', 'README.md': '' })
    await put(repo, { 'node_modules/index.js': '', 'node_modules/pkg/main.js': '' })
    expect(await paths(repo, ['node_modules/*.js', 'node_modules/**/*.js', '.git/*'])).toEqual([])
  })

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
    // Exact paths can't leave the folder either, and a leading slash reads as relative, as it always did.
    expect(await paths(repo, ['../secret.env'])).toEqual([])
    expect(await paths(repo, ['/inside.env'])).toEqual(['inside.env'])
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

  it('gives a folder room inside a parent repo its exact paths only', async () => {
    const parent = await tempRepo({ '.gitignore': '*.env\n', 'app/index.ts': '' })
    await put(parent, { 'app/local.env': 'a\n' })
    expect(await paths(join(parent, 'app'), ['*.env'])).toEqual([])
    expect(await paths(join(parent, 'app'), ['local.env'])).toEqual(['local.env'])
  })

  it('keeps exact paths as they were: any file there is copied and a missing one is skipped', async () => {
    const repo = await tempRepo({ '.gitignore': '.env.local\n', 'config/app.json': '{}\n' })
    await put(repo, { '.env.local': 'L\n', 'notes.txt': 'untracked, not ignored\n' })
    const wt = await mkdtemp(join(tmpdir(), 'kernel-wt-'))
    expect((await copyLocalFiles(repo, wt, ['.env.local', 'missing.env', 'notes.txt', 'config/app.json', 'config'])).copied).toEqual(['.env.local', 'config/app.json', 'notes.txt'])
    expect(await readFile(join(wt, 'notes.txt'), 'utf8')).toBe('untracked, not ignored\n')
    expect(await paths(repo, [])).toEqual([])
    // Nothing under .git, so the preview always equals the copy.
    expect(await paths(repo, ['.git/config', '.git/HEAD'])).toEqual([])
  })

  it('follows a symlink for an exact path inside the repo, refuses one that points out, and skips one a pattern matches', async () => {
    const repo = await tempRepo({ '.gitignore': '.env*\nshared/\n', 'README.md': '' })
    await put(repo, { 'shared/.env': 'SHARED=1\n' })
    await symlink(join(repo, 'shared/.env'), join(repo, '.env'))
    await symlink(join(repo, 'shared/.env'), join(repo, '.env.local'))
    expect(await paths(repo, ['.env*'])).toEqual([])
    expect(await resolveFilesToCopy(repo, ['.env', '.env*'])).toEqual([{ path: '.env', size: 9 }])
    const wt = await mkdtemp(join(tmpdir(), 'kernel-wt-'))
    await copyLocalFiles(repo, wt, ['.env'])
    expect(await readFile(join(wt, '.env'), 'utf8')).toBe('SHARED=1\n')
    // A link to a file outside the repo, shared between clones or not, is refused (KERNEL-209).
    const outside = await mkdtemp(join(tmpdir(), 'kernel-shared-'))
    await put(outside, { '.env': 'SHARED=1\n' })
    const linked = await tempRepo({ '.gitignore': '.env*\n', 'README.md': '' })
    await symlink(join(outside, '.env'), join(linked, '.env'))
    const refused: string[] = []
    expect(await resolveFilesToCopy(linked, ['.env'], refused)).toEqual([])
    expect(refused).toEqual(['.env'])
  })
})
