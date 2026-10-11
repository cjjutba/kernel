import { describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks, uninstallHooks, withKernelHooks, withoutKernelHooks, installedEvents, hasKernelHooks, hookStatus, refreshHooks, KERNEL_HOOK_EVENTS } from '../src/main/services/hooksInstaller'
import { hookToken, hookTokenFile } from '../src/main/services/hookToken'
import { hookCommand } from '@shared/hookEntry'
import { ghUser, parseGhAuth, prStateOf } from '../src/main/services/github'
import { CLAUDE_INSTALL, compareVersions, nextFreePort, parseClaudeVersion, parseLsof, planName, runPreflight, sessionClaude } from '../src/main/services/preflight'
import type { ExecResult } from '../src/main/services/exec'
import type { PreflightCheck } from '@shared/types'
import { deepMerge, DEFAULT_SETTINGS } from '../src/main/services/settings'
import { matchesRule, describeTool, Approvals } from '../src/main/services/approvals'
import { InputQueue, toUserMessage } from '../src/main/services/sessions'
import { Store } from '../src/main/db'

describe('hooks installer', () => {
  const mine = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }] }
  const token = 'ab'.repeat(32)
  it('adds Kernel hooks next to existing ones', () => {
    const next = withKernelHooks({ hooks: mine, theme: 'dark' }, 7420, 300, token)
    expect(next.theme).toBe('dark')
    expect(next.hooks!.PreToolUse).toHaveLength(2)
    expect(installedEvents(next, token).sort()).toEqual([...KERNEL_HOOK_EVENTS].sort())
    expect(next.hooks!.PermissionRequest[0].hooks[0]).toEqual({ type: 'command', command: hookCommand(7420, 320, token), timeout: 330 })
    expect(next.hooks!.Stop[0].hooks[0]).toEqual({ type: 'command', command: hookCommand(7420, 8, token), timeout: 10 })
    expect(hookCommand(7420, 8, token)).toBe(`/usr/bin/curl -sf --connect-timeout 1 -m 8 -H 'Content-Type: application/json' -H 'X-Kernel-Token: ${token}' --data-binary @- http://127.0.0.1:7420/hooks || true`)
  })
  it('replaces the old http entries, which no longer count as installed', () => {
    const old = { ...mine, Stop: [{ hooks: [{ type: 'http', url: 'http://localhost:7420/hooks', timeout: 10 }] }], PermissionRequest: [{ matcher: '*', hooks: [{ type: 'http', url: 'http://127.0.0.1:7420/hooks', timeout: 330 }] }] }
    expect(installedEvents({ hooks: old }, token)).toEqual([])
    expect(hasKernelHooks({ hooks: old })).toBe(true)
    expect(hasKernelHooks({ hooks: mine })).toBe(false)
    const next = withKernelHooks({ hooks: old }, 7420, 300, token)
    expect(JSON.stringify(next)).not.toContain('"http"')
    expect(next.hooks!.Stop).toHaveLength(1)
    expect(next.hooks!.PreToolUse[0]).toEqual(mine.PreToolUse[0])
    expect(withoutKernelHooks({ hooks: old })).toEqual({ hooks: mine })
  })
  it('counts command entries without the current token as not installed, and rewrites them', () => {
    const tokenless = "/usr/bin/curl -sf --connect-timeout 1 -m 8 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:7420/hooks || true"
    const old = { ...mine, Stop: [{ hooks: [{ type: 'command', command: tokenless, timeout: 10 }] }] }
    expect(installedEvents({ hooks: old }, token)).toEqual([])
    expect(hasKernelHooks({ hooks: old })).toBe(true)
    const other = withKernelHooks({ hooks: mine }, 7420, 300, 'cd'.repeat(32))
    expect(installedEvents(other, token)).toEqual([])
    expect(hasKernelHooks(other)).toBe(true)
    const next = withKernelHooks(other, 7420, 300, token)
    expect(installedEvents(next, token)).toHaveLength(KERNEL_HOOK_EVENTS.length)
    expect(JSON.stringify(next)).not.toContain('cd'.repeat(32))
    expect(next.hooks!.Stop).toHaveLength(1)
  })
  it('is idempotent and removes cleanly', () => {
    const twice = withKernelHooks(withKernelHooks({ hooks: mine }, 7420, 300, token), 7421, 300, token)
    expect(twice.hooks!.PreToolUse).toHaveLength(2)
    expect(withoutKernelHooks(twice)).toEqual({ hooks: mine })
  })
})

