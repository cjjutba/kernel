import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asksForCode, captureClaudeToken, isClaudeToken, signInLink, tokenFrom } from '../src/main/services/providers/claudeToken'
import { fakeClaude, LINK, TOKEN } from './helpers/fakeClaude'

// Add account for Claude (KERNEL-406): the token `claude setup-token` prints, picked out of a pty's output.

describe('reading the token setup-token prints', () => {
  const printed = (lines: string[]) => lines.join('\r\n') + '\r\n'

  it('takes a token that fits on one line, through colors', () => {
    expect(TOKEN.length).toBe(108)
    expect(tokenFrom(printed(['Your OAuth token (valid for 1 year):', '', `\x1b[33m${TOKEN}\x1b[39m`, '', 'Store this token securely.']))).toBe(TOKEN)
  })

  it('joins a token the terminal wrapped across two lines', () => {
    expect(tokenFrom(printed(['Your OAuth token (valid for 1 year):', `  ${TOKEN.slice(0, 60)}`, `  ${TOKEN.slice(60)}`, '', 'Store this token securely.']))).toBe(TOKEN)
  })

  it("doesn't take the placeholder, a piece of a token, or text after a token", () => {
    expect(tokenFrom(printed(['Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>']))).toBeUndefined()
    // A narrow terminal can leave the token out, or cut it short.
    expect(tokenFrom(printed([TOKEN.slice(0, 60), '', 'Store this token securely.']))).toBeUndefined()
    expect(tokenFrom(printed([`${TOKEN.slice(0, 60)}…`, TOKEN.slice(60)]))).toBeUndefined()
    expect(isClaudeToken(`${TOKEN}${'x'.repeat(20)}`)).toBe(false)
    expect(isClaudeToken(TOKEN.replace('oat01', 'api03'))).toBe(false)
  })

  it('waits for the end of a line while the CLI is still printing', () => {
    // 104 characters arrived, which would pass for a token.
    expect(tokenFrom(`token:\r\n${TOKEN.slice(0, 104)}`)).toBeUndefined()
    expect(tokenFrom(`token:\r\n${TOKEN}\r\n`)).toBe(TOKEN)
    expect(tokenFrom(`token:\r\n${TOKEN}`, { done: true })).toBe(TOKEN)
  })

  it('finds the sign-in link and the code prompt', () => {
    expect(signInLink(`x \x1b]8;;${LINK}\x07${LINK}\x1b]8;;\x07`)).toBe(LINK)
    expect(signInLink(`Browser didn't open? Use the url below to sign in\r\n${LINK}\r\n`)).toBe(LINK)
    expect(asksForCode('\x1b[2mPaste code here if prompted > \x1b[22m')).toBe(true)
    expect(asksForCode('Opening browser')).toBe(false)
  })
})

describe('running setup-token in a pty', () => {
  const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '', HOME: tmpdir(), ...extra })

  it('passes on the link, types the code into the prompt, and joins a wrapped token', async () => {
    const bin = await fakeClaude()
    const codeFile = join(await mkdtemp(join(tmpdir(), 'kernel-code-')), 'code')
    const links: string[] = []
    let asked = 0
    const c = captureClaudeToken(bin, { env: env({ FAKE_CODE_FILE: codeFile, FAKE_WRAP: '60' }), cwd: tmpdir(), timeoutMs: 10_000, onLink: (u) => links.push(u), onCode: () => { asked++; c.sendCode('  abc#123  ') } })
    // The CLI sleeps after printing it, so the token is taken without waiting for it to exit.
    const started = Date.now()
    expect(await c.token).toBe(TOKEN)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(links).toEqual([LINK])
    expect(asked).toBe(1)
    expect((await readFile(codeFile, 'utf8')).trim()).toBe('abc#123')
  })

  it('fails when the CLI ends without a token, and on Cancel', async () => {
    const bin = await fakeClaude()
    await expect(captureClaudeToken(bin, { env: env({ FAKE_NO_TOKEN: '1' }), cwd: tmpdir(), timeoutMs: 10_000 }).token).rejects.toThrow("Kernel couldn't read a token from claude setup-token.")
    const c = captureClaudeToken(bin, { env: env({ FAKE_CODE_FILE: join(tmpdir(), 'never') }), cwd: tmpdir(), timeoutMs: 10_000, onCode: () => c.cancel() })
    await expect(c.token).rejects.toThrow('Sign-in canceled.')
  })
})
