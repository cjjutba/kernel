import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '../src/shared/ipc'
import type { ProjectSetupStep } from '../src/shared/types'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { findConflicts, scanInstructions } from '../src/main/services/instructionConflicts'
import { tempRepo, freePort } from './helpers'

const starter = join(__dirname, '..', 'docs', 'starter-agents')
const opts = { branches: ['main', 'dev'], base: 'origin/main' }
const kindOf = (line: string) => findConflicts(line, 'CLAUDE.md', opts).map((c) => c.kind)

/** The three rules ProjectSetupConflicts.png lists, each in the file and on the line it names. */
const CLAUDE = ['# Rules', '', 'Never run `git pull` in the main checkout.', '', '- Commit straight to main. Skip the PR for small changes.', ''].join('\n')
const AGENTS = ['# Agents', '', 'Never open pull requests. Push to the shared branch when tests pass.', ''].join('\n')
const NESTED = ['Rebase onto `origin/main` before you open a PR.', '', 'Stack PRs: each branch builds on the one before it.', ''].join('\n')

async function kernel() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt') }))
  const k = new Kernel({ dataDir, home, starterDir: starter, claudeSettingsFile: join(home, 'claude-settings.json') })
  await k.start()
  return k
}

/** Resolves with the last `project.setup` steps once none is waiting or running. */
function setupDone(projectId: string): Promise<ProjectSetupStep[]> {
  return new Promise((resolve) => {
    const on = (e: PushEvent) => {
      if (e.type !== 'project.setup' || e.projectId !== projectId || e.steps.some((s) => s.state === 'wait' || s.state === 'run')) return
      bus.off('push', on)
      resolve(e.steps)
    }
    bus.on('push', on)
  })
}

