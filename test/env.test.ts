import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { buildEnv, EnvStore, type Cipher } from '../src/main/services/env'
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

    again.set('room-1', 'DATABASE_URL', null)
    expect(again.names('room-1')).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).rooms).toEqual({})
    again.dropRoom('room-1')
  })

  it('rejects bad names and Kernel\'s own, and saves nothing without a cipher', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-env-')), 'env.json')
    const store = new EnvStore({ file, cipher: fakeCipher })
    for (const bad of ['', '1ABC', 'MY-VAR', 'A B', 'É']) expect(() => store.set(undefined, bad, 'x')).toThrow('not a valid variable name')
    for (const own of ['KERNEL_PORT', 'KERNEL_WORKSPACE_ID', 'KERNEL_WORKSPACE', 'KERNEL_ROOT_PATH']) expect(() => store.set(undefined, own, 'x')).toThrow('Kernel\'s own')
    store.set(undefined, '_ok_9', 'fine')
    expect(store.names()).toEqual(['_ok_9'])

    const plainFile = join(await mkdtemp(join(tmpdir(), 'kernel-env-')), 'env.json')
    const none = new EnvStore({ file: plainFile })
    expect(() => none.set(undefined, 'TOKEN', 'plain-value')).toThrow('can\'t encrypt')
    expect(existsSync(plainFile)).toBe(false)
  })
})

describe('Kernel env', () => {
  it('gives scripts, big terminals and sessions the room\'s variables and env files, and keeps values out of logs', async () => {
    const repo = await tempRepo({
      'README.md': '# env\n',
      '.env.shared': 'FROM_FILE=one\nOVERRIDDEN=file\n',
      '.env.later': 'OVERRIDDEN=later-file\n',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
      '.kernel/settings.toml': '[scripts]\nsetup = "echo \\"$ROOM_SECRET|$APP_ONLY|$FROM_FILE|$OVERRIDDEN|$KERNEL_WORKSPACE_ID|$PORT|$FORCE_COLOR\\" > seen.txt"\n\n[env]\nfiles = [".env.shared", ".env.missing", ".env.later"]\n'
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

    await h['env.set']({ name: 'APP_ONLY', value: 'app-value-77' })
    await h['env.set']({ name: 'ANTHROPIC_API_KEY', value: 'sk-user-key' })
    await h['env.set']({ roomId: room.id, name: 'ROOM_SECRET', value: 'room-secret-42' })
    await h['env.set']({ roomId: room.id, name: 'OVERRIDDEN', value: 'room' })
    await expect(h['env.set']({ roomId: room.id, name: 'KERNEL_PORT', value: '1' })).rejects.toThrow('Kernel\'s own')
    expect(await h['env.get']({ roomId: room.id })).toEqual({
      names: ['OVERRIDDEN', 'ROOM_SECRET'],
      files: [{ path: '.env.shared', missing: false }, { path: '.env.missing', missing: true }, { path: '.env.later', missing: false }]
    })
    expect(await h['env.get']({})).toEqual({ names: ['ANTHROPIC_API_KEY', 'APP_ONLY'], files: [] })
    expect(await h['env.reveal']({ roomId: room.id, name: 'ROOM_SECRET' })).toBe('room-secret-42')
    expect((await h['settings.room']({ roomId: room.id })).env).toEqual({ files: ['.env.shared', '.env.missing', '.env.later'] })

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

    // A big terminal's shell sees the room's variable. `claude` isn't typed in, so the test reads a plain prompt.
    const start = k.ptys.start.bind(k.ptys)
    k.ptys.start = (id, o) => start(id, { ...o, command: undefined })
    const term = await h['chats.create']({ workspaceId: ws.id, kind: 'terminal' })
    let out = ''
    const on = (e: { type: string; chatId?: string; data?: string }) => { if (e.type === 'terminal.data' && e.chatId === term.id) out += e.data }
    bus.on('push', on)
    await h['terminal.write']({ chatId: term.id, data: 'echo "seen=$ROOM_SECRET key=${ANTHROPIC_API_KEY:-none}"\r' })
    await until(() => out.includes('seen=room-secret-42 key=none'))
    bus.off('push', on)
    await h['chats.close']({ chatId: term.id })

    // No value reaches the data folder in plain text, the activity log, its export, or the console.
    const values = ['app-value-77', 'sk-user-key', 'room-secret-42']
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
