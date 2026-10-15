import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { loadRepoSettings } from '../src/main/services/settings'
import { convertScriptVariables, MAX_IMPORT_BYTES, suggestScripts } from '../src/main/services/scriptImport'
import { tempRepo, freePort } from './helpers'

// KERNEL-682: Kernel offers a project the scripts Conductor, Superset or its lockfiles ask for, and applies none.

const NONE = { scripts: {}, runScripts: [] }
const tempHome = () => mkdtemp(join(tmpdir(), 'kernel-home-'))
/** What a repo with these files is offered, by a project that runs nothing yet. */
const suggest = async (files: Record<string, string>, home?: string) => suggestScripts(await tempRepo({ 'README.md': '# demo\n', ...files }), NONE, home ?? await tempHome())

describe('convertScriptVariables (KERNEL-682)', () => {
  it('renames every form of a name Kernel has', () => {
    expect(convertScriptVariables('pnpm dev --port $CONDUCTOR_PORT').script).toBe('pnpm dev --port $KERNEL_PORT')
    expect(convertScriptVariables('pnpm dev --port "${CONDUCTOR_PORT:-3000}"').script).toBe('pnpm dev --port "${KERNEL_PORT:-3000}"')
    expect(convertScriptVariables('PORT=$((CONDUCTOR_PORT + 1)) pnpm e2e').script).toBe('PORT=$((KERNEL_PORT + 1)) pnpm e2e')
    expect(convertScriptVariables('echo $(( (CONDUCTOR_PORT + 1) * 2 )) $(($CONDUCTOR_PORT+2))').script).toBe('echo $(( (KERNEL_PORT + 1) * 2 )) $(($KERNEL_PORT+2))')
    expect(convertScriptVariables('cp "$CONDUCTOR_ROOT_PATH/.env" "$CONDUCTOR_WORKSPACE_PATH" # ${CONDUCTOR_WORKSPACE_NAME} on $CONDUCTOR_DEFAULT_BRANCH')).toEqual({
      script: 'cp "$KERNEL_ROOT_PATH/.env" "$KERNEL_WORKSPACE" # ${KERNEL_WORKSPACE_NAME} on $KERNEL_DEFAULT_BRANCH', unknown: [],
      renamed: ['CONDUCTOR_DEFAULT_BRANCH', 'CONDUCTOR_ROOT_PATH', 'CONDUCTOR_WORKSPACE_NAME', 'CONDUCTOR_WORKSPACE_PATH']
    })
    expect(convertScriptVariables('ln -s $SUPERSET_ROOT_PATH/node_modules ${SUPERSET_WORKSPACE_PATH}/node_modules; echo $SUPERSET_WORKSPACE_NAME').script)
      .toBe('ln -s $KERNEL_ROOT_PATH/node_modules ${KERNEL_WORKSPACE}/node_modules; echo $KERNEL_WORKSPACE_NAME')
  })

  it('leaves a longer name alone, and a name outside a variable', () => {
    expect(convertScriptVariables('open $CONDUCTOR_PORTAL ${CONDUCTOR_PORT_BASE} $((CONDUCTOR_PORTS + 1))')).toEqual({
      script: 'open $CONDUCTOR_PORTAL ${CONDUCTOR_PORT_BASE} $((CONDUCTOR_PORTS + 1))', unknown: ['CONDUCTOR_PORTAL', 'CONDUCTOR_PORTS', 'CONDUCTOR_PORT_BASE'], renamed: []
    })
    expect(convertScriptVariables('echo CONDUCTOR_PORT is $MY_CONDUCTOR_PORT')).toEqual({ script: 'echo CONDUCTOR_PORT is $MY_CONDUCTOR_PORT', unknown: [], renamed: [] })
  })

  it("names what Kernel has no variable for, and keeps it as written", () => {
    expect(convertScriptVariables('$CONDUCTOR_BIN_DIR/tool --port $CONDUCTOR_PORT && echo ${SUPERSET_PORT_BASE} $SUPERSET_PORT_BASE')).toEqual({
      script: '$CONDUCTOR_BIN_DIR/tool --port $KERNEL_PORT && echo ${SUPERSET_PORT_BASE} $SUPERSET_PORT_BASE', unknown: ['CONDUCTOR_BIN_DIR', 'SUPERSET_PORT_BASE'], renamed: ['CONDUCTOR_PORT']
    })
  })
})