describe('repo instructions that fight Kernel', () => {
  it.each([
    ['Commit straight to main.', 'commit-to-main'],
    ['- Always commit directly to `main`.', 'commit-to-main'],
    ['1. **Commit** to `dev` branch.', 'commit-to-main'],
    ['You can commit your changes to dev.', 'commit-to-main'],
    ['When you are done, commit and push to main.', 'commit-to-main'],
    ['We work directly on main.', 'commit-to-main'],
    ['Small fixes can be committed directly to the default branch.', 'commit-to-main'],
    ['Push straight to main when tests pass.', 'push-to-protected'],
    ['Feel free to push the fix to `origin/main`.', 'push-to-protected'],
    ['Never open pull requests.', 'no-pull-requests'],
    ["We don't use PRs.", 'no-pull-requests'],
    ['No PRs needed for this repo.', 'no-pull-requests'],
    ['Skip the PR for small changes.', 'no-pull-requests'],
    ['Merge typo fixes without a PR.', 'no-pull-requests'],
    ['PRs are optional.', 'no-pull-requests'],
    ["Don't create branches.", 'no-branches'],
    ['Commit to main? Yes.', 'commit-to-main'],
    ['Stack PRs: each branch builds on the one before it.', 'stacked-prs'],
    ['We stack PRs.', 'stacked-prs'],
    ['Use stacked pull requests for big features.', 'stacked-prs'],
    ['Branch off the previous PR.', 'stacked-prs']
  ])('flags %s', (line, kind) => {
    expect(kindOf(line)).toEqual([kind])
  })

  it.each([
    // Lines from Kernel's own CLAUDE.md, which mention main and agree with Kernel.
    'Never run `git pull` in the main checkout, the folder where `main` is checked out (the first line of `git worktree list`).',
    'To see what landed on main, run `git fetch origin` and read `origin/main`.',
    'To bring a branch up to date, rebase it onto `origin/main` in its own worktree.',
    'CJ pulls main when no agent is running.',
    'Keep PRs to one issue.',
    'Commit with Conventional Commits (`feat(workspace): ...`), open a PR with `gh pr create` that references `KERNEL-N` and lists what changed and what you checked.',
    // Negated, conditional, a noun or about something else.
    'Never commit to main.',
    "Don't push to main, open a pull request instead.",
    'Never, ever commit straight to main.',
    'CI deploys on every push to main.',
    'Only maintainers push to main.',
    'Before you push to main, run the tests.',
    'If you commit to main by mistake, revert it.',
    'Run commit hooks on main.',
    'Push your branch and open a PR against main.',
    "Don't open a PR until the tests pass.",
    'Never skip the PR checks.',
    'Skip the PR template for small changes.',
    'Avoid stacked PRs.',
    'Stacked PRs are not supported.',
    // The verdict after a colon, and a question's answer, count as the rest of the rule.
    'Stacked PRs: avoid them.',
    'Commit to main? Never.',
    'Push to main: not allowed.',
    // Stacked PRs as a subject, a habit the repo dropped, and staying on main for something else.
    'Stacking PRs is discouraged.',
    'Prefer small PRs over stacked PRs.',
    'Stacked PRs make review hard.',
    'We used to stack PRs, but no longer.',
    'Stay on main when reviewing.',
    'Never merge without a PR.',
    "Don't create a branch for every typo.",
    'The main process lives in src/main.',
    'Work on main features first.',
    'Work in main only if the user asks.',
    'Main is protected.'
  ])('leaves %s alone', (line) => {
    expect(kindOf(line)).toEqual([])
  })

  it('quotes the rule with its file, line and what Kernel tells agents instead', () => {
    expect(findConflicts(CLAUDE, 'CLAUDE.md', opts)).toEqual([
      { kind: 'commit-to-main', text: 'Commit straight to main. Skip the PR for small changes.', file: 'CLAUDE.md', line: 5, kernel: 'Work on your own branch and open a pull request.' }
    ])
    expect(findConflicts(AGENTS, 'AGENTS.md', opts)).toEqual([
      { kind: 'no-pull-requests', text: 'Never open pull requests. Push to the shared branch when tests pass.', file: 'AGENTS.md', line: 3, kernel: 'Every task ends in a pull request. Never push to a shared branch.' }
    ])
    expect(findConflicts(NESTED, '.claude/CLAUDE.md', { ...opts, base: 'upstream/trunk' })).toEqual([
      { kind: 'stacked-prs', text: 'Stack PRs: each branch builds on the one before it.', file: '.claude/CLAUDE.md', line: 3, kernel: 'Start from upstream/trunk. One task, one branch, one pull request.' }
    ])
  })

  it('reads only the branches it is given', () => {
    expect(kindOf('Push to release.')).toEqual([])
    expect(findConflicts('Push to release.', 'CLAUDE.md', { ...opts, branches: ['release'] }).map((c) => c.kind)).toEqual(['push-to-protected'])
  })

  it('skips code blocks and HTML comments, and quotes one sentence of a long line', () => {
    const text = [
      '```sh', 'Commit straight to main.', '```',
      '<!-- Commit straight to main. -->',
      '<!--', 'Push to main.', '-->',
      'This repo is small and moves fast, so we keep the process light and expect everyone to read the docs folder first, especially the architecture notes. Commit straight to main. Ask in the channel when you need a hand.'
    ].join('\n')
    expect(findConflicts(text, 'CLAUDE.md', opts)).toEqual([expect.objectContaining({ kind: 'commit-to-main', text: 'Commit straight to main.', line: 8 })])
  })

  it('reads CLAUDE.md, .claude/CLAUDE.md and AGENTS.md in that order, and a linked file once', async () => {
    const repo = await tempRepo({ 'AGENTS.md': AGENTS, '.claude/CLAUDE.md': NESTED })
    await symlink('AGENTS.md', join(repo, 'CLAUDE.md'))
    expect((await scanInstructions(repo, opts)).map((c) => [c.file, c.line, c.kind])).toEqual([
      ['CLAUDE.md', 3, 'no-pull-requests'],
      ['.claude/CLAUDE.md', 3, 'stacked-prs']
    ])
    expect(await scanInstructions(await tempRepo(), opts)).toEqual([])
  })

  it('keeps what project setup found on the project, and never edits the files', async () => {
    const k = await kernel()
    const repo = await tempRepo({ 'CLAUDE.md': CLAUDE, 'AGENTS.md': AGENTS, '.claude/CLAUDE.md': NESTED })
    const project = await k.projects.createProject({ source: 'folder', name: 'Rules app', from: repo, team: ['kai'], autostart: false })
    await setupDone(project.id)
    expect(k.store.project(project.id)?.instructionConflicts).toEqual([
      { kind: 'commit-to-main', text: 'Commit straight to main. Skip the PR for small changes.', file: 'CLAUDE.md', line: 5, kernel: 'Work on your own branch and open a pull request.' },
      { kind: 'stacked-prs', text: 'Stack PRs: each branch builds on the one before it.', file: '.claude/CLAUDE.md', line: 3, kernel: 'Start from origin/main. One task, one branch, one pull request.' },
      { kind: 'no-pull-requests', text: 'Never open pull requests. Push to the shared branch when tests pass.', file: 'AGENTS.md', line: 3, kernel: 'Every task ends in a pull request. Never push to a shared branch.' }
    ])
    expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toBe(CLAUDE)
    expect(await readFile(join(repo, 'AGENTS.md'), 'utf8')).toBe(AGENTS)
    expect(await readFile(join(repo, '.claude', 'CLAUDE.md'), 'utf8')).toBe(NESTED)

    // The base is where teammates' worktrees start, so a workspace base from Settings changes what Kernel says to stacked PRs.
    k.settings.workspace.baseRef = 'origin/release'
    const again = await k.projects.findInstructionConflicts(project.id)
    expect(again.instructionConflicts?.find((c) => c.kind === 'stacked-prs')?.kernel).toBe('Start from origin/release. One task, one branch, one pull request.')

    const plain = await tempRepo()
    const quiet = await k.projects.createProject({ source: 'folder', name: 'Plain app', from: plain, team: ['kai'], autostart: false })
    await setupDone(quiet.id)
    expect(k.store.project(quiet.id)?.instructionConflicts).toEqual([])
    await k.stop()
  })
})
