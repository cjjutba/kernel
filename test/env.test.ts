import { describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { tempRepo, trustRoom } from './helpers'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { buildEnv, envFileReadable, EnvStore, MAX_ENV_FILE, readEnvFiles, type Cipher } from '../src/main/services/env'
import { sessionEnv } from '../src/main/services/sessions'

/** Stands in for safeStorage, which doesn't work under ELECTRON_RUN_AS_NODE. Its output never holds the text it was given. */
const fakeCipher: Cipher = {
  encrypt: (text) => `enc:${Buffer.from([...text].reverse().join(''), 'utf8').toString('hex')}`,
  decrypt: (data) => [...Buffer.from(data.slice('enc:'.length), 'hex').toString('utf8')].reverse().join('')
}

const until = async (ok: () => boolean, ms = 8000) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) } }

describe('buildEnv', () => {
  it('layers the Mac, the app, the env files in order, the room, then Kernel, the later winning', () => {
    const env = buildEnv({
      base: { A: 'mac', B: 'mac', C: 'mac', D: 'mac', E: 'mac', F: 'mac', GONE: undefined },
      app: { B: 'app', C: 'app', D: 'app', E: 'app', F: 'app' },
      files: [{ C: 'file1', D: 'file1', E: 'file1', F: 'file1' }, { D: 'file2', E: 'file2', F: 'file2' }],
      room: { E: 'room', F: 'room' },
      kernel: { F: 'kernel' }
    })
    expect(env).toEqual({ A: 'mac', B: 'app', C: 'file1', D: 'file2', E: 'room', F: 'kernel' })
  })
})

