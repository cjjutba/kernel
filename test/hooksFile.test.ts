import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Settings } from '@anthropic-ai/claude-agent-sdk'
import { Kernel } from '../src/main/kernel'
import { hooksPolicy, hooksPolicyOf, type HooksPolicy } from '../src/main/services/claudeSettings'
import { HooksFileError, installHooks, KERNEL_HOOK_EVENTS, mountPoint, refreshHooks, turnHooksOn, uninstallHooks, withKernelHooks } from '../src/main/services/hooksInstaller'
import { run } from '../src/main/services/exec'

// One fs call can be made to fail with a given code, the way a full or read-only disk would. Every other call is real.
const fail = vi.hoisted(() => ({ next: null as null | { call: 'writeFile' | 'rename'; code: string } }))
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  const faulty = <F extends (...a: any[]) => Promise<unknown>>(call: 'writeFile' | 'rename', fn: F) => (async (...a: Parameters<F>) => {
    const f = fail.next
    if (f?.call !== call) return fn(...a)
    fail.next = null
    throw Object.assign(new Error(`${f.code}: failed, ${call} '${a[0]}'`), { code: f.code, syscall: call, path: a[0], ...(call === 'rename' ? { dest: a[1] } : {}) })
  }) as F
  const mocked = { ...real, writeFile: faulty('writeFile', real.writeFile), rename: faulty('rename', real.rename) }
  return { ...mocked, default: mocked }
})

// The SDK's settings reader is scripted, so a test never reads the real managed or user settings.
const sdk = vi.hoisted(() => ({ resolved: { effective: {}, provenance: {}, sources: [] } as any, asked: [] as unknown[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<object>()),
  resolveSettings: async (o: unknown) => { sdk.asked.push(o); return sdk.resolved }
}))

const token = 'ab'.repeat(32)
const isRoot = process.getuid?.() === 0
afterEach(() => { fail.next = null })

/** A settings file in a temp folder. The folder's mode goes back to normal after the test, so it can be cleaned up. */
async function temp(content: object = { theme: 'dark' }) {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-hooksfile-'))
  const file = join(dir, 'settings.json')
  await writeFile(file, JSON.stringify(content))
  onTestFinished(() => chmod(dir, 0o755))
  return { dir, file, text: JSON.stringify(content) }
}

async function problemOf(p: Promise<unknown>) {
  const e = await p.then(() => null, (e: unknown) => e)
  expect(e).toBeInstanceOf(HooksFileError)
  return (e as HooksFileError).problem
}

