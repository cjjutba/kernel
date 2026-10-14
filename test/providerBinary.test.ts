import { describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreflightCheck } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import type { ExecResult } from '../src/main/services/exec'
import { runPreflight } from '../src/main/services/preflight'
import { claudeExecutable, findOnPath, packagedClaude, packagedCodex, resolveBinary } from '../src/main/services/providers/binary'

/** An executable shell script in a fresh folder. */
async function script(name: string, body: string, dir?: string): Promise<string> {
  const folder = dir ?? await mkdtemp(join(tmpdir(), 'kernel-bin-'))
  const file = join(folder, name)
  await writeFile(file, `#!/bin/sh\n${body}\n`)
  await chmod(file, 0o755)
  return file
}

describe('which executable a provider runs (KERNEL-406)', () => {
  const none = () => undefined
  it('takes the path from Settings first, then the bundled copy, then the PATH', () => {
    const onPath = (name: string) => `/opt/homebrew/bin/${name}`
    expect(resolveBinary('codex', { path: ' /tmp/my-codex ', useSystem: false }, { bundled: () => '/bundled/codex', onPath })).toEqual({ path: '/tmp/my-codex', source: 'custom' })
    expect(resolveBinary('codex', { path: '', useSystem: false }, { bundled: () => '/bundled/codex', onPath })).toEqual({ path: '/bundled/codex', source: 'bundled' })
    expect(resolveBinary('codex', { path: '', useSystem: false }, { bundled: none, onPath })).toEqual({ path: '/opt/homebrew/bin/codex', source: 'system' })
    expect(resolveBinary('claude', { path: '', useSystem: false }, { bundled: none, onPath: none })).toEqual({ source: 'missing' })
  })

  it('skips the bundled copy with "Use system", and finds nothing when the PATH has none', () => {
    expect(resolveBinary('claude', { path: '', useSystem: true }, { bundled: () => '/bundled/claude', onPath: (n) => `/usr/local/bin/${n}` })).toEqual({ path: '/usr/local/bin/claude', source: 'system' })
    expect(resolveBinary('claude', { path: '', useSystem: true }, { bundled: () => '/bundled/claude', onPath: none })).toEqual({ source: 'missing' })
  })

  it('finds an executable file on the PATH and passes over folders and files it cannot run', async () => {
    const a = await mkdtemp(join(tmpdir(), 'kernel-path-'))
    const b = await mkdtemp(join(tmpdir(), 'kernel-path-'))
    await mkdir(join(a, 'codex'))
    await writeFile(join(b, 'codex'), 'not executable')
    const real = await script('codex', 'echo hi')
    expect(findOnPath('codex', [a, b, join(real, '..')].join(':'))).toBe(real)
    expect(findOnPath('codex', [a, b].join(':'))).toBeUndefined()
  })

  it('looks for the unpacked binaries in a packaged app, and nowhere else', async () => {
    expect(packagedCodex('/nowhere')).toBeUndefined()
    expect(packagedCodex(undefined)).toBeUndefined()
    const resources = await mkdtemp(join(tmpdir(), 'kernel-res-'))
    const bin = join(resources, 'app.asar.unpacked', 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`, 'vendor', `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`, 'bin')
    await mkdir(bin, { recursive: true })
    await script('codex', 'echo hi', bin)
    expect(packagedCodex(resources)).toBe(join(bin, 'codex'))
  })

  it('gives Claude sessions the same executable as before while Settings is left alone', () => {
    expect(claudeExecutable(undefined)).toBe(packagedClaude())
    expect(claudeExecutable({ path: '', useSystem: false })).toBe(packagedClaude())
    expect(claudeExecutable({ path: '/tmp/claude', useSystem: false })).toBe('/tmp/claude')
  })
})

describe('the Codex check before agents run (KERNEL-406)', () => {
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' })
  const fake = (codex: { version?: boolean; signedIn: boolean }) => async (cmd: string, args: string[]): Promise<ExecResult> => {
    if (cmd === '/bin/codex') return args[0] === '--version' ? (codex.version === false ? { code: 1, stdout: '', stderr: 'boom' } : ok('codex-cli 0.153.4')) : { code: codex.signedIn ? 0 : 1, stdout: codex.signedIn ? 'Logged in using ChatGPT' : 'Not logged in', stderr: '' }
    if (args[0] === '--version') return ok(cmd === 'git' ? 'git version 2.39.5' : cmd === 'gh' ? 'gh version 2.62.0' : '2.1.292 (Claude Code)')
    if (args[0] === 'auth' && cmd !== 'gh') return ok(JSON.stringify({ loggedIn: true, subscriptionType: 'max' }))
    return ok('github.com\n  ✓ Logged in to github.com account samrivera (keyring)')
  }
  const ids = (checks: PreflightCheck[]) => checks.map((c) => c.id)

  it('leaves the checks as they were while every role runs on Claude', async () => {
    const checks = await runPreflight({ hookPort: 7420, hookServerUp: true, run: fake({ signedIn: false }), claude: '/bin/claude' })
    expect(ids(checks)).not.toContain('codex')
  })

  it('warns, without blocking, when Codex is signed out or did not start', async () => {
    const signedIn = await runPreflight({ hookPort: 7420, hookServerUp: true, run: fake({ signedIn: true }), claude: '/bin/claude', codex: { bin: '/bin/codex' } })
    expect(signedIn.find((c) => c.id === 'codex')).toMatchObject({ ok: true, meta: 'v0.153.4', detail: 'Signed in with ChatGPT' })
    const out = await runPreflight({ hookPort: 7420, hookServerUp: true, run: fake({ signedIn: false }), claude: '/bin/claude', codex: { bin: '/bin/codex' } })
    expect(out.find((c) => c.id === 'codex')).toMatchObject({ ok: false, blocking: false, title: 'Not signed in to Codex' })
    const broken = await runPreflight({ hookPort: 7420, hookServerUp: true, run: fake({ version: false, signedIn: true }), claude: '/bin/claude', codex: { bin: '/bin/codex' } })
    expect(broken.find((c) => c.id === 'codex')).toMatchObject({ ok: false, blocking: false, title: 'Codex did not start' })
    const missing = await runPreflight({ hookPort: 7420, hookServerUp: true, run: fake({ signedIn: true }), claude: '/bin/claude', codex: {} })
    expect(missing.find((c) => c.id === 'codex')).toMatchObject({ ok: false, blocking: false })
  })
})

describe('Settings, Providers status (KERNEL-406)', () => {
  it('reads Claude through the executable Settings names, not the one on the PATH (KERNEL-277)', async () => {
    const claude = await script('claude', `case "$1" in --version) echo "2.1.292 (Claude Code)";; auth) echo '{"loggedIn":true,"authMethod":"claude.ai","email":"cj@example.com","subscriptionType":"max"}';; esac`)
    const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home: await mkdtemp(join(tmpdir(), 'kernel-home-')) })
    await k.start()
    await k.providers.setPath('claude', { path: claude })
    expect(await k.providers.status('claude')).toMatchObject({ provider: 'claude', path: claude, source: 'custom', version: '2.1.292', signedIn: true, loginMethod: 'Claude account', plan: 'Claude Max', email: 'cj@example.com' })
    expect(k.settings.providers.claude).toEqual({ path: claude, useSystem: false })
    const out = await script('claude', `case "$1" in --version) echo "2.1.292 (Claude Code)";; auth) echo '{"loggedIn":false}';; esac`)
    await k.providers.setPath('claude', { path: out })
    expect(await k.providers.status('claude')).toMatchObject({ signedIn: false, version: '2.1.292' })
    await k.providers.setPath('claude', { path: '/nowhere/claude' })
    expect((await k.providers.status('claude')).error).toContain('did not start')
    await k.stop()
  })
})
