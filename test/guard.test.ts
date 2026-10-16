import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../src/main/services/exec'
import { moveWorktree } from '../src/main/services/worktrees'
import { tempRepo } from './helpers'

// The guard reads HOME through os.homedir(), so a fake home keeps these runs
// away from the real ~/.claude.
const tmp = mkdtempSync(join(tmpdir(), 'kernel-guard-'))
const home = join(tmp, 'home')
const repo = join(tmp, 'repo')
const outside = join(tmp, 'outside')
mkdirSync(join(home, '.claude', 'plans', 'real-sub'), { recursive: true })
mkdirSync(join(home, 'Library', 'Application Support', 'Kernel'), { recursive: true })
mkdirSync(repo)
mkdirSync(join(outside, 'deeper'), { recursive: true })
writeFileSync(join(home, '.claude', 'settings.json'), '{}')
const plans = join(home, '.claude', 'plans')
symlinkSync(join(home, '.claude', 'settings.json'), join(plans, 'link.md'))
symlinkSync(join(outside, 'evil.plist'), join(plans, 'dangling.md'))
symlinkSync(join(outside, 'deeper'), join(plans, 'd'))
symlinkSync(join(outside, 'new.ts'), join(repo, 'dangling.ts'))
symlinkSync(join(outside, 'deeper'), join(repo, 'd'))
symlinkSync(join(repo, 'loop-b'), join(repo, 'loop-a'))
symlinkSync(join(repo, 'loop-a'), join(repo, 'loop-b'))

// A second home whose plans folder is a symlink to its own ~/.claude.
const linkedHome = join(tmp, 'linked-home')
mkdirSync(join(linkedHome, '.claude'), { recursive: true })
symlinkSync(join(linkedHome, '.claude'), join(linkedHome, '.claude', 'plans'))

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

// Plain node, as Claude Code runs the hook. Under `pnpm test` process.execPath is the Electron binary, which takes
// seconds to start on a busy machine, and the checks run side by side (KERNEL-187).
// KERNEL_WORKSPACE is cleared, since a run inside a Kernel session inherits the session's own.
async function guardOutput(tool: string, toolInput: Record<string, string>, h = home, o: { project?: string; workspace?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: h, CLAUDE_PROJECT_DIR: o.project ?? repo }
  delete env.KERNEL_WORKSPACE
  if (o.workspace) env.KERNEL_WORKSPACE = o.workspace
  const proc = promisify(execFile)('node', [resolve('.claude/hooks/guard.mjs')], { env, encoding: 'utf8' })
  proc.child.stdin!.end(JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: o.workspace ?? o.project ?? repo }))
  const { stdout } = await proc
  return stdout ? JSON.parse(stdout).hookSpecificOutput : { permissionDecision: 'allow' }
}

async function guard(tool: string, toolInput: Record<string, string>, h = home, o: { project?: string; workspace?: string } = {}) {
  return (await guardOutput(tool, toolInput, h, o)).permissionDecision
}

describe.concurrent('guard: edits outside the repo', () => {
  it.each([
    ['a file in the repo', 'Write', join(repo, 'src/a.ts')],
    ['a relative path in the repo', 'Write', 'src/a.ts'],
    ['a plan file in the plans folder', 'Write', `${plans}/kernel-63-rosy-pixel.md`],
    ['an edit to a plan file', 'Edit', `${plans}/kernel-63-rosy-pixel.md`],
    ['a MultiEdit to a plan file', 'MultiEdit', `${plans}/kernel-63-rosy-pixel.md`],
    ['a plan file written with ~', 'Write', '~/.claude/plans/kernel-63-rosy-pixel.md'],
    ['a real subfolder and .. back into the plans folder', 'Write', `${plans}/real-sub/../x.md`],
    ['the app\'s data folder', 'Write', join(home, 'Library/Application Support/Kernel/kernel.db')]
  ])('allows %s', async (_, tool, file) => {
    expect(await guard(tool, { file_path: file })).toBe('allow')
  })

  it.each([
    ['~/.claude/settings.json', 'Write', join(home, '.claude/settings.json')],
    ['~/.claude/settings.json with ~', 'Edit', '~/.claude/settings.json'],
    ['a non-.md file in the plans folder', 'Write', `${plans}/notes.txt`],
    ['a prefix trap', 'Write', join(home, '.claude/plans-evil/x.md')],
    ['a literal .. out of the plans folder', 'Write', `${plans}/../x.md`],
    ['a subfolder of the plans folder', 'Write', `${plans}/real-sub/x.md`],
    ['a plans folder in another home', 'Write', join(repo, '..', 'elsewhere/.claude/plans/x.md')],
    ['a .md symlink to settings.json', 'Write', `${plans}/link.md`],
    ['a dangling .md symlink in the plans folder', 'Write', `${plans}/dangling.md`],
    ['a .. behind a symlinked folder in the plans folder', 'Write', `${plans}/d/../x.md`],
    ['a dangling symlink in the repo that points outside', 'Write', join(repo, 'dangling.ts')],
    ['a .. behind a symlinked folder in the repo', 'Edit', `${repo}/d/../x.ts`],
    ['a symlink loop', 'Write', join(repo, 'loop-a')],
    ['a MultiEdit outside the repo', 'MultiEdit', join(outside, 'x.md')]
  ])('denies %s', async (_, tool, file) => {
    expect(await guard(tool, { file_path: file })).toBe('deny')
  })

  it('checks NotebookEdit through notebook_path', async () => {
    expect(await guard('NotebookEdit', { notebook_path: join(repo, 'a.ipynb') })).toBe('allow')
    expect(await guard('NotebookEdit', { notebook_path: join(outside, 'a.ipynb') })).toBe('deny')
    expect(await guard('NotebookEdit', { notebook_path: `${plans}/a.ipynb` })).toBe('deny')
  })

  it('lets Bash read and change the app\'s data folder, but not rm -r it', async () => {
    expect(await guard('Bash', { command: 'cat ~/Library/Application\\ Support/Kernel/settings.json' })).toBe('allow')
    expect(await guard('Bash', { command: `rm -rf "${home}/Library/Application Support/Kernel"` })).toBe('deny')
  })

  it('does not follow a plans folder that is a symlink to ~/.claude', async () => {
    expect(await guard('Write', { file_path: join(linkedHome, '.claude/plans/CLAUDE.md') }, linkedHome)).toBe('deny')
  })
})