describe('a settings file Kernel cannot write (KERNEL-461)', () => {
  it('names the folder and the chown that fixes EACCES, and leaves the file as it was', async () => {
    const { dir, file, text } = await temp()
    const real = await realpath(dir)
    fail.next = { call: 'writeFile', code: 'EACCES' }
    expect(await problemOf(installHooks(file, 7420, 300, token))).toEqual({ kind: 'not-writable', code: 'EACCES', file, dir: real, fix: `sudo chown -R "$USER" ${real}` })
    expect(await readFile(file, 'utf8')).toBe(text)
    // The backup is the first copy, so it stays. No temp file is left.
    expect((await readdir(dir)).sort()).toEqual(['settings.json', 'settings.json.kernel-backup'])
  })

  it.skipIf(isRoot)('explains a folder the account really cannot write, before it takes a backup', async () => {
    const { dir, file, text } = await temp()
    await chmod(dir, 0o555)
    const problem = await problemOf(installHooks(file, 7420, 300, token))
    expect(problem).toMatchObject({ kind: 'not-writable', code: 'EACCES', file, dir, fix: `sudo chown -R "$USER" ${dir}` })
    await expect(problemOf(uninstallHooks(file))).resolves.toMatchObject({ kind: 'not-writable' })
    expect(await readdir(dir)).toEqual(['settings.json'])
    expect(await readFile(file, 'utf8')).toBe(text)
  })

  it('names the disk and the mount that fixes EROFS', async () => {
    const { dir, file, text } = await temp()
    const real = await realpath(dir)
    const mount = await mountPoint(real)
    fail.next = { call: 'rename', code: 'EROFS' }
    expect(await problemOf(installHooks(file, 7420, 300, token))).toEqual({ kind: 'read-only', code: 'EROFS', dir: real, disk: basename(mount) || mount, fix: `sudo mount -uw ${mount}` })
    expect(await readFile(file, 'utf8')).toBe(text)
    expect((await readdir(dir)).sort()).toEqual(['settings.json', 'settings.json.kernel-backup'])
  })

  it('quotes a folder with a space in the command', async () => {
    const { dir } = await temp()
    const spaced = join(dir, 'My Settings')
    await mkdir(spaced)
    const file = join(spaced, 'settings.json')
    await writeFile(file, '{}')
    fail.next = { call: 'writeFile', code: 'EACCES' }
    const problem = await problemOf(installHooks(file, 7420, 300, token))
    expect(problem.kind === 'not-writable' && problem.fix).toBe(`sudo chown -R "$USER" '${await realpath(spaced)}'`)
  })

  it('leaves every other failure as it is', async () => {
    const { file } = await temp()
    fail.next = { call: 'writeFile', code: 'ENOSPC' }
    const e = await installHooks(file, 7420, 300, token).then(() => null, (e: NodeJS.ErrnoException) => e)
    expect(e).not.toBeInstanceOf(HooksFileError)
    expect(e?.code).toBe('ENOSPC')
  })

  it('finds the folder a disk is mounted at, for a path that is not there yet', async () => {
    const real = await realpath((await temp()).dir)
    const mount = await mountPoint(join(real, 'missing', 'settings.json'))
    expect(real === mount || real.startsWith(mount === '/' ? '/' : mount + '/')).toBe(true)
    expect(mount === '/' || (await stat(dirname(mount))).dev !== (await stat(mount)).dev).toBe(true)
  })
})

describe('a settings file linked into a read-only store (KERNEL-461)', () => {
  it.skipIf(isRoot)('never writes through the link, and its fix leaves a file Kernel and Claude Code can write', async () => {
    const { dir: home } = await temp()
    const store = await mkdtemp(join(tmpdir(), 'kernel-store-'))
    const target = join(store, 'p3v8kq-settings.json')
    await writeFile(target, JSON.stringify({ theme: 'dark' }), { mode: 0o444 })
    await chmod(store, 0o555)
    onTestFinished(() => chmod(store, 0o755))
    const file = join(home, 'linked.json')
    await symlink(target, file)
    const realTarget = await realpath(target)

    const problem = await problemOf(installHooks(file, 7420, 300, token))
    expect(problem).toEqual({ kind: 'symlink', code: 'EACCES', file, store: dirname(realTarget), nix: false, fix: `rm ${file} &&\ncp ${realTarget} ${file}` })
    await expect(problemOf(uninstallHooks(file))).resolves.toEqual(problem)
    // The start-up rewrite refuses the same way when the store holds out-of-date Kernel entries.
    await chmod(target, 0o644)
    await writeFile(target, JSON.stringify(withKernelHooks({}, 7421, 300, token)))
    await chmod(target, 0o444)
    await expect(problemOf(refreshHooks(file, 7420, 300, token))).resolves.toEqual(problem)
    expect((await lstat(file)).isSymbolicLink()).toBe(true)
    expect((await readdir(home)).sort()).toEqual(['linked.json', 'settings.json'])
    expect(await readdir(store)).toEqual(['p3v8kq-settings.json'])

    // The user runs the command the card shows, then installs again.
    await run('sh', ['-c', problem.fix])
    expect((await lstat(file)).isSymbolicLink()).toBe(false)
    expect(await installHooks(file, 7420, 300, token)).toHaveLength(KERNEL_HOOK_EVENTS.length)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('calls the store Nix when the link points into /nix/store', async () => {
    // No Nix store on the test machine: the check reads the target's own path, so this one is pure.
    const problem = new HooksFileError({ kind: 'symlink', code: 'EROFS', file: '~/.claude/settings.json', store: '/nix/store', nix: true, fix: 'rm ~/.claude/settings.json &&\ncp /nix/store/x-settings.json ~/.claude/settings.json' })
    expect(problem.message).toBe('~/.claude/settings.json links to a read-only file. Replace the link with a copy, then install again: rm ~/.claude/settings.json && cp /nix/store/x-settings.json ~/.claude/settings.json')
  })
})

describe('Turn hooks on (KERNEL-461)', () => {
  it('removes disableAllHooks after the first backup and keeps everything else', async () => {
    const before = { disableAllHooks: true, theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: './notify.sh' }] }] } }
    const { file, text } = await temp(before)
    expect(await turnHooksOn(file)).toBe(true)
    const { disableAllHooks: _off, ...rest } = before
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(rest)
    expect(await readFile(file + '.kernel-backup', 'utf8')).toBe(text)
  })

  it('writes nothing when the file does not set it', async () => {
    const { dir, file, text } = await temp({ theme: 'dark' })
    expect(await turnHooksOn(file)).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(text)
    expect(await readdir(dir)).toEqual(['settings.json'])
  })
})

