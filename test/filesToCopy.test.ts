import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PushEvent } from '../src/shared/ipc'
import type { ProjectSetupStep } from '../src/shared/types'
import { tempRepo, freePort } from './helpers'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { MAX_FILES_TO_COPY, productionInCopy, resolveFilesToCopy } from '../src/main/services/filesToCopy'
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

  it('gives a folder project inside a parent repo its exact paths only', async () => {
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

describe('Files to copy exclusions and the production warning (KERNEL-449)', () => {
  const PROD = {
    '.env': 'PORT=3000\nDATABASE_URL=postgres://app:hunter2@db.prod.example.com:5432/app\n',
    '.env.local': 'DATABASE_URL=postgres://postgres@localhost:5432/app\n',
    '.env.production': 'NODE_ENV=production\nSTRIPE_SECRET_KEY=sk_live_abc123\n',
    'certs/live.pem': 'sk_live_not_an_env_file\n'
  }

  it('leaves out what [files] exclude names, by exact path or pattern, in the preview and the copy', async () => {
    const repo = await tempRepo({ '.gitignore': '.env*\ncerts/\n', 'README.md': '' })
    await put(repo, PROD)
    expect(await paths(repo, ['.env*', 'certs/*.pem'])).toEqual(['.env', '.env.local', '.env.production', 'certs/live.pem'])
    expect((await resolveFilesToCopy(repo, ['.env*', 'certs/*.pem'], [], ['.env', 'certs/*'])).map((f) => f.path)).toEqual(['.env.local', '.env.production'])
    expect((await resolveFilesToCopy(repo, ['.env', '.env.local'], [], ['./.env.local', ' '])).map((f) => f.path)).toEqual(['.env'])
    const wt = await mkdtemp(join(tmpdir(), 'kernel-wt-'))
    expect((await copyLocalFiles(repo, wt, ['.env*'], ['.env.production'])).copied).toEqual(['.env', '.env.local'])
    expect((await readdir(wt)).sort()).toEqual(['.env', '.env.local'])
  })

  it('names the env files to copy that look like production, by variable, and reads nothing else', async () => {
    const repo = await tempRepo({ '.gitignore': '.env*\ncerts/\n', 'README.md': '' })
    await put(repo, PROD)
    const hints = await productionInCopy(repo, ['.env*', 'certs/*.pem'])
    expect(hints).toEqual([
      { path: '.env', name: 'DATABASE_URL', why: 'remote-database' },
      { path: '.env.production', name: 'STRIPE_SECRET_KEY', why: 'live-key' },
      { path: '.env.production', name: 'NODE_ENV', why: 'production' }
    ])
    expect(JSON.stringify(hints)).not.toMatch(/hunter2|abc123|prod\.example/)
    expect(await productionInCopy(repo, ['.env*'], ['.env', '.env.production'])).toEqual([])
  })

  it('warns in project setup and on Files to copy until the user stops copying the files or keeps them', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt') }))
    const k = new Kernel({ dataDir, home, starterDir: join(__dirname, '..', 'docs', 'starter-agents'), claudeSettingsFile: join(home, 'claude-settings.json') })
    await k.start()
    onTestFinished(() => k.stop({ budgetMs: 0 }))
    const repo = await tempRepo({ '.gitignore': '.env*\ncerts/\n', 'README.md': '', '.kernel/settings.toml': '[files]\ncopy = [".env*"]\n' })
    await put(repo, PROD)
    const steps = new Promise<ProjectSetupStep[]>((resolve) => {
      const on = (e: PushEvent) => { if (e.type === 'project.setup' && !e.steps.some((s) => s.state === 'wait' || s.state === 'run')) { bus.off('push', on); resolve(e.steps) } }
      bus.on('push', on)
    })
    const project = await k.projects.createProject({ source: 'folder', name: 'Prod', from: repo, team: ['kai'], autostart: false })
    expect((await steps).find((s) => s.id === 'copy')).toMatchObject({ state: 'warn', detail: '.env, .env.local, .env.production', production: ['.env', '.env.production'] })

    const h = k.handlers()
    expect(await h['files.production']({ projectId: project.id })).toEqual([
      { path: '.env', name: 'DATABASE_URL', why: 'remote-database' },
      { path: '.env.production', name: 'STRIPE_SECRET_KEY', why: 'live-key' }
    ])
    // One Keep copying covers the whole file, though the banner names one variable of the three.
    await writeFile(join(repo, '.env.production'), 'NODE_ENV=production\nDATABASE_URL=postgres://db.prod.example.com/app\nSTRIPE_SECRET_KEY=sk_live_abc123\n')
    await h['files.keepCopying']({ projectId: project.id, hints: [{ path: '.env.production', name: 'STRIPE_SECRET_KEY', why: 'live-key' }] })
    expect(k.store.project(project.id)?.keepCopying).toEqual(['.env.production:STRIPE_SECRET_KEY', '.env.production:DATABASE_URL', '.env.production:NODE_ENV'])
    expect(await h['files.production']({ projectId: project.id })).toEqual([{ path: '.env', name: 'DATABASE_URL', why: 'remote-database' }])
    // A variable added to a kept file warns again.
    await writeFile(join(repo, '.env.production'), 'NODE_ENV=production\nDATABASE_URL=postgres://db.prod.example.com/app\nSTRIPE_SECRET_KEY=sk_live_abc123\nSTRIPE_RESTRICTED_KEY=rk_live_def456\n')
    expect(await h['files.production']({ projectId: project.id })).toEqual([
      { path: '.env', name: 'DATABASE_URL', why: 'remote-database' },
      { path: '.env.production', name: 'STRIPE_RESTRICTED_KEY', why: 'live-key' }
    ])
    // Don't copy these files saves them to the project's exclusions, so neither the preview nor a new worktree gets them.
    await h['settings.setProject']({ projectId: project.id, patch: { files: { exclude: ['.env', '.env.production'] } } })
    expect(await h['files.production']({ projectId: project.id })).toEqual([])
    expect((await h['files.preview']({ projectId: project.id })).map((f) => f.path)).toEqual(['.env.local'])
  }, 60000)
})

