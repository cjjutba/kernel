import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../src/main/services/exec'
import { linkNodeModules } from '../src/main/services/scripts'
import { bypassSandbox, gitFolder, onSandboxFallback, sandboxFallbackNote } from '../src/main/services/providers/sandbox'
import { tempRepo } from './helpers'

// KERNEL-458: the sandbox a Claude process in Bypass permissions runs its commands in, from KERNEL-436's draft.

const temp = async (name: string) => realpath(await mkdtemp(join(tmpdir(), `kernel-${name}-`)))
const gitSays = async (cwd: string) => realpath((await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim())

/** A repo with node_modules, and a worktree Kernel linked them into. */
async function repoWithWorktree() {
  const repo = await realpath(await tempRepo({ 'README.md': '# demo\n', '.gitignore': 'node_modules\n' }))
  await mkdir(join(repo, 'node_modules', 'left-pad'), { recursive: true })
  const wt = join(await temp('wt'), 'wt')
  await git(repo, 'worktree', 'add', '-q', '-b', 'kernel/demo', wt)
  await linkNodeModules(repo, wt)
  return { repo, wt }
}

describe('the git folder a commit writes', () => {
  const common = (cwd: string, root?: string) => bypassSandbox(cwd, { root, home: '/nowhere', tmp: '/nowhere' }).filesystem?.allowWrite?.[0]

  it("is the room checkout's .git folder, the one git finds from the checkout and from its worktree", async () => {
    const { repo, wt } = await repoWithWorktree()
    expect(gitFolder(repo)).toBe(await gitSays(repo))
    expect(gitFolder(repo)).toBe(await gitSays(wt))
    expect(common(wt, repo)).toBe(join(repo, '.git'))
    // A current-branch workspace runs in the checkout itself.
    expect(common(repo, repo)).toBe(join(repo, '.git'))
  })

  it("stays put when a command rewrites the worktree's .git file or the git folder's commondir, which the sandbox lets it write", async () => {
    const { repo, wt } = await repoWithWorktree()
    const home = await temp('home')
    // The worktree's .git file reads `gitdir: <repo>/.git/worktrees/<name>`, and git reads `commondir` there.
    const own = (await readFile(join(wt, '.git'), 'utf8')).replace('gitdir:', '').trim()
    expect(own).toBe(join(repo, '.git', 'worktrees', 'wt'))
    await writeFile(join(own, 'commondir'), `${home}\n`)
    await writeFile(join(repo, '.git', 'commondir'), `${home}\n`)
    await writeFile(join(wt, '.git'), `gitdir: ${home}\n`)
    expect(common(wt, repo)).toBe(join(repo, '.git'))
    expect(bypassSandbox(wt, { root: repo, home: await temp('h'), tmp: await temp('t') }).filesystem?.allowWrite).not.toContain(home)
  })

  it('is nothing without a real .git folder: no room, a .git link or file, or a repo in a parent folder', async () => {
    const { repo, wt } = await repoWithWorktree()
    expect(common(wt)).toBeUndefined()
    // A checkout whose .git a command swapped for a link to the home folder.
    const swapped = await temp('swapped')
    await symlink(await temp('home'), join(swapped, '.git'), 'dir')
    expect(common(swapped, swapped)).toBeUndefined()
    // A room that is itself a worktree or a submodule names its git folder in a .git file.
    expect(common(wt, wt)).toBeUndefined()
    await mkdir(join(repo, 'packages', 'web'), { recursive: true })
    expect(common(join(repo, 'packages', 'web'), join(repo, 'packages', 'web'))).toBeUndefined()
    expect(gitFolder(await temp('plain'))).toBeUndefined()
  })
})

describe('the Bypass permissions sandbox', () => {
  it('lets commands write the git folder, the linked node_modules, the temp folder and the caches, and not git hooks or config', async () => {
    const { repo, wt } = await repoWithWorktree()
    const home = await temp('home')
    await mkdir(join(home, '.npm'), { recursive: true })
    await mkdir(join(home, 'Library', 'pnpm', 'store'), { recursive: true })
    const tmp = await temp('tmp')
    const common = join(repo, '.git')
    expect(bypassSandbox(wt, { root: repo, home, tmp }).filesystem).toEqual({
      allowWrite: [common, join(repo, 'node_modules'), tmp, join(home, '.npm'), join(home, 'Library', 'pnpm', 'store')],
      denyWrite: [join(common, 'hooks'), join(common, 'config')]
    })
  })

  it('reaches GitHub and the npm registries and nothing else, binds localhost, and lets only the screenshot commands leave it', async () => {
    const s = bypassSandbox(await temp('plain'), { home: await temp('home') })
    expect(s).toEqual({
      enabled: true,
      failIfUnavailable: false,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem: { allowWrite: [await realpath(tmpdir())] },
      network: {
        allowedDomains: ['github.com', '*.github.com', '*.githubusercontent.com', 'registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com'],
        strictAllowlist: true,
        allowLocalBinding: true
      },
      enableWeakerNetworkIsolation: true,
      excludedCommands: ['pnpm shots:*', 'node design/canvas/source/render.mjs:*']
    })
  })

  // KERNEL-541: Electron and Chromium die registering a Mach service, which no sandbox setting allows.
  it('runs pnpm shots and render.mjs outside it, and opens nothing else for them', async () => {
    const s = bypassSandbox(await temp('plain'), { home: await temp('home') })
    expect(s.excludedCommands).toEqual(['pnpm shots:*', 'node design/canvas/source/render.mjs:*'])
    expect(s.network?.allowMachLookup).toBeUndefined()
    expect(s.allowAppleEvents).toBeUndefined()
    // Each process gets its own list.
    s.excludedCommands?.push('git:*')
    expect(bypassSandbox(await temp('plain')).excludedCommands).not.toContain('git:*')
  })

  it("adds no node_modules Kernel didn't link, so a repo's own link can't open the home folder", async () => {
    const home = await temp('home')
    const tmp = await temp('tmp')
    const writes = (cwd: string, root?: string) => bypassSandbox(cwd, { root, home, tmp }).filesystem?.allowWrite ?? []

    // The repo carries a node_modules link of its own.
    const { repo, wt } = await repoWithWorktree()
    const carried = join(await temp('carried'), 'wt')
    await git(repo, 'worktree', 'add', '-q', '-b', 'kernel/carried', carried)
    await symlink(home, join(carried, 'node_modules'), 'dir')
    expect(writes(carried, repo)).not.toContain(home)

    // The main checkout's node_modules is itself a link.
    const linked = await realpath(await tempRepo())
    await symlink(home, join(linked, 'node_modules'), 'dir')
    const through = join(await temp('through'), 'wt')
    await git(linked, 'worktree', 'add', '-q', '-b', 'kernel/through', through)
    await symlink(join(linked, 'node_modules'), join(through, 'node_modules'), 'dir')
    expect(writes(through, linked)).not.toContain(home)

    // Without the room's checkout Kernel can't tell, and a worktree's own node_modules is in the folder already.
    expect(writes(wt)).not.toContain(join(repo, 'node_modules'))
    expect(writes(repo, repo)).toEqual([join(repo, '.git'), tmp])
  })
})

describe('falling back without the sandbox', () => {
  const LINE = '\n⚠ Sandbox disabled: sandbox is enabled but linux is not supported (requires macOS, Linux, or WSL2) · run /sandbox for details\n  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.\n'

  it("reads Claude Code's reason from its stderr once, however the chunks split it", () => {
    const stderr = new PassThrough()
    stderr.setEncoding('utf8')
    const reasons: string[] = []
    onSandboxFallback(stderr, (r) => reasons.push(r))
    stderr.write('Debugger listening\n')
    stderr.write(LINE.slice(0, 12))
    expect(reasons).toEqual([])
    stderr.write(LINE.slice(12))
    stderr.write(LINE)
    expect(reasons).toEqual(['sandbox is enabled but linux is not supported (requires macOS, Linux, or WSL2) · run /sandbox for details'])
  })

  it("says so in the chat with Claude Code's reason, without its terminal hint", () => {
    expect(sandboxFallbackNote('sandbox is enabled but linux is not supported (requires macOS, Linux, or WSL2) · run /sandbox for details'))
      .toBe("The sandbox didn't start, so this chat's commands run in Bypass permissions without it. Claude Code says: sandbox is enabled but linux is not supported (requires macOS, Linux, or WSL2).")
    expect(sandboxFallbackNote('')).toBe("The sandbox didn't start, so this chat's commands run in Bypass permissions without it.")
  })
})