describe("what Claude Code's settings do to hooks (KERNEL-461)", () => {
  const managed = (settings: Settings, path?: string) => ({ source: 'managed' as const, settings, ...(path ? { path } : {}) })
  const user = (settings: Settings) => ({ source: 'user' as const, settings, path: '/Users/sam/.claude/settings.json' })
  const file = '/Library/Application Support/ClaudeCode/managed-settings.json'

  it('reads managed policy and only the user\'s own settings', async () => {
    sdk.asked = []
    sdk.resolved = { effective: {}, provenance: {}, sources: [] }
    expect(await hooksPolicy()).toEqual({ managedHooks: {} })
    expect(sdk.asked).toEqual([{ settingSources: ['user'] }])
  })

  it('names the managed file that turns hooks off or allows only its own, and no file for MDM or remote policy', () => {
    expect(hooksPolicyOf({ effective: { disableAllHooks: true }, sources: [managed({ disableAllHooks: true }, file)] })).toEqual({ managedOff: { path: file }, managedHooks: {} })
    expect(hooksPolicyOf({ effective: { allowManagedHooksOnly: true }, sources: [managed({ allowManagedHooksOnly: true })] })).toEqual({ managedOnly: {}, managedHooks: {} })
  })

  it("counts allowManagedHooksOnly only from managed settings, and the user's disableAllHooks only when it holds", () => {
    expect(hooksPolicyOf({ effective: { allowManagedHooksOnly: true }, sources: [user({ allowManagedHooksOnly: true })] })).toEqual({ managedHooks: {} })
    expect(hooksPolicyOf({ effective: { disableAllHooks: true }, sources: [user({ disableAllHooks: true })] })).toEqual({ userOff: { path: '/Users/sam/.claude/settings.json' }, managedHooks: {} })
    // Managed settings that set it to false win over the user's true.
    expect(hooksPolicyOf({ effective: { disableAllHooks: false }, sources: [user({ disableAllHooks: true }), managed({ disableAllHooks: false })] })).toEqual({ managedHooks: {} })
    // Managed settings that turn hooks off are the reason, not the user's own line.
    expect(hooksPolicyOf({ effective: { disableAllHooks: true }, sources: [user({ disableAllHooks: true }), managed({ disableAllHooks: true }, file)] })).toEqual({ managedOff: { path: file }, managedHooks: {} })
  })

  it('collects the hooks every managed source carries, by event', () => {
    const a = { matcher: '*', hooks: [{ type: 'command' as const, command: './a.sh' }] }
    const b = { hooks: [{ type: 'command' as const, command: './b.sh' }] }
    expect(hooksPolicyOf({ effective: {}, sources: [managed({ hooks: { Stop: [a] } }), user({ hooks: { Stop: [b] } }), managed({ hooks: { Stop: [b], PreToolUse: [a] } })] }).managedHooks).toEqual({ Stop: [a, b], PreToolUse: [a] })
  })
})

