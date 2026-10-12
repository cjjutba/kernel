import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commonBins, GH_TOKENS, mergePath, parseShellEnv, rcFile, readShell, refreshPath, SHELL_VARS } from '../src/main/services/shellPath'
import { sessionEnv } from '../src/main/services/sessions'
import { codexEnv } from '../src/main/services/providers/codex/client'

const MARK = '__KERNEL_ENV__'

/**
 * A stand-in login shell: it prints rc noise, exports `vars` the way a .zshrc would, then runs the command Kernel passes
 * (`-ilc <command>`) with /bin/sh, so the test covers the real printf.
 */
async function fakeShell(vars: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-shell-'))
  const file = join(dir, 'zsh')
  const exports = Object.entries(vars).map(([k, v]) => `export ${k}='${v}'`).join('\n')
  await writeFile(file, `#!/bin/sh\necho "Last login: Thu Oct  8 on ttys001"\n${exports}\n/bin/sh -c "$2"\necho "nvm: using node v20"\n`)
  await chmod(file, 0o755)
  return file
}

describe('parseShellEnv', () => {
  it('skips what rc files print around the markers and keeps only the names Kernel reads', () => {
    const out = `Last login: today\n${MARK}PATH=/opt/homebrew/bin:/usr/bin\0HTTPS_PROXY=http://u:p@proxy:3128/?a=b\0SECRET=x\0NO_PROXY=\0${MARK}\nwelcome back\n`
    expect(parseShellEnv(out)).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', HTTPS_PROXY: 'http://u:p@proxy:3128/?a=b' })
  })

  it('is null without markers', () => {
    expect(parseShellEnv('zsh: command not found: printf')).toBeNull()
  })
})

describe('mergePath', () => {
  it('keeps the first copy of each folder, in order', () => {
    expect(mergePath('/a:/b', '/usr/bin:/a', null, undefined, '/b:/c')).toBe('/a:/b:/usr/bin:/c')
  })

  it('drops empty entries', () => {
    expect(mergePath('/a::/b:', '')).toBe('/a:/b')
  })
})

describe('commonBins', () => {
  it('covers Homebrew and the per-user install folders', () => {
    expect(commonBins('/Users/you')).toEqual(expect.arrayContaining(['/opt/homebrew/bin', '/usr/local/bin', '/Users/you/.local/bin']))
  })

  it("covers fnm's default, asdf, mise and pyenv shims", () => {
    expect(commonBins('/Users/you')).toEqual(expect.arrayContaining([
      '/Users/you/.local/share/fnm/aliases/default/bin', '/Users/you/.asdf/shims', '/Users/you/.local/share/mise/shims', '/Users/you/.pyenv/shims'
    ]))
  })

  it("takes nvm's default alias, else its newest Node", async () => {
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    const node = join(home, '.nvm', 'versions', 'node')
    for (const v of ['v18.20.0', 'v20.9.0', 'v20.11.1', 'v22.1.0']) await mkdir(join(node, v, 'bin'), { recursive: true })
    const nvm = () => commonBins(home).filter((d) => d.includes('.nvm'))
    expect(nvm()).toEqual([join(node, 'v22.1.0', 'bin')])
    await mkdir(join(home, '.nvm', 'alias'), { recursive: true })
    await writeFile(join(home, '.nvm', 'alias', 'default'), '20\n')
    expect(nvm()).toEqual([join(node, 'v20.11.1', 'bin')])
    await writeFile(join(home, '.nvm', 'alias', 'default'), 'lts/*\n')
    expect(nvm()).toEqual([join(node, 'v22.1.0', 'bin')])
  })

  it('adds no nvm folder without nvm', () => {
    expect(commonBins('/nonexistent/home').some((d) => d.includes('.nvm'))).toBe(false)
  })
})