const CONDUCTOR = `"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

file_include_globs = """
.env*
.vercel/**
"""

[scripts]
setup = '''
pnpm install --frozen-lockfile
cp "$CONDUCTOR_ROOT_PATH/.env" .env
'''
archive = "rm -rf out"
run_mode = "nonconcurrent"

[scripts.run.dev]
available_in = [ "local" ]
command = "pnpm dev --port $CONDUCTOR_PORT"
default = true

[scripts.run.site]
command = "pnpm dev"
args = [ "--port", "$((CONDUCTOR_PORT + 1))" ]
[scripts.run.site.options]
cwd = "site"

[scripts.run.checks]
command = "$CONDUCTOR_BIN_DIR/checks"

[scripts.run.hidden]
command = "echo hidden"
hide = true

[scripts.run.remote]
command = "echo cloud"
available_in = [ "cloud" ]

[scripts.run."not a name"]
command = "echo no"
`

describe('scripts.suggest sources (KERNEL-682)', () => {
  it("reads Conductor's settings.toml: setup and archive, the default run script, the named ones, the run mode and notes", async () => {
    expect(await suggest({ '.conductor/settings.toml': CONDUCTOR })).toEqual([{
      source: 'conductor',
      file: '.conductor/settings.toml',
      patch: {
        scripts: { setup: 'pnpm install --frozen-lockfile\ncp "$KERNEL_ROOT_PATH/.env" .env', run: 'pnpm dev --port $KERNEL_PORT', archive: 'rm -rf out', runMode: 'single' },
        runScripts: { site: 'cd site && pnpm dev --port "$((KERNEL_PORT + 1))"', checks: '$CONDUCTOR_BIN_DIR/checks' }
      },
      notes: [
        'The run script "not a name" is left out, because Kernel can\'t use that name.',
        'Conductor copies .env*, .vercel/** into each workspace. Add them in Files to copy.',
        'Kernel has no variable for $CONDUCTOR_BIN_DIR, so it stays as written.'
      ]
    }])
  })

  it("puts Conductor's settings.local.toml over settings.toml, and takes the only run script or a run string as the project's run", async () => {
    const [both] = await suggest({
      '.conductor/settings.toml': '[scripts]\nsetup = "pnpm install"\narchive = "rm -rf out"\nrun_mode = "concurrent"\n[scripts.run.dev]\ncommand = "pnpm dev"\n',
      '.conductor/settings.local.toml': '[scripts]\nsetup = "pnpm install --frozen-lockfile"\n[scripts.run.dev]\ncommand = "pnpm dev --port $CONDUCTOR_PORT"\n'
    })
    expect(both).toEqual({ source: 'conductor', file: '.conductor/settings.local.toml', patch: { scripts: { setup: 'pnpm install --frozen-lockfile', run: 'pnpm dev --port $KERNEL_PORT', archive: 'rm -rf out', runMode: 'concurrent' } }, notes: [] })
    const [plain] = await suggest({ '.conductor/settings.toml': '[scripts]\nrun = "bin/dev"\n', 'conductor.json': '{"scripts":{"setup":"ignored"}}' })
    expect(plain.patch).toEqual({ scripts: { run: 'bin/dev' } })
  })

  it('reads the legacy conductor.json when the repo has no Conductor TOML', async () => {
    const json = JSON.stringify({ scripts: { setup: 'npm ci', run: 'npm run dev -- --port $CONDUCTOR_PORT', archive: 'rm -rf dist' }, runScriptMode: 'nonconcurrent' })
    expect(await suggest({ 'conductor.json': json })).toEqual([{
      source: 'conductor', file: 'conductor.json', notes: [],
      patch: { scripts: { setup: 'npm ci', run: 'npm run dev -- --port $KERNEL_PORT', archive: 'rm -rf dist', runMode: 'single' } }
    }])
  })

  it("reads Superset's config with a local config around it, and the user's own config over the repo's", async () => {
    const config = JSON.stringify({ setup: ['bun install', 'cp $SUPERSET_ROOT_PATH/.env .env'], teardown: ['docker compose down'], run: ['bun dev'], cwd: 'apps/web' })
    const local = JSON.stringify({ setup: { before: ['nvm use'], after: ['bun db:push'] }, run: ['bun dev --port $SUPERSET_PORT'] })
    expect(await suggest({ '.superset/config.json': config, '.superset/config.local.json': local })).toEqual([{
      source: 'superset',
      file: '.superset/config.json',
      patch: { scripts: {
        setup: 'cd apps/web && nvm use && bun install && cp $KERNEL_ROOT_PATH/.env .env && bun db:push',
        run: 'cd apps/web && bun dev --port $SUPERSET_PORT',
        archive: 'cd apps/web && docker compose down'
      } },
      notes: ['Kernel has no variable for $SUPERSET_PORT, so it stays as written.']
    }])
    const home = await tempHome()
    const repo = await tempRepo({ '.superset/config.json': config })
    await mkdir(join(home, '.superset', 'projects', repo), { recursive: true })
    await writeFile(join(home, '.superset', 'projects', repo, 'config.json'), JSON.stringify({ setup: ['bun install --frozen-lockfile'], cwd: '' }))
    const [mine] = await suggestScripts(repo, NONE, home)
    expect(mine.patch).toEqual({ scripts: { setup: 'bun install --frozen-lockfile', run: 'bun dev', archive: 'docker compose down' } })
  })

  it("falls back to Superset's script files when the repo has no config, and names the variables they read", async () => {
    expect(await suggest({ '.superset/setup.sh': '#!/bin/bash\ncp "$SUPERSET_ROOT_PATH/.env" .env\n', '.superset/run.sh': 'bun dev\n' })).toEqual([{
      source: 'superset', file: '.superset/setup.sh',
      patch: { scripts: { setup: 'bash .superset/setup.sh', run: 'bash .superset/run.sh' } },
      notes: [".superset/setup.sh reads $SUPERSET_ROOT_PATH, which Kernel doesn't set. Change it in the file."]
    }])
    // A config, even an empty one, means the files aren't Superset's scripts.
    expect(await suggest({ '.superset/config.json': '{}', '.superset/setup.sh': 'bun install\n' })).toEqual([])
  })

  it("offers the lockfiles' install as setup and guesses no run script, and offers nothing in a repo with none", async () => {
    expect(await suggest({ 'package.json': '{"scripts":{"dev":"vite"}}', 'pnpm-lock.yaml': '' })).toEqual([{ source: 'detected', file: 'pnpm-lock.yaml', patch: { scripts: { setup: 'pnpm install' } }, notes: [] }])
    expect(await suggest({ Gemfile: '', 'package.json': '{}', 'yarn.lock': '' })).toEqual([{ source: 'detected', file: 'Gemfile, yarn.lock', patch: { scripts: { setup: 'bundle install && yarn install' } }, notes: [] }])
    expect(await suggest({})).toEqual([])
  })

  it('lists every source that has something, Conductor first', async () => {
    const found = await suggest({ '.conductor/settings.toml': '[scripts]\nsetup = "a"\n', '.superset/config.json': '{"setup":["b"]}', 'go.mod': 'module demo\n' })
    expect(found.map((s) => [s.source, s.patch.scripts?.setup])).toEqual([['conductor', 'a'], ['superset', 'b'], ['detected', 'go mod download']])
  })
})