describe('readEnvFiles', () => {
  it('reads regular files inside the folder only, so a room\'s settings can\'t pull in the rest of the Mac or stall it', async () => {
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
    store.set('room-1', 'DATABASE_URL', 'postgres://secret-host/db')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('API_TOKEN')
    expect(text).not.toContain('tok-app-123')
    expect(text).not.toContain('secret-host')

    const again = new EnvStore({ file, cipher: fakeCipher })
    expect(again.names()).toEqual(['API_TOKEN'])
    expect(again.names('room-1')).toEqual(['DATABASE_URL'])
    expect(again.reveal('room-1', 'DATABASE_URL')).toBe('postgres://secret-host/db')
    expect(again.values()).toEqual({ API_TOKEN: 'tok-app-123' })
    expect(() => again.reveal('room-1', 'API_TOKEN')).toThrow('no variable named API_TOKEN')
    expect(() => again.reveal(undefined, 'toString')).toThrow('no variable named toString')

    // A value this Mac can't decrypt keeps its name, stays out of the environment, and can't be shown.
    const broken = new EnvStore({ file, cipher: { ...fakeCipher, decrypt: (d) => { if (d === JSON.parse(readFileSync(file, 'utf8')).app.API_TOKEN) throw new Error('bad key'); return fakeCipher.decrypt(d) } } })
    expect(broken.names()).toEqual(['API_TOKEN'])
    expect(broken.values()).toEqual({})
    expect(() => broken.reveal(undefined, 'API_TOKEN')).toThrow('can\'t decrypt API_TOKEN')
    expect(() => new EnvStore({ file }).reveal(undefined, 'API_TOKEN')).toThrow('Keychain isn\'t available')

    again.set('room-1', 'DATABASE_URL', null)
    expect(again.names('room-1')).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).rooms).toEqual({})
    again.dropRoom('room-1')
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

  it('saves the file readable by the user only, even over a leftover temp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-env-'))
    const file = join(dir, 'env.json')
    await writeFile(`${file}.tmp`, 'left by a crash', { mode: 0o644 })
    new EnvStore({ file, cipher: fakeCipher }).set(undefined, 'A', 'v')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('Kernel env', () => {
  it('gives scripts, big terminals and sessions the room\'s variables and env files, and keeps values out of logs', async () => {
    const repo = await tempRepo({
      'README.md': '# env\n',
      '.env.shared': 'FROM_FILE=one\nOVERRIDDEN=file\nANTHROPIC_BASE_URL=https://proxy.example\nCLAUDE_CODE_USE_BEDROCK=1\n',
      '.env.later': 'OVERRIDDEN=later-file\n',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
      '.kernel/settings.toml': [
        '[scripts]',
        'setup = "echo \\"$ROOM_SECRET|$APP_ONLY|$FROM_FILE|$OVERRIDDEN|$KERNEL_WORKSPACE_ID|$PORT|$FORCE_COLOR\\" > seen.txt"',
        'archive = "echo \\"archive=$ROOM_SECRET\\" > \\"$KERNEL_ROOT_PATH/archive.txt\\""',
        '[run_scripts]',
        'web = "echo \\"web=$ROOM_SECRET|$ANTHROPIC_BASE_URL\\" > run.txt"',
        '[env]',
        'files = [".env.shared", ".env.missing", ".env.later", "../outside.env"]',
        ''
      ].join('\n')
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const logged: unknown[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => { logged.push(...a) }))
    const k = new Kernel({ dataDir, home, cipher: fakeCipher })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const h = k.handlers()
    const room = await k.addRoom(repo)
    await trustRoom(k, room.id)

    await h['env.set']({ name: 'APP_ONLY', value: 'app-value-77' })
    await h['env.set']({ name: 'ANTHROPIC_API_KEY', value: 'sk-user-key' })
    await h['env.set']({ roomId: room.id, name: 'ROOM_SECRET', value: 'room-secret-42' })
    await h['env.set']({ roomId: room.id, name: 'OVERRIDDEN', value: 'room' })
    await h['env.set']({ roomId: room.id, name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'other-account' })
    await h['env.set']({ roomId: room.id, name: 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', value: '0' })
    await expect(h['env.set']({ roomId: room.id, name: 'KERNEL_PORT', value: '1' })).rejects.toThrow('Kernel\'s own')
    expect(await h['env.get']({ roomId: room.id })).toEqual({
      names: ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'CLAUDE_CODE_OAUTH_TOKEN', 'OVERRIDDEN', 'ROOM_SECRET'],
      files: [{ path: '.env.shared', missing: false }, { path: '.env.missing', missing: true }, { path: '.env.later', missing: false }, { path: '../outside.env', missing: true }]
    })
    expect(await h['env.get']({})).toEqual({ names: ['ANTHROPIC_API_KEY', 'APP_ONLY'], files: [] })
    expect(await h['env.reveal']({ roomId: room.id, name: 'ROOM_SECRET' })).toBe('room-secret-42')
    expect((await h['settings.room']({ roomId: room.id })).env).toEqual({ files: ['.env.shared', '.env.missing', '.env.later', '../outside.env'] })

    // The setup script writes what it saw. The room's variable wins over both files, and the missing file is skipped.
    const ws = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Env' })
    expect(ws.status).toBe('ready')
    expect((await readFile(join(ws.path, 'seen.txt'), 'utf8')).trim()).toBe(`room-secret-42|app-value-77|one|room|${ws.id}|${ws.port}|0`)

    // Sessions get the same set as scripts, less the API key and the script-only variables.
    const session = sessionEnv(k.envFor(ws), {})
    expect(session).toMatchObject({ ROOM_SECRET: 'room-secret-42', KERNEL_PORT: String(ws.port), KERNEL_WORKSPACE: ws.path, KERNEL_ROOT_PATH: room.path })
    expect(session.ANTHROPIC_API_KEY).toBeUndefined()
    expect(session.FORCE_COLOR).toBe(process.env.FORCE_COLOR)
    expect(k.envFor(ws, { script: true }).ANTHROPIC_API_KEY).toBe('sk-user-key')

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
      expect(k.envFor(ws, { script: true })).toMatchObject({ ANTHROPIC_BASE_URL: 'https://proxy.example', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'other-account' })
    } finally {
      for (const [k2, v] of [['ANTHROPIC_BASE_URL', mac.base], ['CLAUDE_CODE_USE_BEDROCK', mac.bedrock], ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', mac.teams]] as const) {
        if (v === undefined) delete process.env[k2]
        else process.env[k2] = v
      }
    }

    // A named run script gets the room's variable, and the env file's proxy, since scripts get every layer.
    let ran = false
    const onExit = (e: { type: string; workspaceId?: string; name?: string }) => { if (e.type === 'script.exit' && e.workspaceId === ws.id && e.name === 'web') ran = true }
    bus.on('push', onExit)
    await h['scripts.run']({ workspaceId: ws.id, kind: 'run', name: 'web' })
    await until(() => ran)
    bus.off('push', onExit)
    expect((await readFile(join(ws.path, 'run.txt'), 'utf8')).trim()).toBe('web=room-secret-42|https://proxy.example')

    // A big terminal's shell sees the room's variable. `claude` isn't typed in, so the test reads a plain prompt.
    const start = k.ptys.start.bind(k.ptys)
    k.ptys.start = (id, o) => start(id, { ...o, command: undefined })
    const term = await h['chats.create']({ workspaceId: ws.id, kind: 'terminal' })
    let out = ''
    const on = (e: { type: string; chatId?: string; data?: string }) => { if (e.type === 'terminal.data' && e.chatId === term.id) out += e.data }
    bus.on('push', on)
    await h['terminal.write']({ chatId: term.id, data: 'echo "seen=$ROOM_SECRET key=${ANTHROPIC_API_KEY:-none}"\r' })
    await until(() => out.includes('seen=room-secret-42 key=none'))
    await h['terminal.write']({ chatId: term.id, data: 'echo "oauth=${CLAUDE_CODE_OAUTH_TOKEN:-none} bedrock=${CLAUDE_CODE_USE_BEDROCK:-none}"\r' })
    await until(() => out.includes('oauth=none bedrock=none'))
    bus.off('push', on)
    await h['chats.close']({ chatId: term.id })

    // The archive script gets the room's variable too. The worktree goes, so it writes to the main checkout.
    await k.archiveWorkspace(ws.id, true)
    expect((await readFile(join(room.path, 'archive.txt'), 'utf8')).trim()).toBe('archive=room-secret-42')

    // No value reaches the data folder in plain text, the activity log, its export, or the console.
    const values = ['app-value-77', 'sk-user-key', 'room-secret-42', 'other-account']
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
    k.store.db.close()
  })

  it('removing a room removes its variables', async () => {
    const repo = await tempRepo()
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')), cipher: fakeCipher })
    const room = await k.addRoom(repo)
    await k.handlers()['env.set']({ roomId: room.id, name: 'GONE_SOON', value: 'v' })
    await k.removeRoom(room.id, false)
    expect(JSON.parse(readFileSync(join(dataDir, 'env.json'), 'utf8')).rooms).toEqual({})
    k.store.db.close()
  })
})