// A chat with Kernel works in its own worktree, but Claude Code sets CLAUDE_PROJECT_DIR to the main checkout it takes its
// config from (KERNEL-355). Kernel moves that worktree to match the chat's title (KERNEL-424) and restarts the session there.
describe('guard: a chat with Kernel in a moved worktree (KERNEL-976)', () => {
  let checkout: string, moved: string, other: string
  beforeAll(async () => {
    checkout = await tempRepo()
    other = await tempRepo()
    const before = join(tmp, 'worktrees', 'kernel-what-your-thoughts-about')
    moved = join(tmp, 'worktrees', 'kernel-redundant-top-bar-in-new-chat')
    await run('git', ['-C', checkout, 'worktree', 'add', '-q', '--detach', before])
    await moveWorktree(checkout, before, moved)
  })
  afterAll(() => {
    for (const dir of [checkout, other]) rmSync(dir, { recursive: true, force: true })
  })

  it('allows a write inside the new folder', async () => {
    const o = { project: checkout, workspace: moved }
    expect(await guard('Write', { file_path: join(moved, '.kernel/shared/chat-header-merge.html') }, home, o)).toBe('allow')
    expect(await guard('Write', { file_path: 'shots/x.html' }, home, o)).toBe('allow')
  })

  it('still denies a write outside it, the main checkout and the old folder included', async () => {
    const o = { project: checkout, workspace: moved }
    expect(await guard('Write', { file_path: join(outside, 'x.ts') }, home, o)).toBe('deny')
    expect(await guard('Write', { file_path: join(checkout, 'README.md') }, home, o)).toBe('deny')
    expect(await guard('Write', { file_path: join(tmp, 'worktrees', 'kernel-what-your-thoughts-about', 'x.ts') }, home, o)).toBe('deny')
    expect(await guard('Edit', { file_path: `${moved}/../kernel-what-your-thoughts-about/x.ts` }, home, o)).toBe('deny')
  })

  it('ignores a KERNEL_WORKSPACE that is not a worktree of the same repo', async () => {
    expect(await guard('Write', { file_path: join(other, 'x.ts') }, home, { project: checkout, workspace: other })).toBe('deny')
    expect(await guard('Write', { file_path: join(checkout, 'x.ts') }, home, { project: checkout, workspace: other })).toBe('allow')
  })
})

describe.concurrent('guard: live tests', () => {
  it.each([
    ['an approved file', 'KERNEL_LIVE=1 pnpm test test/terminalLead.live.test.ts'],
    ['an approved file through vitest', 'KERNEL_LIVE=1 pnpm exec vitest run ./test/terminalLead.live.test.ts 2>&1 | tail -40'],
    ['an approved file run detached', 'nohup KERNEL_LIVE=1 pnpm test test/terminalLead.live.test.ts > /tmp/x.out 2>&1 &'],
    ['an approved file run detached with no spaces', 'nohup KERNEL_LIVE=1 pnpm test test/terminalLead.live.test.ts >/tmp/x.out 2>&1&']
  ])('allows %s', async (_, command) => {
    expect(await guard('Bash', { command })).toBe('allow')
  })

  it.each([
    ['an unlisted file', 'KERNEL_LIVE=1 pnpm test test/live.test.ts'],
    ['a command naming no file', 'KERNEL_LIVE=1 KERNEL_LIVE_REPO=/tmp/side pnpm exec vitest run'],
    ['an approved file plus an unlisted one', 'KERNEL_LIVE=1 pnpm test test/terminalLead.live.test.ts test/live.test.ts'],
    ['a whole-suite run', 'KERNEL_LIVE=1 pnpm test'],
    ['a whole-suite run after an approved one', 'export KERNEL_LIVE=1; pnpm test test/terminalLead.live.test.ts && pnpm test'],
    ['KERNEL_LIVE with no test run', 'export KERNEL_LIVE=1'],
    ['an unlisted file run detached', 'nohup KERNEL_LIVE=1 pnpm test test/live.test.ts > /tmp/x.out 2>&1 &'],
    ['a whole-suite run after a detached approved one', 'KERNEL_LIVE=1 pnpm test test/terminalLead.live.test.ts & pnpm test']
  ])('denies %s', async (_, command) => {
    expect(await guard('Bash', { command })).toBe('deny')
  })

  it('names the approved files when it denies', async () => {
    const out = await guardOutput('Bash', { command: 'KERNEL_LIVE=1 pnpm test test/live.test.ts' })
    expect(out.permissionDecisionReason).toContain('test/terminalLead.live.test.ts')
  })
})