describe('hookToken', () => {
  it('makes a 32 byte token once, in a file only the user can read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-token-'))
    const t = hookToken(dir)
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(hookTokenFile(dir)).mode & 0o777).toBe(0o600)
    expect(readFileSync(hookTokenFile(dir), 'utf8').trim()).toBe(t)
    expect(hookToken(dir)).toBe(t)
    expect(hookToken(mkdtempSync(join(tmpdir(), 'kernel-token-')))).not.toBe(t)
  })
  it('reads a token an earlier run saved, and tightens its mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-token-'))
    writeFileSync(hookTokenFile(dir), 'ef'.repeat(32) + '\n', { mode: 0o644 })
    expect(hookToken(dir)).toBe('ef'.repeat(32))
    expect(statSync(hookTokenFile(dir)).mode & 0o777).toBe(0o600)
  })
  it('replaces a damaged token file and leaves no temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-token-'))
    writeFileSync(hookTokenFile(dir), '')
    const t = hookToken(dir)
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(hookTokenFile(dir), 'utf8').trim()).toBe(t)
    expect(readdirSync(dir)).toEqual(['hook-token'])
  })
})

describe('pull request state', () => {
  const pr = { number: 42, url: 'u', state: 'OPEN' as const, isDraft: false, mergeable: 'MERGEABLE' as const, reviewDecision: 'APPROVED' as const, statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
  it('maps GitHub fields to the header state', () => {
    expect(prStateOf(null)).toBe('none')
    expect(prStateOf(pr)).toBe('ready')
    expect(prStateOf({ ...pr, isDraft: true })).toBe('draft')
    expect(prStateOf({ ...pr, mergeable: 'CONFLICTING' })).toBe('conflict')
    expect(prStateOf({ ...pr, statusCheckRollup: [{ name: 'e2e', status: 'COMPLETED', conclusion: 'FAILURE' }] })).toBe('cifail')
    expect(prStateOf({ ...pr, statusCheckRollup: [{ name: 'e2e', status: 'IN_PROGRESS', conclusion: null }] })).toBe('checks')
    expect(prStateOf({ ...pr, reviewDecision: 'CHANGES_REQUESTED' })).toBe('changes')
    expect(prStateOf({ ...pr, state: 'MERGED' })).toBe('merged')
  })
})

describe('installHooks', () => {
  const token = 'ab'.repeat(32)
  it('keeps the old file as a backup and moves the port on a second install', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-hooks-'))
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ theme: 'dark' }), { mode: 0o644 })
    expect(await installHooks(file, 7420, 300, token)).toHaveLength(KERNEL_HOOK_EVENTS.length)
    expect(JSON.parse(readFileSync(file + '.kernel-backup', 'utf8'))).toEqual({ theme: 'dark' })
    await installHooks(file, 7421, 300, token)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('127.0.0.1:7421/hooks')
    expect(text).not.toContain('127.0.0.1:7420/hooks')
    expect(await hookStatus(file, token)).toHaveLength(KERNEL_HOOK_EVENTS.length)
    expect(await hookStatus(file, 'cd'.repeat(32))).toEqual([])
    // The token is in the file now, so only the user can read it. No temp file is left behind.
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).sort()).toEqual(['settings.json', 'settings.json.kernel-backup'])
  })
  it('never overwrites the first backup, on a second install or an uninstall', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kernel-hooks-')), 'settings.json')
    writeFileSync(file, JSON.stringify({ theme: 'dark' }))
    await installHooks(file, 7420, 300, token)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), theme: 'light' }))
    await installHooks(file, 7421, 300, token)
    await uninstallHooks(file)
    expect(JSON.parse(readFileSync(file + '.kernel-backup', 'utf8'))).toEqual({ theme: 'dark' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'light' })
  })
  it('backs up before an uninstall when there was no backup yet', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kernel-hooks-')), 'settings.json')
    const before = JSON.stringify(withKernelHooks({ theme: 'dark' }, 7420, 300, token))
    writeFileSync(file, before)
    await uninstallHooks(file)
    expect(readFileSync(file + '.kernel-backup', 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'dark' })
  })
  it('writes through a symlinked settings file and keeps the link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-hooks-'))
    const real = join(dir, 'dotfiles-settings.json')
    const file = join(dir, 'settings.json')
    writeFileSync(real, JSON.stringify({ theme: 'dark' }))
    symlinkSync(real, file)
    await installHooks(file, 7420, 300, token)
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, 'utf8')).hooks.Stop).toHaveLength(1)
  })
  it('refuses to write the real Claude settings under vitest', async () => {
    const real = join(homedir(), '.claude', 'settings.json')
    await expect(installHooks(real, 7420, 300, token)).rejects.toThrow('Refusing to write')
    await expect(uninstallHooks(real)).rejects.toThrow('Refusing to write')
  })
})

