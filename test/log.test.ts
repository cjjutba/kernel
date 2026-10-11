import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { diagnostics, Log, redact } from '../src/main/services/log'
import { hookToken, hookTokenFile } from '../src/main/services/hookToken'
import { hookCommand } from '../src/shared/hookEntry'

// KERNEL-288: main's errors land in a rotating log, and Help, Copy diagnostics copies it with no token and no home path.
const dirs: string[] = []
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'kernel-log-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const HOME = '/Users/someone'

describe('redact', () => {
  it('replaces the home folder with ~, and only the whole folder', () => {
    expect(redact(`${HOME}/Projects/app failed, cwd ${HOME}`, { home: HOME })).toBe('~/Projects/app failed, cwd ~')
    expect(redact(`'${HOME}/x' file://${HOME}/y (${HOME})`, { home: HOME })).toBe("'~/x' file://~/y (~)")
    expect(redact('/Users/someoneelse/x', { home: HOME })).toBe('/Users/someoneelse/x')
  })

  it('hides the hook token from the hook command and the token file', () => {
    const data = temp()
    const token = hookToken(data)
    const secrets = () => [readFileSync(hookTokenFile(data), 'utf8').trim()]
    const cmd = hookCommand(4317, 300, token)
    expect(cmd).toContain(token)
    const out = redact(`[hooks] wrote ${cmd}\ntoken file says ${token}`, { secrets })
    expect(out).not.toContain(token)
    expect(out).toContain('X-Kernel-Token: [redacted]')
    // Without the file to read it from, the token's shape still gives it away.
    expect(redact(`header X-Kernel-Token: ${token}; again ${token}`)).not.toContain(token)
  })

  it('hides GitHub, Anthropic and other tokens, and credentials in URLs and key=value pairs', () => {
    const secrets = [
      'ghp_' + 'a'.repeat(36), 'gho_' + 'B1'.repeat(18), 'ghs_' + 'c'.repeat(36), 'github_pat_' + '11ABC_'.repeat(8),
      'sk-ant-api03-' + 'x'.repeat(40), 'lin_api_' + 'k'.repeat(40), 'xoxb-1234-5678-abcdefghij', 'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'hunter2hunter2'
    ]
    const text = [
      `git push https://x-access-token:${secrets[2]}@github.com/o/r.git`,
      `GH_TOKEN=${secrets[0]} gh pr list`, `oauth ${secrets[1]}`, `pat ${secrets[3]}`,
      `{"apiKey": "${secrets[4]}"}`, `linear ${secrets[5]}`, `slack ${secrets[6]}`, `aws ${secrets[7]}`,
      `Authorization: Bearer ${secrets[8]}`, `password=${secrets[9]}`
    ].join('\n')
    const out = redact(text)
    for (const s of secrets) expect(out).not.toContain(s)
    expect(out).toContain('https://[redacted]@github.com/o/r.git')
  })

  it('leaves commit hashes, counts and ordinary words alone', () => {
    const text = 'merged 3f786850e387550fdab836ed7e6dc881de23001b, input_tokens: 500, the token expired'
    expect(redact(text)).toBe(text)
  })
})

