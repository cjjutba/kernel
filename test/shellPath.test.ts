import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commonBins, mergePath, parseShellPath, refreshPath, shellPath } from '../src/main/services/shellPath'

const MARK = '__KERNEL_PATH__'

/** A stand-in login shell that prints rc noise around the marked PATH, whatever it is asked to run. */
async function fakeShell(path: string) {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-shell-'))
  const file = join(dir, 'zsh')
  await writeFile(file, `#!/bin/sh\necho "Last login: Thu Oct  8 on ttys001"\nprintf '${MARK}${path}${MARK}'\necho "nvm: using node v20"\n`)
  await chmod(file, 0o755)
  return file
}

describe('parseShellPath', () => {
  it('skips what rc files print around the markers', () => {
    expect(parseShellPath(`Last login: today\n${MARK}/opt/homebrew/bin:/usr/bin${MARK}\nwelcome back\n`)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('is null without markers or with an empty PATH', () => {
    expect(parseShellPath('zsh: command not found: printf')).toBeNull()
    expect(parseShellPath(`${MARK}${MARK}`)).toBeNull()
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
})

describe('shellPath', () => {
  it("reads PATH from the user's shell", async () => {
    expect(await shellPath(await fakeShell('/opt/homebrew/bin:/usr/bin'))).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('is null when the shell cannot start', async () => {
    expect(await shellPath('/nonexistent/zsh')).toBeNull()
  })

  it('gives up when something the rc started holds stdout open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-shell-'))
    const shell = join(dir, 'zsh')
    await writeFile(shell, '#!/bin/sh\nsleep 3 &\nsleep 3\n')
    await chmod(shell, 0o755)
    const started = Date.now()
    expect(await shellPath(shell, 200)).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('refreshPath', () => {
  const before = process.env.PATH
  afterEach(() => { process.env.PATH = before })

  it("puts the shell's PATH ahead of the launch PATH and the usual folders", async () => {
    await refreshPath(await fakeShell('/shell/one:/shell/two'))
    const dirs = process.env.PATH!.split(':')
    expect(dirs.slice(0, 2)).toEqual(['/shell/one', '/shell/two'])
    expect(dirs).toEqual(expect.arrayContaining([...before!.split(':').filter(Boolean), '/opt/homebrew/bin']))
  })

  it('gives the same PATH when run again', async () => {
    const shell = await fakeShell('/shell/one:/shell/two')
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
    await writeFile(shell, `#!/bin/sh\nif [ -f ${extra} ]; then p=/new/bin:/usr/bin; else p=/usr/bin; fi\nprintf '${MARK}%s${MARK}' "$p"\n`)
    await chmod(shell, 0o755)
    await refreshPath(shell)
    expect(process.env.PATH!.split(':')).not.toContain('/new/bin')
    await writeFile(extra, '')
    await refreshPath(shell)
    expect(process.env.PATH!.split(':')[0]).toBe('/new/bin')
  })

  it('still adds the usual folders when the shell cannot be read', async () => {
    await refreshPath('/nonexistent/zsh')
    expect(process.env.PATH!.split(':')).toContain('/opt/homebrew/bin')
  })
})