describe('refreshHooks at start (KERNEL-206)', () => {
  const token = 'ab'.repeat(32)
  const tokenless = (port: number, max: number) => `/usr/bin/curl -sf --connect-timeout 1 -m ${max} -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/hooks || true`
  const guard = { matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }
  const temp = (content?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-refresh-'))
    const file = join(dir, 'settings.json')
    if (content !== undefined) writeFileSync(file, content)
    return { dir, file }
  }

  it('rewrites tokenless Kernel entries in place and leaves every other hook alone', async () => {
    const before = {
      theme: 'dark',
      hooks: {
        PreToolUse: [guard, { matcher: '*', hooks: [{ type: 'command', command: tokenless(7420, 8), timeout: 10 }] }],
        PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: tokenless(7420, 320), timeout: 330 }] }],
        Stop: [{ hooks: [{ type: 'command', command: './notify.sh' }, { type: 'command', command: tokenless(7420, 8), timeout: 10 }] }],
        SessionStart: [{ hooks: [{ type: 'http', url: 'http://localhost:7420/hooks' }] }]
      }
    }
    const { dir, file } = temp(JSON.stringify(before))
    expect(await refreshHooks(file, 7420, 300, token)).toBe(true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.theme).toBe('dark')
    expect(after.hooks.PreToolUse).toEqual([guard, { matcher: '*', hooks: [{ type: 'command', command: hookCommand(7420, 8, token), timeout: 10 }] }])
    expect(after.hooks.PermissionRequest[0].hooks[0]).toEqual({ type: 'command', command: hookCommand(7420, 320, token), timeout: 330 })
    expect(after.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: './notify.sh' }, { type: 'command', command: hookCommand(7420, 8, token), timeout: 10 }] }])
    // An event Kernel no longer hooks goes, as Install does. Events the user never had stay out.
    expect(after.hooks.SessionStart).toBeUndefined()
    expect(Object.keys(after.hooks).sort()).toEqual(['PermissionRequest', 'PreToolUse', 'Stop'])
    expect(JSON.parse(readFileSync(file + '.kernel-backup', 'utf8'))).toEqual(before)
    expect(readdirSync(dir).sort()).toEqual(['settings.json', 'settings.json.kernel-backup'])
    // Current now, so the next start writes nothing.
    expect(await refreshHooks(file, 7420, 300, token)).toBe(false)
  })

  it('moves entries to the current port and timeout, and drops a duplicate', async () => {
    const old = withKernelHooks({}, 7421, 600, token)
    old.hooks!.Stop.push({ hooks: [{ type: 'command', command: tokenless(7421, 8), timeout: 10 }] })
    const { file } = temp(JSON.stringify(old))
    expect(await refreshHooks(file, 7420, 300, token)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(withKernelHooks({}, 7420, 300, token))
  })

  it('writes nothing for a user who never installed, or whose hooks are current', async () => {
    const none = temp(JSON.stringify({ hooks: { PreToolUse: [guard] } }))
    expect(await refreshHooks(none.file, 7420, 300, token)).toBe(false)
    expect(readdirSync(none.dir)).toEqual(['settings.json'])
    const missing = temp()
    expect(await refreshHooks(missing.file, 7420, 300, token)).toBe(false)
    expect(existsSync(missing.file)).toBe(false)
    const text = JSON.stringify(withKernelHooks({}, 7420, 300, token))
    const current = temp(text)
    expect(await refreshHooks(current.file, 7420, 300, token)).toBe(false)
    expect(readFileSync(current.file, 'utf8')).toBe(text)
    expect(readdirSync(current.dir)).toEqual(['settings.json'])
  })

  it('throws on a file it cannot parse and leaves it alone', async () => {
    const text = `{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "${tokenless(7420, 8)}" }] }] }, }`
    const { dir, file } = temp(text)
    await expect(refreshHooks(file, 7420, 300, token)).rejects.toThrow('Could not parse')
    const shapeless = temp(JSON.stringify({ hooks: { Stop: 'not a list' } }))
    await expect(refreshHooks(shapeless.file, 7420, 300, token)).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('follows a symlinked settings file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-refresh-'))
    const real = join(dir, 'dotfiles-settings.json')
    const file = join(dir, 'settings.json')
    writeFileSync(real, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: tokenless(7420, 8), timeout: 10 }] }] } }))
    symlinkSync(real, file)
    expect(await refreshHooks(file, 7420, 300, token)).toBe(true)
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, 'utf8')).hooks.Stop[0].hooks[0].command).toBe(hookCommand(7420, 8, token))
  })
})

