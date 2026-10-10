import { describe, expect, it } from 'vitest'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks, uninstallHooks, withKernelHooks, withoutKernelHooks, installedEvents, hasKernelHooks, hookStatus, KERNEL_HOOK_EVENTS } from '../src/main/services/hooksInstaller'
import { hookToken, hookTokenFile } from '../src/main/services/hookToken'
import { hookCommand } from '@shared/hookEntry'
import { prStateOf } from '../src/main/services/github'
import { compareVersions, nextFreePort, parseClaudeVersion, parseLsof, planName } from '../src/main/services/preflight'
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
