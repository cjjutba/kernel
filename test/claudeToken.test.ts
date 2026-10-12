import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asksForCode, loginClaude, signInLink } from '../src/main/services/providers/claudeToken'
import { fakeClaude, LINK } from './helpers/fakeClaude'

// Claude's sign-in in a pty (KERNEL-567): `claude auth login` in an account's folder, its link and code prompt passed on.

describe("reading the CLI's sign-in output", () => {
  it('finds the sign-in link and the code prompt', () => {
    expect(signInLink(`x \x1b]8;;${LINK}\x07${LINK}\x1b]8;;\x07`)).toBe(LINK)
    expect(signInLink(`If the browser didn't open, visit: ${LINK}\r\n`)).toBe(LINK)
    expect(asksForCode('\x1b[2mPaste code here if prompted > \x1b[22m')).toBe(true)
    expect(asksForCode('Opening browser')).toBe(false)
  })
})

describe('running claude auth login in a pty', () => {
  const env = (home: string, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '', HOME: tmpdir(), CLAUDE_CONFIG_DIR: home, ...extra })

  it('passes on the link and the code prompt at once, types the code, and finishes on Login successful', async () => {
    const claude = await fakeClaude()
    const home = join(await mkdtemp(join(tmpdir(), 'kernel-home-')), 'acct')
    const codeFile = join(await mkdtemp(join(tmpdir(), 'kernel-code-')), 'code')
    const links: string[] = []
    let asked = 0
    const run = loginClaude(claude.bin, { env: env(home, { FAKE_CODE_FILE: codeFile, FAKE_EMAIL: 'me@example.com' }), cwd: tmpdir(), timeoutMs: 10_000, onLink: (u) => links.push(u), onCode: () => { asked++; run.sendCode('  abc#123  ') } })
    await run.done
    expect(links).toEqual([LINK])
    expect(asked).toBe(1)
    expect((await readFile(codeFile, 'utf8')).trim()).toBe('abc#123')
    // The login is the folder's, and the CLI's own stays as it was.
    expect(await claude.logins()).toEqual({ cli: { email: 'cj@example.com', plan: 'max' }, [home]: { email: 'me@example.com', plan: 'pro' } })
  })

  it("fails with the CLI's reason, and on Cancel", async () => {
    const claude = await fakeClaude()
    const home = join(await mkdtemp(join(tmpdir(), 'kernel-home-')), 'acct')
    await expect(loginClaude(claude.bin, { env: env(home, { FAKE_LOGIN_FAIL: '1' }), cwd: tmpdir(), timeoutMs: 10_000 }).done).rejects.toThrow('Claude Code said: OAuth error: Request failed with status code 400')
    const run = loginClaude(claude.bin, { env: env(home, { FAKE_LOGIN_WAIT: '1' }), cwd: tmpdir(), timeoutMs: 10_000, onCode: () => run.cancel() })
    await expect(run.done).rejects.toThrow('Sign-in canceled.')
    expect(Object.keys(await claude.logins())).toEqual(['cli'])
  })
})