describe('Log', () => {
  it('writes timestamped lines with the level, redacted, and reads the last ones back', () => {
    const dir = temp()
    const log = new Log({ dir, home: HOME, now: () => new Date('2026-10-11T00:00:00.000Z') })
    log.error('[kernel] boom in', `${HOME}/repo`, new Error('disk full'))
    log.warn('[hooks] token', 'ghp_' + 'z'.repeat(36))
    const text = readFileSync(join(dir, 'main.log'), 'utf8')
    expect(text).toMatch(/^2026-10-11T00:00:00\.000Z ERROR \[kernel\] boom in ~\/repo Error: disk full\n {4}at /)
    expect(text).not.toContain(HOME)
    expect(text).not.toContain('z'.repeat(36))
    expect(log.tail(1)).toEqual(['2026-10-11T00:00:00.000Z WARN [hooks] token [redacted]'])
  })

  it('rotates at the size limit and keeps the given number of files', () => {
    const dir = temp()
    const log = new Log({ dir, maxBytes: 200, files: 3 })
    for (let i = 0; i < 20; i++) log.error(`line ${i} ${'x'.repeat(60)}`)
    expect(existsSync(join(dir, 'main.log.1'))).toBe(true)
    expect(existsSync(join(dir, 'main.log.2'))).toBe(true)
    expect(existsSync(join(dir, 'main.log.3'))).toBe(false)
    for (const f of ['main.log', 'main.log.1', 'main.log.2']) expect(readFileSync(join(dir, f)).length).toBeLessThanOrEqual(200)
    // The tail reaches back into the older file, in order.
    const tail = log.tail(4).map((l) => /line (\d+)/.exec(l)?.[1])
    expect(tail).toEqual(['16', '17', '18', '19'])
  })

  it('carries on from the size a log already has', () => {
    const dir = temp()
    writeFileSync(join(dir, 'main.log'), 'y'.repeat(190) + '\n')
    new Log({ dir, maxBytes: 200 }).error('one more line')
    expect(readFileSync(join(dir, 'main.log.1'), 'utf8')).toBe('y'.repeat(190) + '\n')
  })

  it('never throws when it can\'t write', () => {
    const dir = temp()
    const log = new Log({ dir: join(dir, 'gone') })
    rmSync(join(dir, 'gone'), { recursive: true })
    writeFileSync(join(dir, 'gone'), 'a file where the folder was')
    const undo = log.captureConsole()
    try {
      expect(() => console.error('[kernel] disk is full')).not.toThrow()
    } finally { undo() }
  })

  it('hears console.error and console.warn until undone', () => {
    const dir = temp()
    const log = new Log({ dir })
    const undo = log.captureConsole()
    try {
      console.warn('[test] a warning')
      console.error('[test] an error', { code: 'ENOSPC' })
    } finally { undo() }
    console.error('[test] after undo')
    const text = readFileSync(join(dir, 'main.log'), 'utf8')
    expect(text).toContain('WARN [test] a warning')
    expect(text).toContain("ERROR [test] an error { code: 'ENOSPC' }")
    expect(text).not.toContain('after undo')
  })
})

describe('diagnostics', () => {
  const run = async (cmd: string) => (cmd === 'gh'
    ? { code: 0, stdout: 'gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0\n', stderr: '' }
    : { code: 0, stdout: '2.1.90 (Claude Code)\n', stderr: '' })

  it('has the versions, the hook port and the last 200 log lines, with no token and no home path', async () => {
    const data = temp()
    const token = hookToken(data)
    const secrets = () => [readFileSync(hookTokenFile(data), 'utf8').trim()]
    const log = new Log({ dir: join(data, 'logs'), home: HOME, secrets })
    for (let i = 0; i < 250; i++) log.info(`line ${i}`)
    // A line written before redaction knew the token, as from an older build.
    writeFileSync(log.file, `old ${hookCommand(4317, 300, token)} in ${HOME}/x\n`, { flag: 'a' })
    const text = await diagnostics({ app: '1.4.0', macos: '15.1.0', arch: 'arm64', electron: '38.1.0', hookPort: 4317, log, run, claude: '/bin/claude', home: HOME, secrets })
    expect(text).toContain('Kernel 1.4.0\nmacOS 15.1.0 (arm64)\nElectron 38.1.0\nClaude Code v2.1.90\nGitHub CLI v2.62.0\nHook port 4317\n')
    const lines = text.split('\n')
    const from = lines.findIndex((l) => l.startsWith('Last 200 lines of'))
    expect(lines.slice(from + 1, -1)).toHaveLength(200)
    expect(lines.at(-2)).toBe('old ' + redact(hookCommand(4317, 300, token), { secrets }) + ' in ~/x')
    expect(text).not.toContain(token)
    expect(text).not.toContain(HOME)
  })

  it('says what it could not find', async () => {
    const text = await diagnostics({ app: '1.4.0', macos: '15.1.0', arch: 'arm64', electron: '38.1.0', run: async () => ({ code: 127, stdout: '', stderr: '' }), claude: null })
    expect(text).toContain('Claude Code not found\nGitHub CLI not found\nHook port unknown\n\nThe log is off in this run.')
  })
})
