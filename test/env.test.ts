import { describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { tempRepo, freePort } from './helpers'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { buildEnv, envFileReadable, EnvStore, kernelVars, MAX_ENV_FILE, productionHints, productionWhy, readEnvFiles, withoutClaudeNames, type Cipher } from '../src/main/services/env'
import { isClaudeVar, workspaceSlug } from '../src/shared/kernelVars'
import { sessionEnv } from '../src/main/services/sessions'
import { run } from '../src/main/services/exec'

/** Stands in for safeStorage, which doesn't work under ELECTRON_RUN_AS_NODE. Its output never holds the text it was given. */
const fakeCipher: Cipher = {
  encrypt: (text) => `enc:${Buffer.from([...text].reverse().join(''), 'utf8').toString('hex')}`,
  decrypt: (data) => [...Buffer.from(data.slice('enc:'.length), 'hex').toString('utf8')].reverse().join('')
}

const until = async (ok: () => boolean, ms = 8000) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) } }

describe('buildEnv', () => {
  it('layers the Mac, the app, the env files in order, the project, then Kernel, the later winning', () => {
    const env = buildEnv({
      base: { A: 'mac', B: 'mac', C: 'mac', D: 'mac', E: 'mac', F: 'mac', GONE: undefined },
      app: { B: 'app', C: 'app', D: 'app', E: 'app', F: 'app' },
      files: [{ C: 'file1', D: 'file1', E: 'file1', F: 'file1' }, { D: 'file2', E: 'file2', F: 'file2' }],
      project: { E: 'project', F: 'project' },
      kernel: { F: 'kernel' }
    })
    expect(env).toEqual({ A: 'mac', B: 'app', C: 'file1', D: 'file2', E: 'project', F: 'kernel' })
  })
})

describe('withoutClaudeNames', () => {
  it('drops exactly the names the Environment page says chats and terminals ignore', () => {
    const names = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC', 'MY_ANTHROPIC_KEY', 'claude_code_x', 'NODE_OPTIONS']
    const kept = withoutClaudeNames(Object.fromEntries(names.map((n) => [n, 'v'])))
    for (const n of names) expect(n in kept, n).toBe(!isClaudeVar(n))
    expect(Object.keys(kept)).toEqual(['ANTHROPIC', 'MY_ANTHROPIC_KEY', 'claude_code_x', 'NODE_OPTIONS'])
  })
})

describe('readEnvFiles', () => {
  it('reads regular files inside the folder only, so a project\'s settings can\'t pull in the rest of the Mac or stall it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kernel-outside-'))
    await writeFile(join(outside, 'secrets.env'), 'STOLEN=1\n')
    const dir = await mkdtemp(join(tmpdir(), 'kernel-ws-'))
    await mkdir(join(dir, 'apps'))
    await writeFile(join(dir, 'apps', '.env'), 'OK=1\n')
    // A link that stays inside the folder is followed: people link one shared .env.
    await symlink(join(dir, 'apps', '.env'), join(dir, 'shared.env'))
    await symlink(join(outside, 'secrets.env'), join(dir, 'linked.env'))
    await writeFile(join(dir, 'big.env'), `BIG=${'x'.repeat(MAX_ENV_FILE)}\n`)
    // Reading a FIFO with no writer would block the main process for good.
    execFileSync('mkfifo', [join(dir, 'pipe.env')])
    const paths = {
      'apps/.env': false,
      'shared.env': false,
      [join(outside, 'secrets.env')]: true,
      [relative(dir, join(outside, 'secrets.env'))]: true,
      '../outside.env': true,
      '/etc/hosts': true,
      'linked.env': true,
      'big.env': true,
      'pipe.env': true,
      'apps': true,
      'nope.env': true
    }
    const read = readEnvFiles(dir, Object.keys(paths))
    expect(Object.fromEntries(read.map((f) => [f.path, f.missing]))).toEqual(paths)
    expect(read.filter((f) => !f.missing).map((f) => f.vars)).toEqual([{ OK: '1' }, { OK: '1' }])
    expect(read.filter((f) => f.missing).every((f) => !Object.keys(f.vars).length)).toBe(true)
    // env.get's check agrees, and reads nothing.
    for (const [path, missing] of Object.entries(paths)) expect(envFileReadable(dir, path), path).toBe(!missing)
  })
})