describe('preflight', () => {
  it('compares versions', () => {
    expect(compareVersions('2.1.284', '2.1.80')).toBe(1)
    expect(compareVersions('2.0.14', '2.1.80')).toBe(-1)
    expect(parseClaudeVersion('2.1.284 (Claude Code)')).toBe('2.1.284')
  })
  it('finds the next free port', async () => {
    const taken = new Set([7420, 7421])
    expect(await nextFreePort(7420, async (p) => taken.has(p))).toBe(7422)
    await expect(nextFreePort(7420, async () => true)).rejects.toThrow('No free port')
  })
  it('reads the process on a busy port and the plan name', () => {
    expect(parseLsof('p4821\ncnode\n')).toEqual({ pid: 4821, name: 'node' })
    expect(parseLsof('')).toBeNull()
    expect(planName('max')).toBe('Claude Max')
    expect(planName(undefined)).toBeUndefined()
  })
  it('finds the claude binary sessions run, not the one on PATH', () => {
    const bin = sessionClaude()
    expect(bin).toContain(`claude-agent-sdk-${process.platform}-${process.arch}`)
    expect(existsSync(bin!)).toBe(true)
  })
})

describe('preflight checks', () => {
  const BIN = '/Kernel.app/claude'
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
  const fail = (code = 1, stderr = ''): ExecResult => ({ code, stdout: '', stderr })
  const missing = fail(127, 'spawn ENOENT')
  const gh = (entry: object | null) => ok(JSON.stringify({ hosts: entry ? { 'github.com': [{ active: true, host: 'github.com', ...entry }] } : {} }))
  const healthy: Record<string, ExecResult> = {
    [`${BIN} --version`]: ok('2.1.292 (Claude Code)\n'),
    'claude --version': ok('2.1.290 (Claude Code)\n'),
    [`${BIN} auth status`]: ok(JSON.stringify({ loggedIn: true, subscriptionType: 'max' })),
    'git --version': ok('git version 2.39.5 (Apple Git-154)\n'),
    'gh auth status --hostname github.com --json hosts': gh({ state: 'success', login: 'samrivera' }),
    'gh --version': ok('gh version 2.62.0 (2024-11-14)\n'),
    'lsof -nP -iTCP:7420 -sTCP:LISTEN -Fpc': ok('p4821\ncnode\n')
  }
  /** Runs preflight with every command answered from `healthy`, overridden by `answers`. */
  const preflight = (answers: Record<string, ExecResult> = {}, o: { hookServerUp?: boolean; claude?: string | null } = {}) => {
    const table = { ...healthy, ...answers }
    const run = async (cmd: string, args: string[]) => table[[cmd, ...args].join(' ')] ?? missing
    return runPreflight({ hookPort: 7420, hookServerUp: o.hookServerUp ?? true, agentTeams: true, run, claude: o.claude === undefined ? BIN : o.claude, nextPort: async (p) => p })
  }
  const blockers = (checks: PreflightCheck[]) => checks.filter((c) => !c.ok && c.blocking).map((c) => c.id)
  const warnings = (checks: PreflightCheck[]) => checks.filter((c) => !c.ok && !c.blocking).map((c) => c.id)
  const byId = (checks: PreflightCheck[], id: PreflightCheck['id']) => checks.find((c) => c.id === id)!

  it('passes everything on a healthy Mac', async () => {
    const checks = await preflight()
    expect(checks.map((c) => c.id)).toEqual(['claude', 'auth', 'teams', 'git', 'gh', 'hooks'])
    expect(checks.every((c) => c.ok)).toBe(true)
    expect(byId(checks, 'claude').meta).toBe('v2.1.292')
    expect(byId(checks, 'gh')).toMatchObject({ detail: 'Signed in as samrivera', meta: 'gh 2.62.0' })
    expect(byId(checks, 'git').meta).toBe('git 2.39.5')
  })
  it('only warns when GitHub is out of reach', async () => {
    const offline = gh({ state: 'error', error: 'Get "https://api.github.com/": dial tcp: lookup api.github.com: no such host', login: 'samrivera' })
    const checks = await preflight({ 'gh auth status --hostname github.com --json hosts': offline })
    expect(blockers(checks)).toEqual([])
    expect(warnings(checks)).toEqual(['gh'])
    expect(byId(checks, 'gh')).toMatchObject({ title: "Can't reach GitHub", fix: { command: 'gh auth status' } })
    // gh timing out or failing outright reads the same way, not as signed out.
    for (const answer of [fail(1), { code: 0, stdout: '{"hosts":{"github.com":[{"state":"timeout","active":true,"login":"samrivera"}]}}', stderr: '' }]) {
      expect(byId(await preflight({ 'gh auth status --hostname github.com --json hosts': answer }), 'gh').title).toBe("Can't reach GitHub")
    }
  })
  it('only warns when gh is signed out, its token is revoked, or gh is missing', async () => {
    const revoked = gh({ state: 'error', error: 'non-200 OK status code: 401 Unauthorized body: "Bad credentials"', login: '' })
    for (const answer of [gh(null), revoked]) {
      const checks = await preflight({ 'gh auth status --hostname github.com --json hosts': answer })
      expect(blockers(checks)).toEqual([])
      expect(byId(checks, 'gh')).toMatchObject({ ok: false, title: 'GitHub CLI is not signed in', fix: { command: 'gh auth login' } })
    }
    const none = await preflight({ 'gh auth status --hostname github.com --json hosts': missing, 'gh --version': missing })
    expect(blockers(none)).toEqual([])
    expect(byId(none, 'gh')).toMatchObject({ ok: false, title: 'GitHub CLI not found' })
    expect(byId(none, 'gh').detail).toContain('Pull requests need gh')
  })
  it('reads an older gh that has no --json on auth status', async () => {
    const run = async (_cmd: string, args: string[]) => args.includes('--json')
      ? fail(1, 'unknown flag: --json')
      : { code: 0, stdout: '', stderr: 'github.com\n  ✓ Logged in to github.com as samrivera (oauth_token)\n' }
    expect(await ghUser(run)).toBe('samrivera')
    const signedOut = async (_cmd: string, args: string[]) => args.includes('--json') ? fail(1, 'unknown flag: --json') : fail(1, 'You are not logged into any GitHub hosts.')
    expect(await ghUser(signedOut)).toBeNull()
  })
  it('gives ghUser a login only when GitHub confirmed it', async () => {
    expect(parseGhAuth('{"hosts":{"github.com":[{"state":"success","active":true,"login":"sam"}]}}')).toEqual({ state: 'ok', login: 'sam' })
    expect(parseGhAuth('{"hosts":{"github.com":[{"state":"timeout","active":true,"login":"sam"}]}}')).toEqual({ state: 'offline', login: 'sam' })
    expect(parseGhAuth('not json')).toBeNull()
    expect(await ghUser(async () => gh({ state: 'timeout', login: 'sam' }))).toBeNull()
  })
  it('only warns when agent teams are off', async () => {
    const run = async (cmd: string, args: string[]) => healthy[[cmd, ...args].join(' ')] ?? missing
    const checks = await runPreflight({ hookPort: 7420, hookServerUp: true, agentTeams: false, run, claude: BIN })
    expect(blockers(checks)).toEqual([])
    expect(warnings(checks)).toEqual(['teams'])
  })
  it('blocks when signed out of Claude', async () => {
    const checks = await preflight({ [`${BIN} auth status`]: ok(JSON.stringify({ loggedIn: false })) })
    expect(blockers(checks)).toEqual(['auth'])
  })
  it('blocks when the hook port is taken', async () => {
    const checks = await preflight({}, { hookServerUp: false })
    expect(blockers(checks)).toEqual(['hooks'])
    expect(byId(checks, 'hooks').detail).toBe('Another process (node, pid 4821) is using it. Kernel can listen on 7421 and update your hooks.')
  })
  it('blocks without git and warns on git older than 2.38', async () => {
    const none = await preflight({ 'git --version': missing })
    expect(blockers(none)).toEqual(['git'])
    expect(byId(none, 'git').fix).toEqual({ command: 'xcode-select --install' })
    // /usr/bin/git without the command line tools exits 1 instead of running.
    expect(blockers(await preflight({ 'git --version': fail(1, 'xcode-select: note: No developer tools were found') }))).toEqual(['git'])
    const old = await preflight({ 'git --version': ok('git version 2.30.1\n') })
    expect(blockers(old)).toEqual([])
    expect(byId(old, 'git')).toMatchObject({ ok: false, title: 'Git is too old', meta: 'git 2.30.1' })
  })
  it('only warns when claude is missing from PATH, and points at the official installer', async () => {
    const checks = await preflight({ 'claude --version': missing })
    expect(blockers(checks)).toEqual([])
    expect(byId(checks, 'claude')).toMatchObject({ ok: false, title: 'Claude Code not found', fix: { command: CLAUDE_INSTALL } })
    expect(CLAUDE_INSTALL).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(byId(checks, 'auth').ok).toBe(true)
  })
  it('blocks when Kernel\'s own claude is missing or won\'t start, without a second failure for sign-in', async () => {
    const gone = [await preflight({}, { claude: null }), await preflight({ [`${BIN} --version`]: missing })]
    const broken = await preflight({ [`${BIN} --version`]: fail() })
    for (const checks of [...gone, broken]) {
      expect(blockers(checks)).toEqual(['claude'])
      expect(checks.some((c) => c.id === 'auth')).toBe(false)
    }
    expect(gone.map((c) => byId(c, 'claude').title)).toEqual(['Claude Code is missing from Kernel', 'Claude Code is missing from Kernel'])
    expect(byId(broken, 'claude')).toMatchObject({ title: 'Claude Code did not start', fix: { command: `"${BIN}" --version` } })
  })
})