describe('readShell', () => {
  it("reads PATH and Kernel's variables from the user's shell, and nothing else", async () => {
    const shell = await fakeShell({ PATH: '/opt/homebrew/bin:/usr/bin', HTTPS_PROXY: 'http://proxy.corp:3128', NODE_EXTRA_CA_CERTS: '/etc/corp.pem', CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', SECRET_THING: 'nope' })
    const read = await readShell(shell)
    expect(read.timedOut).toBe(false)
    expect(read.vars).toMatchObject({ PATH: '/opt/homebrew/bin:/usr/bin', HTTPS_PROXY: 'http://proxy.corp:3128', NODE_EXTRA_CA_CERTS: '/etc/corp.pem', CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' })
    expect(read.vars).not.toHaveProperty('SECRET_THING')
  })

  it('reads nothing, without a timeout, when the shell cannot start', async () => {
    expect(await readShell('/nonexistent/zsh')).toEqual({ vars: null, timedOut: false })
  })

  it('times out when something the rc started holds stdout open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-shell-'))
    const shell = join(dir, 'zsh')
    await writeFile(shell, '#!/bin/sh\nsleep 3 &\nsleep 3\n')
    await chmod(shell, 0o755)
    const started = Date.now()
    expect(await readShell(shell, 200)).toEqual({ vars: null, timedOut: true })
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('rcFile', () => {
  it("names the shell's startup file", () => {
    expect(rcFile('/bin/zsh')).toBe('.zshrc')
    expect(rcFile('/opt/homebrew/bin/bash')).toBe('.bash_profile')
    expect(rcFile('/bin/sh')).toBe('.profile')
  })
})

describe('refreshPath', () => {
  const names = ['PATH', ...SHELL_VARS, ...GH_TOKENS]
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]))
  afterEach(() => {
    for (const n of names) {
      if (before[n] === undefined) delete process.env[n]
      else process.env[n] = before[n]
    }
  })

  it("puts the shell's PATH ahead of the launch PATH and the usual folders", async () => {
    await refreshPath(await fakeShell({ PATH: '/shell/one:/shell/two' }))
    const dirs = process.env.PATH!.split(':')
    expect(dirs.slice(0, 2)).toEqual(['/shell/one', '/shell/two'])
    expect(dirs).toEqual(expect.arrayContaining([...before.PATH!.split(':').filter(Boolean), '/opt/homebrew/bin']))
  })

  it('gives the same PATH when run again', async () => {
    const shell = await fakeShell({ PATH: '/shell/one:/shell/two' })
    await refreshPath(shell)
    const first = process.env.PATH
    await refreshPath(shell)
    expect(process.env.PATH).toBe(first)
  })

  it('picks up a folder the shell gained after launch, as "Check again" needs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-shell-'))
    const extra = join(dir, 'extra')
    const shell = join(dir, 'zsh')
    // The shell adds a folder once an installer has written it, like `~/.local/bin` after the Claude Code installer runs.
    await writeFile(shell, `#!/bin/sh\nif [ -f ${extra} ]; then export PATH=/new/bin:/usr/bin; else export PATH=/usr/bin; fi\n/bin/sh -c "$2"\n`)
    await chmod(shell, 0o755)
    await refreshPath(shell)
    expect(process.env.PATH!.split(':')).not.toContain('/new/bin')
    await writeFile(extra, '')
    await refreshPath(shell)
    expect(process.env.PATH!.split(':')[0]).toBe('/new/bin')
  })

  it('still adds the usual folders when the shell cannot be read', async () => {
    expect(await refreshPath('/nonexistent/zsh')).toEqual({ shell: '/nonexistent/zsh', timeoutMs: 10_000, timedOut: false })
    expect(process.env.PATH!.split(':')).toContain('/opt/homebrew/bin')
  })

  it("gives sessions and Codex the shell's proxy, certificates and provider, and drops what the shell stops setting", async () => {
    const vars = { HTTPS_PROXY: 'http://proxy.corp:3128', NO_PROXY: 'localhost,.corp', NODE_EXTRA_CA_CERTS: '/etc/corp.pem', SSL_CERT_FILE: '/etc/corp.pem', CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'corp-ai', CLOUD_ML_REGION: 'us-east5', ANTHROPIC_BASE_URL: 'https://gateway.corp', LINEAR_API_KEY: 'lin_api_test' }
    await refreshPath(await fakeShell({ PATH: '/usr/bin:/bin', ...vars }))
    expect(sessionEnv(process.env, {})).toMatchObject(vars)
    expect(codexEnv(process.env, undefined)).toMatchObject(vars)
    await refreshPath(await fakeShell({ PATH: '/usr/bin:/bin' }))
    expect(process.env.CLOUD_ML_REGION).toBe(before.CLOUD_ML_REGION)
  })

  it('says when the shell timed out, and the answer holds no values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-shell-'))
    const shell = join(dir, 'zsh')
    await writeFile(shell, '#!/bin/sh\nsleep 3 &\nsleep 3\n')
    await chmod(shell, 0o755)
    expect(await refreshPath(shell, { timeoutMs: 200 })).toEqual({ shell, timeoutMs: 200, timedOut: true })
  })

  it('passes GH_TOKEN on only while gh has no stored login', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-gh-'))
    const stored = join(dir, 'stored')
    // gh answers `auth token` from its stored login only when no token variable is set, as the real one does.
    await writeFile(join(dir, 'gh'), `#!/bin/sh\nif [ "$1 $2" = "auth token" ] && [ -z "$GH_TOKEN" ] && [ -z "$GITHUB_TOKEN" ] && [ -f ${stored} ]; then echo gho_stored; exit 0; fi\nexit 1\n`)
    await chmod(join(dir, 'gh'), 0o755)
    const shell = await fakeShell({ PATH: `${dir}:/usr/bin:/bin`, GH_TOKEN: 'ghp_from_zshrc' })

    const alone = await refreshPath(shell)
    expect(alone.ghToken).toEqual({ name: 'GH_TOKEN', passed: true })
    expect(process.env.GH_TOKEN).toBe('ghp_from_zshrc')
    expect(JSON.stringify(alone)).not.toContain('ghp_')

    // Signed in since: gh would pick the token over that login, so Kernel leaves it out, even though it set it last time.
    await writeFile(stored, '')
    expect((await refreshPath(shell)).ghToken).toEqual({ name: 'GH_TOKEN', passed: false })
    expect(process.env.GH_TOKEN).toBeUndefined()
  })
})