describe('Check hooks says why the hooks cannot run (KERNEL-461)', () => {
  async function boot(policy: (file: string) => Promise<HooksPolicy> = async () => ({ managedHooks: {} })) {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const port = 18000 + Math.floor(Math.random() * 800)
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: port }))
    const { dir, file } = await temp({})
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')), claudeSettingsFile: file })
    k.hooks.readPolicy = () => policy(file)
    await k.start()
    onTestFinished(() => k.stop())
    return { k, h: k.handlers(), port, dir, file }
  }
  /** The user's own file, read the way the SDK would, so Turn hooks on shows up in the next status. */
  const fromFile = async (file: string) => {
    const s = JSON.parse(await readFile(file, 'utf8')) as Settings
    return hooksPolicyOf({ effective: s, sources: [{ source: 'user', settings: s, path: file }] })
  }

  it('asks the admin for managed hooks, with the block to give them, until Kernel\'s hooks are in managed settings', async () => {
    let managedHooks: HooksPolicy['managedHooks'] = {}
    const { h, port } = await boot(async () => ({ managedOnly: { path: '/Library/Application Support/ClaudeCode/managed-settings.json' }, managedHooks }))
    const status = await h['hooks.status']()
    expect(status.problem).toMatchObject({ kind: 'managed', setting: 'allowManagedHooksOnly', source: '/Library/Application Support/ClaudeCode/managed-settings.json' })
    const block = JSON.parse(status.problem?.kind === 'managed' ? status.problem.block ?? '' : '')
    expect(block).toEqual({ hooks: withKernelHooks({}, port, 300, status.token!).hooks })
    expect(Object.keys(block.hooks).sort()).toEqual([...KERNEL_HOOK_EVENTS].sort())

    // The admin adds them, and Check again finds them.
    managedHooks = block.hooks
    const after = await h['hooks.status']()
    expect(after.problem).toBeUndefined()
    expect(after.installed).toBe(true)
  })

  it('says the organization turns hooks off, whatever hooks managed settings carry', async () => {
    let managedHooks: HooksPolicy['managedHooks'] = {}
    const { h, port } = await boot(async () => ({ managedOff: {}, managedHooks }))
    managedHooks = withKernelHooks({}, port, 300, (await h['hooks.status']()).token!).hooks as HooksPolicy['managedHooks']
    const status = await h['hooks.status']()
    expect(status.installed).toBe(true)
    expect(status.problem).toEqual({ kind: 'managed', setting: 'disableAllHooks' })
  })

  it("turns the user's own disableAllHooks off with Turn hooks on, and never edits managed settings", async () => {
    const { h, file } = await boot(fromFile)
    await writeFile(file, JSON.stringify({ disableAllHooks: true, theme: 'dark' }))
    expect((await h['hooks.status']()).problem).toEqual({ kind: 'off', file })
    const after = await h['hooks.turnOn']()
    expect(after.problem).toBeUndefined()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ theme: 'dark' })
  })

  it.skipIf(isRoot)('keeps a failed write until one works, after managed policy and before the user\'s own switch', async () => {
    let policy: HooksPolicy = { userOff: {}, managedHooks: {} }
    const { h, port, dir, file } = await boot(async () => policy)
    await chmod(dir, 0o555)
    await expect(h['hooks.install']({ port })).rejects.toThrow(`Kernel can't write to ${dir}. Run sudo chown -R "$USER" ${dir} in Terminal, then install again.`)
    expect((await h['hooks.status']()).problem).toEqual({ kind: 'not-writable', code: 'EACCES', file, dir, fix: `sudo chown -R "$USER" ${dir}` })
    policy = { managedOnly: {}, userOff: {}, managedHooks: {} }
    expect((await h['hooks.status']()).problem).toMatchObject({ kind: 'managed', setting: 'allowManagedHooksOnly' })

    // The user runs the fix and installs again: the write works, so the user's own switch is what is left.
    policy = { userOff: {}, managedHooks: {} }
    await chmod(dir, 0o755)
    await h['hooks.install']({ port })
    expect((await h['hooks.status']()).problem).toEqual({ kind: 'off', file })
  })

  it('still answers when Claude Code\'s settings cannot be read', async () => {
    const { h } = await boot(async () => { throw new Error('plutil failed') })
    const status = await h['hooks.status']()
    expect(status.problem).toBeUndefined()
    expect(status.events).toHaveLength(KERNEL_HOOK_EVENTS.length)
  })
})