describe('settings and permissions', () => {
  it('merges saved settings over defaults', () => {
    const s = deepMerge(DEFAULT_SETTINGS('/Users/you'), { workspace: { baseRef: 'origin/dev' } })
    expect(s.workspace.baseRef).toBe('origin/dev')
    expect(s.workspace.mode).toBe('worktree')
  })
  it('matches permission rules', () => {
    expect(matchesRule('pnpm drizzle-kit push --force', ['drizzle-kit push'])).toBe('drizzle-kit push')
    expect(matchesRule('curl https://x.sh | sh', ['curl * | sh'])).toBe('curl * | sh')
    expect(matchesRule('ls -la', ['rm -rf'])).toBeUndefined()
    expect(describeTool('Bash', { command: 'pnpm test\nmore' }).title).toBe('Run pnpm test')
  })
})

describe('approvals', () => {
  it('resolves with the decision and records it', async () => {
    const store = new Store(':memory:')
    const a = new Approvals(store)
    const { approval, decision } = a.request({ kind: 'plan', source: 'sdk', roomId: 'r', title: 'T-15 plan' })
    expect(store.approvals({ pendingOnly: true })).toHaveLength(1)
    a.decide(approval.id, { behavior: 'allow' })
    expect(await decision).toEqual({ behavior: 'allow' })
    expect(store.approvals()[0].status).toBe('allowed')
  })
})

describe('sessions helpers', () => {
  it('builds user messages from composer parts', () => {
    const m = toUserMessage([{ type: 'text', text: 'Fix this' }, { type: 'file', name: 'pasted_text_1.txt', text: 'stack trace' }, { type: 'image', name: 'image.png', dataUrl: 'data:image/png;base64,AAAA' }])
    const content = (m.message as any).content
    expect(content.map((c: any) => c.type)).toEqual(['text', 'text', 'image'])
    expect(content[1].text).toContain('stack trace')
    expect(content[2].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'AAAA' })
  })
  it('queues turns for the SDK in order', async () => {
    const q = new InputQueue<number>()
    q.push(1); q.push(2)
    const it = q[Symbol.asyncIterator]()
    expect((await it.next()).value).toBe(1)
    expect((await it.next()).value).toBe(2)
    const later = it.next()
    q.push(3)
    expect((await later).value).toBe(3)
    q.close()
    expect((await it.next()).done).toBe(true)
  })
})