describe('scripts.suggest safety (KERNEL-682)', () => {
  it('reads no file through a link that leaves the repo', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kernel-outside-'))
    await writeFile(join(outside, 'settings.toml'), '[scripts]\nsetup = "cat ~/.ssh/id_rsa"\n')
    await writeFile(join(outside, 'config.json'), '{"setup":["cat ~/.ssh/id_rsa"]}')
    await writeFile(join(outside, 'setup.sh'), 'cat ~/.ssh/id_rsa\n')
    const repo = await tempRepo()
    await mkdir(join(repo, '.conductor'))
    await symlink(join(outside, 'settings.toml'), join(repo, '.conductor', 'settings.toml'))
    // The legacy file doesn't stand in for a TOML file Kernel won't read.
    await writeFile(join(repo, 'conductor.json'), '{"scripts":{"setup":"npm ci"}}')
    await mkdir(join(repo, '.superset'))
    await symlink(join(outside, 'config.json'), join(repo, '.superset', 'config.json'))
    expect(await suggestScripts(repo, NONE, await tempHome())).toEqual([])
    // A whole folder linked out, and a script file linked out.
    const linked = await tempRepo()
    await symlink(outside, join(linked, '.conductor'))
    await mkdir(join(linked, '.superset'))
    await symlink(join(outside, 'setup.sh'), join(linked, '.superset', 'setup.sh'))
    expect(await suggestScripts(linked, NONE, await tempHome())).toEqual([])
    // A link that stays inside the repo reads like the file it points at.
    const inside = await tempRepo({ 'tools/conductor.toml': '[scripts]\nsetup = "make"\n' })
    await mkdir(join(inside, '.conductor'))
    await symlink(join(inside, 'tools', 'conductor.toml'), join(inside, '.conductor', 'settings.toml'))
    expect((await suggestScripts(inside, NONE, await tempHome())).map((s) => s.patch)).toEqual([{ scripts: { setup: 'make' } }])
  })

  it('offers nothing from a file that is too big, a folder, or text that does not parse', async () => {
    const big = `[scripts]\nsetup = "make"\n# ${'x'.repeat(MAX_IMPORT_BYTES)}\n`
    expect(await suggest({ '.conductor/settings.toml': big })).toEqual([])
    expect(await suggest({ '.conductor/settings.toml/keep': '' })).toEqual([])
    expect(await suggest({ '.conductor/settings.toml': '[scripts\nsetup = ' })).toEqual([])
    expect(await suggest({ '.conductor/settings.toml': '[scripts]\nsetup = "make"\n', '.conductor/settings.local.toml': 'not = = toml' })).toEqual([])
    expect(await suggest({ 'conductor.json': '{"scripts":' })).toEqual([])
    expect(await suggest({ 'conductor.json': '["scripts"]' })).toEqual([])
    expect(await suggest({ '.superset/config.json': '{"setup":["bun install"]', '.superset/setup.sh': 'bun install\n' })).toEqual([])
    expect(await suggest({ '.superset/config.json': '{"setup":["bun install"]}', '.superset/config.local.json': '{' })).toEqual([])
    // Values of the wrong kind are skipped, not thrown on.
    expect(await suggest({ '.conductor/settings.toml': 'scripts = 3\n' })).toEqual([])
    expect(await suggest({ '.conductor/settings.toml': '[scripts]\nsetup = 3\nrun = ["a"]\n[scripts.run_mode]\nx = 1\n' })).toEqual([])
    expect(await suggest({ '.superset/config.json': '{"setup":"bun install","run":[1,null,{}]}' })).toEqual([])
    // One broken source leaves the others.
    expect((await suggest({ '.conductor/settings.toml': '[scripts', 'pnpm-lock.yaml': '' })).map((s) => s.source)).toEqual(['detected'])
  })

  it('leaves out a suggestion for what the project already runs', async () => {
    const repo = await tempRepo({
      '.conductor/settings.toml': '[scripts]\nsetup = "pnpm install"\n[scripts.run.dev]\ncommand = "pnpm dev --port $CONDUCTOR_PORT"\ndefault = true\n[scripts.run.site]\ncommand = "pnpm site"\n',
      'pnpm-lock.yaml': '',
      '.kernel/settings.toml': '[scripts]\nsetup = "pnpm install"\n'
    })
    const home = await tempHome()
    // The lockfile's install is the project's setup already. Conductor still has run scripts to offer.
    expect((await suggestScripts(repo, await loadRepoSettings(repo), home)).map((s) => s.source)).toEqual(['conductor'])
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[scripts]\nrun = "pnpm dev --port $KERNEL_PORT"\n[run_scripts]\nsite = "pnpm site"\n')
    expect(await suggestScripts(repo, await loadRepoSettings(repo), home)).toEqual([])
    // A script the project has under another command is the project's own, and stays out too (KERNEL-707).
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[scripts]\nrun = "my dev"\n[run_scripts]\nsite = "pnpm site --watch"\n')
    expect(await suggestScripts(repo, await loadRepoSettings(repo), home)).toEqual([])
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[scripts]\nrun = "my dev"\n')
    expect((await suggestScripts(repo, await loadRepoSettings(repo), home)).map((s) => s.patch)).toEqual([{ runScripts: { site: 'pnpm site' } }])
  })
})