describe('EnvStore', () => {
  it('keeps values encrypted on disk, reads them back, and deletes on null', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-env-')), 'env.json')
    const store = new EnvStore({ file, cipher: fakeCipher })
    store.set(undefined, 'API_TOKEN', 'tok-app-123')
    store.set('project-1', 'DATABASE_URL', 'postgres://secret-host/db')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('API_TOKEN')
    expect(text).not.toContain('tok-app-123')
    expect(text).not.toContain('secret-host')

    const again = new EnvStore({ file, cipher: fakeCipher })
    expect(again.names()).toEqual(['API_TOKEN'])
    expect(again.names('project-1')).toEqual(['DATABASE_URL'])
    expect(again.reveal('project-1', 'DATABASE_URL')).toBe('postgres://secret-host/db')
    expect(again.values()).toEqual({ API_TOKEN: 'tok-app-123' })
    expect(() => again.reveal('project-1', 'API_TOKEN')).toThrow('no variable named API_TOKEN')
    expect(() => again.reveal(undefined, 'toString')).toThrow('no variable named toString')

    // A value this Mac can't decrypt keeps its name, stays out of the environment, and can't be shown.
    const broken = new EnvStore({ file, cipher: { ...fakeCipher, decrypt: (d) => { if (d === JSON.parse(readFileSync(file, 'utf8')).app.API_TOKEN) throw new Error('bad key'); return fakeCipher.decrypt(d) } } })
    expect(broken.names()).toEqual(['API_TOKEN'])
    expect(broken.values()).toEqual({})
    expect(() => broken.reveal(undefined, 'API_TOKEN')).toThrow('can\'t decrypt API_TOKEN')
    expect(() => new EnvStore({ file }).reveal(undefined, 'API_TOKEN')).toThrow('Keychain isn\'t available')

    again.set('project-1', 'DATABASE_URL', null)
    expect(again.names('project-1')).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).rooms).toEqual({})
    again.dropProject('project-1')
  })

  it('rejects bad names and Kernel\'s own, and saves nothing without a cipher', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-env-')), 'env.json')
    const store = new EnvStore({ file, cipher: fakeCipher })
    for (const bad of ['', '1ABC', 'MY-VAR', 'A B', 'É', '__proto__', 'constructor', 'prototype']) expect(() => store.set(undefined, bad, 'x')).toThrow('not a valid variable name')
    for (const own of ['KERNEL_PORT', 'KERNEL_WORKSPACE_ID', 'KERNEL_WORKSPACE', 'KERNEL_ROOT_PATH']) expect(() => store.set(undefined, own, 'x')).toThrow('Kernel\'s own')
    store.set(undefined, '_ok_9', 'fine')
    expect(store.names()).toEqual(['_ok_9'])

    const plainFile = join(await mkdtemp(join(tmpdir(), 'kernel-env-')), 'env.json')
    const none = new EnvStore({ file: plainFile })
    expect(() => none.set(undefined, 'TOKEN', 'plain-value')).toThrow('can\'t encrypt')
    expect(existsSync(plainFile)).toBe(false)
  })

  it('moves a file it can\'t read aside, keeps its bytes, and starts empty instead of writing over it', async () => {
    for (const bad of ['{not json', '{"app":["A"],"rooms":{}}', '{"app":{},"rooms":{"r":"x"}}', '[]']) {
      const dir = await mkdtemp(join(tmpdir(), 'kernel-env-'))
      const file = join(dir, 'env.json')
      await writeFile(file, bad)
      const moved: string[] = []
      const store = new EnvStore({ file, cipher: fakeCipher, onSetAside: (f) => moved.push(f) })
      expect(store.names()).toEqual([])
      expect(moved).toHaveLength(1)
      expect(moved[0]).toMatch(/^env\.json\.corrupt-/)
      expect(readFileSync(join(dir, moved[0]), 'utf8')).toBe(bad)
      store.set(undefined, 'FRESH', 'v')
      expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).app)).toEqual(['FRESH'])
      expect(readdirSync(dir).sort()).toEqual(['env.json', moved[0]])
    }
    // A missing file is just empty, with nothing moved.
    const moved: string[] = []
    expect(new EnvStore({ file: join(await mkdtemp(join(tmpdir(), 'kernel-env-')), 'env.json'), onSetAside: (f) => moved.push(f) }).names()).toEqual([])
    expect(moved).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)('leaves a file it can\'t open where it is, refuses to write over it, and reads it once it can', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-env-'))
    const file = join(dir, 'env.json')
    new EnvStore({ file, cipher: fakeCipher }).set(undefined, 'KEPT', 'v')
    const before = readFileSync(file, 'utf8')
    await chmod(file, 0o000)
    const moved: string[] = []
    const store = new EnvStore({ file, cipher: fakeCipher, onSetAside: (f) => moved.push(f) })
    try {
      expect(store.names()).toEqual([])
      expect(() => store.set(undefined, 'NEW', 'x')).toThrow('won\'t write over it')
      expect(() => store.set(undefined, 'KEPT', null)).toThrow('won\'t write over it')
      expect(moved).toEqual([])
      expect(readdirSync(dir)).toEqual(['env.json'])
    } finally { await chmod(file, 0o600) }
    expect(readFileSync(file, 'utf8')).toBe(before)
    // Nothing unreadable was cached, so the next read finds the variable.
    expect(store.names()).toEqual(['KEPT'])
    expect(store.reveal(undefined, 'KEPT')).toBe('v')
  })

  it('saves the file readable by the user only, even over a leftover temp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-env-'))
    const file = join(dir, 'env.json')
    await writeFile(`${file}.tmp`, 'left by a crash', { mode: 0o644 })
    new EnvStore({ file, cipher: fakeCipher }).set(undefined, 'A', 'v')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('Kernel env', () => {
  it('gives scripts, big terminals and sessions the project\'s variables and env files, and keeps values out of logs', async () => {
    const repo = await tempRepo({
      'README.md': '# env\n',
      '.env.shared': 'FROM_FILE=one\nOVERRIDDEN=file\nANTHROPIC_BASE_URL=https://proxy.example\nCLAUDE_CODE_USE_BEDROCK=1\nCLAUDE_CODE_AUTO_COMPACT_WINDOW=50000\n',
      '.env.later': 'OVERRIDDEN=later-file\n',
      '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.',
      '.kernel/settings.toml': [
        '[scripts]',
        'setup = "echo \\"$PROJECT_SECRET|$APP_ONLY|$FROM_FILE|$OVERRIDDEN|$KERNEL_WORKSPACE_ID|$PORT|$FORCE_COLOR\\" > seen.txt"',
        'archive = "echo \\"archive=$PROJECT_SECRET\\" > \\"$KERNEL_ROOT_PATH/archive.txt\\""',
        '[run_scripts]',
        'web = "echo \\"web=$PROJECT_SECRET|$ANTHROPIC_BASE_URL\\" > run.txt"',
        '[env]',
        'files = [".env.shared", ".env.missing", ".env.later", "../outside.env"]',
        ''
      ].join('\n')
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', leadWaitForSetup: true } }))
    const logged: unknown[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => { logged.push(...a) }))
    const k = new Kernel({ dataDir, home, cipher: fakeCipher })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const h = k.handlers()
    const project = await k.addProject(repo)

    await h['env.set']({ name: 'APP_ONLY', value: 'app-value-77' })
    await h['env.set']({ name: 'ANTHROPIC_API_KEY', value: 'sk-user-key' })
    await h['env.set']({ projectId: project.id, name: 'PROJECT_SECRET', value: 'project-secret-42' })
    await h['env.set']({ projectId: project.id, name: 'OVERRIDDEN', value: 'project' })
    await h['env.set']({ projectId: project.id, name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'other-account' })
    await h['env.set']({ projectId: project.id, name: 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', value: '0' })
    await expect(h['env.set']({ projectId: project.id, name: 'KERNEL_PORT', value: '1' })).rejects.toThrow('Kernel\'s own')
    expect(await h['env.get']({ projectId: project.id })).toEqual({
      names: ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'CLAUDE_CODE_OAUTH_TOKEN', 'OVERRIDDEN', 'PROJECT_SECRET'],
      files: [{ path: '.env.shared', missing: false }, { path: '.env.missing', missing: true }, { path: '.env.later', missing: false }, { path: '../outside.env', missing: true }]
    })
    expect(await h['env.get']({})).toEqual({ names: ['ANTHROPIC_API_KEY', 'APP_ONLY'], files: [] })
    expect(await h['env.reveal']({ projectId: project.id, name: 'PROJECT_SECRET' })).toBe('project-secret-42')
    expect((await h['settings.project']({ projectId: project.id })).env).toEqual({ files: ['.env.shared', '.env.missing', '.env.later', '../outside.env'] })

    // The setup script writes what it saw. The project's variable wins over both files, and the missing file is skipped.
    const ws = await k.createWorkspace(project.id, { prompt: 'go', agentId: 'christian', title: 'Env' })
    expect(ws.status).toBe('ready')
    expect((await readFile(join(ws.path, 'seen.txt'), 'utf8')).trim()).toBe(`project-secret-42|app-value-77|one|project|${ws.id}|${ws.port}|${process.env.FORCE_COLOR ?? ''}`)

    // Sessions get the same set as scripts, less the API key and the script-only variables.
    const session = sessionEnv(k.envFor(ws), {})
    expect(session).toMatchObject({ PROJECT_SECRET: 'project-secret-42', KERNEL_PORT: String(ws.port), KERNEL_WORKSPACE: ws.path, KERNEL_ROOT_PATH: project.path })
    expect(session.ANTHROPIC_API_KEY).toBeUndefined()
    expect(session.FORCE_COLOR).toBe(process.env.FORCE_COLOR)
    expect(k.envFor(ws, { script: true }).ANTHROPIC_API_KEY).toBe('sk-user-key')
    // The build that started them, which the hook command sends, whatever the Mac exports (KERNEL-675).
    expect([k.env.envFor(ws).KERNEL_BUILD, k.env.envFor(ws, { script: true }).KERNEL_BUILD]).toEqual(['app', 'app'])

    // Sessions and terminals take Claude Code's endpoint, account and billing names from the Mac only. Scripts get them all.
    const mac = { base: process.env.ANTHROPIC_BASE_URL, bedrock: process.env.CLAUDE_CODE_USE_BEDROCK, teams: process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS }
    process.env.ANTHROPIC_BASE_URL = 'https://mac.example'
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = 'mac'
    try {
      const own = sessionEnv(k.envFor(ws), {})
      expect(own.ANTHROPIC_BASE_URL).toBe('https://mac.example')
      expect(own.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
      expect(own.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(own.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('mac')
      expect(sessionEnv(k.envFor(ws), {}, { agentTeams: true }).CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
      expect(sessionEnv(k.envFor(ws), {}, { agentTeams: false }).CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
      // A project's compact window never reaches a session. Only the Mac's does.
      expect(own.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
      // Nor does it move the window the chat's role sets (feat-compact-window-per-role-with-plan).
      expect(sessionEnv(k.envFor(ws), {}, { compact: '200k' }).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000')
      expect(sessionEnv(k.envFor(ws), {}, { compact: 'full' }).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
      // Sessions get the CLI's Artifact tools unless the Mac turns them off (KERNEL-795).
      expect(sessionEnv({}, {}).CLAUDE_CODE_ARTIFACT).toBe('1')
      expect(sessionEnv({ CLAUDE_CODE_ARTIFACT: '0' }, {}).CLAUDE_CODE_ARTIFACT).toBe('0')
      expect(k.envFor(ws, { script: true })).toMatchObject({ ANTHROPIC_BASE_URL: 'https://proxy.example', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'other-account' })
    } finally {
      for (const [k2, v] of [['ANTHROPIC_BASE_URL', mac.base], ['CLAUDE_CODE_USE_BEDROCK', mac.bedrock], ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', mac.teams]] as const) {
        if (v === undefined) delete process.env[k2]
        else process.env[k2] = v
      }
    }

    // A named run script gets the project's variable, and the env file's proxy, since scripts get every layer.
    let ran = false
    const onExit = (e: { type: string; workspaceId?: string; name?: string }) => { if (e.type === 'script.exit' && e.workspaceId === ws.id && e.name === 'web') ran = true }
    bus.on('push', onExit)
    await h['scripts.run']({ workspaceId: ws.id, kind: 'run', name: 'web' })
    await until(() => ran)
    bus.off('push', onExit)
    expect((await readFile(join(ws.path, 'run.txt'), 'utf8')).trim()).toBe('web=project-secret-42|https://proxy.example')

    // A big terminal's shell sees the project's variable. `claude` isn't typed in, so the test reads a plain prompt.
    const start = k.ptys.start.bind(k.ptys)
    k.ptys.start = (id, o) => start(id, { ...o, command: undefined })
    const term = await h['chats.create']({ workspaceId: ws.id, kind: 'terminal' })
    let out = ''
    const on = (e: { type: string; chatId?: string; data?: string }) => { if (e.type === 'terminal.data' && e.chatId === term.id) out += e.data }
    bus.on('push', on)
    await h['terminal.write']({ chatId: term.id, data: 'echo "seen=$PROJECT_SECRET key=${ANTHROPIC_API_KEY:-none}"\r' })
    await until(() => out.includes('seen=project-secret-42 key=none'))
    await h['terminal.write']({ chatId: term.id, data: 'echo "oauth=${CLAUDE_CODE_OAUTH_TOKEN:-none} bedrock=${CLAUDE_CODE_USE_BEDROCK:-none}"\r' })
    await until(() => out.includes('oauth=none bedrock=none'))
    bus.off('push', on)
    await h['chats.close']({ chatId: term.id })

    // The archive script gets the project's variable too. The worktree goes, so it writes to the main checkout.
    await k.archiveWorkspace(ws.id, true)
    await k.archive.cleanedUp(ws.id)
    expect((await readFile(join(project.path, 'archive.txt'), 'utf8')).trim()).toBe('archive=project-secret-42')

    // No value reaches the data folder in plain text, the activity log, its export, or the console.
    const values = ['app-value-77', 'sk-user-key', 'project-secret-42', 'other-account']
    const exported = await readFile((await h['app.exportLogs']()).path, 'utf8')
    const activity = JSON.stringify(k.store.activity(undefined, 5000))
    await k.stop()
    for (const s of spies) s.mockRestore()
    const envJson = readFileSync(join(dataDir, 'env.json'), 'utf8')
    const db = readFileSync(join(dataDir, 'kernel.db')).toString('latin1')
    for (const v of values) {
      expect(envJson).not.toContain(v)
      expect(db).not.toContain(v)
      expect(activity).not.toContain(v)
      expect(exported).not.toContain(v)
      expect(JSON.stringify(logged.map(String))).not.toContain(v)
    }
  })

  it('logs one note naming the file when it moves an unreadable env.json aside', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    await writeFile(join(dataDir, 'env.json'), '{"app": {"A": "enc:61"')
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')), cipher: fakeCipher })
    expect(await k.handlers()['env.get']({})).toEqual({ names: [], files: [] })
    const moved = readdirSync(dataDir).find((f) => f.startsWith('env.json.corrupt-'))
    expect(moved).toBeDefined()
    expect(readFileSync(join(dataDir, moved!), 'utf8')).toBe('{"app": {"A": "enc:61"')
    const notes = k.store.activity(undefined, 50).filter((e) => e.object === moved)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'note', actor: 'kernel' })
    await k.stop()
  })

  it('reads the repo\'s env files list, and a file a commit adds, with no trust step (KERNEL-913)', async () => {
    const repo = await tempRepo({
      'README.md': '# env\n',
      '.env.a': 'A=1\n',
      '.env.b': 'B=1\n',
      '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.',
      '.kernel/settings.toml': '[env]\nfiles = [".env.a"]\n'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', leadWaitForSetup: true } }))
    const k = new Kernel({ dataDir, home, cipher: fakeCipher })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const project = await k.addProject(repo)
    const ws = await k.createWorkspace(project.id, { prompt: 'go', agentId: 'christian', title: 'Env' })
    expect(ws.status).toBe('ready')
    expect(k.envFor(ws)).toMatchObject({ A: '1' })

    await writeFile(join(repo, '.kernel/settings.toml'), '[env]\nfiles = [".env.a", ".env.b"]\n')
    expect(k.envFor(ws)).toMatchObject({ A: '1', B: '1' })
    await k.stop()
  })

  it('removing a project removes its variables', async () => {
    const repo = await tempRepo()
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')), cipher: fakeCipher })
    const project = await k.addProject(repo)
    await k.handlers()['env.set']({ projectId: project.id, name: 'GONE_SOON', value: 'v' })
    await k.removeProject(project.id, false)
    expect(JSON.parse(readFileSync(join(dataDir, 'env.json'), 'utf8')).rooms).toEqual({})
    await k.stop()
  })
})

describe('Kernel variables in values (KERNEL-449)', () => {
  it("fills in ${KERNEL_*} in what the user wrote, with Kernel's own names only and no shell expansion", () => {
    const kernel = { KERNEL_PORT: '4100', KERNEL_WORKSPACE_ID: 'ws-1', KERNEL_WORKSPACE_SLUG: 'fix_login_ab12cd' }
    const env = buildEnv({
      base: { MAC: '${KERNEL_PORT}' },
      app: { WEB: 'http://localhost:${KERNEL_PORT}/' },
      files: [{ DATABASE_URL: 'postgres://localhost:5432/app_${KERNEL_WORKSPACE_SLUG}', BARE: '$KERNEL_PORT', OTHER: '${HOME}', NOPE: '${KERNEL_NOPE}', SETUP_ONLY: '${KERNEL_ENV}', CMD: '$(whoami) `id`' }],
      project: { BOTH: '${KERNEL_WORKSPACE_ID}-${KERNEL_PORT}' },
      setup: { FROM_SETUP: 'db_${KERNEL_WORKSPACE_SLUG}' },
      kernel
    })
    expect(env).toMatchObject({
      MAC: '${KERNEL_PORT}', WEB: 'http://localhost:4100/', DATABASE_URL: 'postgres://localhost:5432/app_fix_login_ab12cd', BARE: '$KERNEL_PORT',
      OTHER: '${HOME}', NOPE: '${KERNEL_NOPE}', SETUP_ONLY: '${KERNEL_ENV}', CMD: '$(whoami) `id`', BOTH: 'ws-1-4100', FROM_SETUP: 'db_fix_login_ab12cd'
    })
  })

  it("puts Kernel's defaults under every layer, so the Mac's environment or the user's variable wins", () => {
    const defaults = { COMPOSE_PROJECT_NAME: 'fix_login_ab12cd' }
    expect(buildEnv({ base: {}, defaults, kernel: {} }).COMPOSE_PROJECT_NAME).toBe('fix_login_ab12cd')
    expect(buildEnv({ base: { COMPOSE_PROJECT_NAME: 'mac' }, defaults, kernel: {} }).COMPOSE_PROJECT_NAME).toBe('mac')
    expect(buildEnv({ base: {}, defaults, files: [{ COMPOSE_PROJECT_NAME: 'file' }], kernel: {} }).COMPOSE_PROJECT_NAME).toBe('file')
    expect(buildEnv({ base: {}, defaults, setup: { COMPOSE_PROJECT_NAME: 'setup' }, kernel: {} }).COMPOSE_PROJECT_NAME).toBe('setup')
  })

  it("drops what a parent Kernel workspace left in the Mac's environment, so the workspace's own names win (KERNEL-710)", () => {
    const parent = { KERNEL_WORKSPACE_SLUG: 'kernel_9d0ef99c6011', KERNEL_PORT: '4530', KERNEL_ENV: '/tmp/parent.env', COMPOSE_PROJECT_NAME: 'kernel_9d0ef99c6011', DATABASE_URL: 'postgres://localhost:5432/app_kernel_9d0ef99c6011', HOME: '/Users/me' }
    const kernel = { KERNEL_WORKSPACE_SLUG: 'kernel_8f8933709953', KERNEL_PORT: '4100' }
    const env = buildEnv({ base: parent, defaults: { COMPOSE_PROJECT_NAME: kernel.KERNEL_WORKSPACE_SLUG }, kernel })
    expect(env).toMatchObject({ COMPOSE_PROJECT_NAME: 'kernel_8f8933709953', KERNEL_PORT: '4100', HOME: '/Users/me' })
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.KERNEL_ENV).toBeUndefined()
    // The workspace's own database URL fills in its own slug, and a name the user set on the Mac still wins over the default.
    expect(buildEnv({ base: parent, files: [{ DATABASE_URL: 'postgres://localhost:5432/app_${KERNEL_WORKSPACE_SLUG}' }], kernel }).DATABASE_URL).toBe('postgres://localhost:5432/app_kernel_8f8933709953')
    expect(buildEnv({ base: { ...parent, COMPOSE_PROJECT_NAME: 'mac' }, defaults: { COMPOSE_PROJECT_NAME: kernel.KERNEL_WORKSPACE_SLUG }, kernel }).COMPOSE_PROJECT_NAME).toBe('mac')
  })

  it('names a database or a Compose project after the workspace id, so a rename or a folder move keeps it', () => {
    const ws = { id: '3F2A91C4-1111-2222-3333-444455556666', name: 'in-setup-script', path: '/wt/lead-in-setup-script', port: 4100, branch: 'lead/in-setup-script', baseRef: 'origin/main' }
    const slug = kernelVars(ws, undefined).KERNEL_WORKSPACE_SLUG
    expect(slug).toBe('kernel_3f2a91c41111')
    expect(kernelVars({ ...ws, name: 'setup-script-tab', path: '/wt/lead-setup-script-tab', branch: 'lead/setup-script-tab' }, undefined).KERNEL_WORKSPACE_SLUG).toBe(slug)
    expect(workspaceSlug({ id: 'ws-1' })).toBe('kernel_ws1')
    expect(workspaceSlug({ id: '--' })).toBe('kernel_workspace')
    for (const id of ['3F2A91C4-1111-2222-3333-444455556666', 'ws-1', 'Ünïcode', '9']) expect(workspaceSlug({ id })).toMatch(/^kernel_[a-z0-9]{1,12}$/)
  })
})

describe('Production values (KERNEL-449)', () => {
  it('flags live payment keys, databases on another host and production environment names', () => {
    const cases: [string, string, string | undefined][] = [
      ['STRIPE_SECRET_KEY', 'sk_live_51abc', 'live-key'],
      ['STRIPE_RESTRICTED', 'rk_live_51abc', 'live-key'],
      ['STRIPE_SECRET_KEY', 'sk_test_51abc', undefined],
      ['STRIPE_PUBLISHABLE_KEY', 'pk_live_51abc', undefined],
      ['DATABASE_URL', 'postgres://app:pw@db.prod.example.com:5432/app', 'remote-database'],
      ['DATABASE_URL', 'postgresql://app@ep-cool-123.us-east-2.aws.neon.tech/neondb?sslmode=require', 'remote-database'],
      ['MONGO_URI', 'mongodb://a.example.com:27017,localhost:27017/app', 'remote-database'],
      ['DB', 'jdbc:mysql://10.0.0.5:3306/app', undefined],
      ['DATABASE_URL', 'postgres://app:pa/ss@db.prod.example.com:5432/app', 'remote-database'],
      ['DATABASE_URL', 'postgres://app:p?w#d@db.prod.example.com/app', 'remote-database'],
      ['DATABASE_URL', 'postgres://localhost:5432/app?user=me@corp', undefined],
      ['DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/app', undefined],
      ['DATABASE_URL', 'postgres://127.0.0.1/app', undefined],
      ['DATABASE_URL', 'postgres://[::1]:5432/app', undefined],
      ['DATABASE_URL', 'postgres://db:5432/app', undefined],
      ['DATABASE_URL', 'postgres:///app?host=/tmp', undefined],
      ['REDIS_URL', 'rediss://default:pw@cache.upstash.io:6379', 'remote-database'],
      ['DATABASE_URL', 'file:./dev.db', undefined],
      ['API_URL', 'https://api.example.com', undefined],
      ['NODE_ENV', 'production', 'production'],
      ['RAILS_ENV', ' Prod ', 'production'],
      ['PLAID_ENV', 'live', 'production'],
      ['ENVIRONMENT', 'production', 'production'],
      ['NODE_ENV', 'development', undefined],
      ['MODE', 'production', undefined]
    ]
    for (const [name, value, why] of cases) expect(productionWhy(name, value), `${name}=${value}`).toBe(why)
  })

  it('lists a file\'s hits by name, strongest first, and never a value', () => {
    const text = 'NODE_ENV=production\nDATABASE_URL=postgres://u:hunter2@db.example.com/app\nSTRIPE_SECRET_KEY=sk_live_secret123\nPORT=3000\n'
    const hints = productionHints('.env.production', text)
    expect(hints).toEqual([
      { path: '.env.production', name: 'STRIPE_SECRET_KEY', why: 'live-key' },
      { path: '.env.production', name: 'DATABASE_URL', why: 'remote-database' },
      { path: '.env.production', name: 'NODE_ENV', why: 'production' }
    ])
    expect(JSON.stringify(hints)).not.toMatch(/hunter2|secret123|db\.example/)
  })
})

describe('Per-workspace names and .env.kernel (KERNEL-449)', () => {
  async function project(files: Record<string, string>) {
    const repo = await tempRepo({ 'README.md': '# env\n', '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.', ...files })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', leadWaitForSetup: true } }))
    const k = new Kernel({ dataDir, home, cipher: fakeCipher })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const r = await k.addProject(repo)
    return { k, repo, project: r, h: k.handlers() }
  }

  it("gives each worktree its own Compose project and database, from the user's own .env.kernel", async () => {
    const { k, repo, project: r, h } = await project({ '.gitignore': '.env.kernel\n' })
    await writeFile(join(repo, '.env.kernel'), 'DATABASE_URL=postgres://localhost:5432/app_${KERNEL_WORKSPACE_SLUG}\nWEB=http://localhost:${KERNEL_PORT}\n')
    const a = await k.workspaces.createWorkspace(r.id, { prompt: 'go', agentId: 'christian', title: 'One' })
    const b = await k.workspaces.createWorkspace(r.id, { prompt: 'go', agentId: 'christian', title: 'Two' })
    const envA = k.env.envFor(a)
    const envB = k.env.envFor(b)
    expect(envA.KERNEL_WORKSPACE_SLUG).toBe(workspaceSlug(a))
    expect(envA).toMatchObject({ COMPOSE_PROJECT_NAME: envA.KERNEL_WORKSPACE_SLUG, DATABASE_URL: `postgres://localhost:5432/app_${envA.KERNEL_WORKSPACE_SLUG}`, WEB: `http://localhost:${a.port}` })
    expect(envB.DATABASE_URL).toBe(`postgres://localhost:5432/app_${envB.KERNEL_WORKSPACE_SLUG}`)
    expect(envB.COMPOSE_PROJECT_NAME).not.toBe(envA.COMPOSE_PROJECT_NAME)
    // Scripts get the same, and the Environment page lists the file it read.
    expect(k.env.envFor(a, { script: true }).DATABASE_URL).toBe(envA.DATABASE_URL)
    expect((await h['env.get']({ projectId: r.id })).files).toEqual([{ path: '.env.kernel', missing: false }])

    // A rename and a folder move, as a chat with Kernel makes after setup, keep the names setup made the database with.
    const moved = k.store.saveWorkspace({ ...a, name: 'renamed', branch: 'lead/renamed', path: join(dirname(a.path), 'lead-renamed') })
    expect(k.env.envFor(moved)).toMatchObject({ KERNEL_WORKSPACE_SLUG: envA.KERNEL_WORKSPACE_SLUG, COMPOSE_PROJECT_NAME: envA.COMPOSE_PROJECT_NAME, DATABASE_URL: envA.DATABASE_URL })

    // An edit counts for the next process, and the user's own Compose project name wins over Kernel's.
    await writeFile(join(repo, '.env.kernel'), 'DATABASE_URL=postgres://localhost:5432/other\nCOMPOSE_PROJECT_NAME=mine\n')
    expect(k.env.envFor(a)).toMatchObject({ DATABASE_URL: 'postgres://localhost:5432/other', COMPOSE_PROJECT_NAME: 'mine' })

    // A current-branch workspace is the project's own checkout and keeps the project the user's terminal gets there.
    await rm(join(repo, '.env.kernel'))
    const here = k.store.saveWorkspace({ ...a, id: 'here', mode: 'current', path: repo, branch: 'main' })
    vi.stubEnv('COMPOSE_PROJECT_NAME', 'terminal')
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/mac')
    try {
      expect(k.env.envFor(here).COMPOSE_PROJECT_NAME).toBe('terminal')
      expect(k.env.envFor(a).DATABASE_URL).toBe('postgres://localhost:5432/mac')
    } finally { vi.unstubAllEnvs() }
    expect((await h['env.get']({ projectId: r.id })).files).toEqual([])
    await k.stop()
  })

  it('leaves a .env.kernel the repo commits alone until [env] files lists it', async () => {
    const { k, repo, project: r, h } = await project({ '.env.kernel': 'FROM_REPO=1\nBASH_ENV=./evil.sh\n' })
    const ws = await k.workspaces.createWorkspace(r.id, { prompt: 'go', agentId: 'christian', title: 'One' })
    expect(k.env.envFor(ws).FROM_REPO).toBeUndefined()
    expect(k.env.envFor(ws).BASH_ENV).toBe(process.env.BASH_ENV)
    expect((await h['env.get']({ projectId: r.id })).files).toEqual([])

    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[env]\nfiles = [".env.kernel"]\n')
    expect(k.env.envFor(ws).FROM_REPO).toBe('1')
    await k.stop()
  })

  it("stops reading .env.kernel once the user's commit tracks it", async () => {
    const { k, repo, project: r } = await project({})
    await writeFile(join(repo, '.env.kernel'), 'MINE=1\n')
    const ws = await k.workspaces.createWorkspace(r.id, { prompt: 'go', agentId: 'christian', title: 'One' })
    expect(k.env.envFor(ws).MINE).toBe('1')
    await run('git', ['-C', repo, 'add', '.env.kernel'])
    await writeFile(join(repo, '.env.kernel'), 'MINE=2\n')
    expect(k.env.envFor(ws).MINE).toBeUndefined()
    await k.stop()
  })
})