describe('scripts.suggest in a project (KERNEL-682)', () => {
  async function projectWith(files: Record<string, string>) {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
      ...files
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await tempHome()
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop({ budgetMs: 0 }))
    k.sessions.send = async () => ({ queued: false })
    return { k, repo, project: await k.addProject(repo) }
  }

  it('answers the channel without writing a file, and a saved suggestion is not offered again', async () => {
    const { k, repo, project } = await projectWith({ 'conductor.json': '{"scripts":{"setup":"echo one > one.txt"}}' })
    const h = k.handlers()
    const [found] = await h['scripts.suggest']({ projectId: project.id })
    expect(found).toMatchObject({ source: 'conductor', file: 'conductor.json', patch: { scripts: { setup: 'echo one > one.txt' } } })
    await expect(readFile(join(repo, '.kernel', 'settings.local.toml'), 'utf8')).rejects.toThrow()
    expect((await loadRepoSettings(repo)).scripts.setup).toBeUndefined()
    await h['settings.setProject']({ projectId: project.id, patch: found.patch })
    expect(await h['scripts.suggest']({ projectId: project.id })).toEqual([])
  })

  it('runs a setup script of several lines, saved through settings.setProject, in a new workspace', async () => {
    const toml = `[scripts]\nsetup = '''\n# Conductor's setup, line by line.\necho "$CONDUCTOR_WORKSPACE_NAME" > name.txt\nif [ -d "$CONDUCTOR_ROOT_PATH" ]; then\n  echo "port $((CONDUCTOR_PORT + 1))" > port.txt\nfi\n'''\n`
    const { k, project } = await projectWith({ '.conductor/settings.toml': toml })
    const h = k.handlers()
    const [found] = await h['scripts.suggest']({ projectId: project.id })
    expect(found.patch.scripts?.setup?.split('\n')).toHaveLength(5)
    const saved = await h['settings.setProject']({ projectId: project.id, patch: found.patch })
    expect(saved.scripts.setup).toBe(found.patch.scripts!.setup)
    expect(saved.sources['scripts.setup']).toBe('local')
    // The user's own file, so the script runs without a trust prompt.
    expect(await h['projects.scriptTrust']({ projectId: project.id })).toBeNull()
    const ws = await k.workspaces.createWorkspace(project.id, { prompt: 'Build it', agentId: 'kai', title: 'Build' })
    expect(ws.status).toBe('ready')
    expect(await readFile(join(ws.path, 'name.txt'), 'utf8')).toBe(`${ws.name}\n`)
    expect(await readFile(join(ws.path, 'port.txt'), 'utf8')).toBe(`port ${ws.port + 1}\n`)
  })
})
