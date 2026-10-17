import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrInfo } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { git, run } from '../src/main/services/exec'
import type { CodeHost } from '../src/main/services/github'
import { kernelTools } from '../src/main/services/kernelMcp'
import { agentFromFile } from '../src/main/services/agents'
import { editedFields, ownEditOf, withOwnEdit } from '../src/main/services/agentOverrides'
import { tempRepo, freePort } from './helpers'

// KERNEL-466: a hire, an edit, a retire and a restore are for the user on this Mac, or for the team in a pull request. Either
// way the project's own checkout is never left with an agent file Kernel wrote, changed or moved.

const KERNEL = '---\nname: kernel\ndescription: Lead. Plans and hands out tasks.\nlead: true\n---\nYou are Kernel.\n'
const CHRISTIAN = '---\nname: christian\ndescription: Frontend engineer. Builds UI.\nmodel: sonnet\ntools: Read, Edit, Write, Bash, Grep, Glob\ncolor: blue\n---\nYou are Christian.\n'
const IVY = '---\nname: teng\ndescription: QA. Runs the tests before review.\ntools: Read, Edit, Write, Bash, Grep, Glob\n---\nYou are Teng.\n'
const URL = 'https://github.com/o/r/pull/7'

/** A project whose repo has a remote, and a code host that pushes there and says PR #7 opened. */
async function boot(files: Record<string, string> = {}) {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/kernel.md': KERNEL, '.claude/agents/christian.md': CHRISTIAN, ...files })
  const remote = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
  await run('git', ['init', '-q', '--bare', '-b', 'main', remote])
  await git(repo, 'remote', 'add', 'origin', remote)
  await git(repo, 'push', '-q', '-u', 'origin', 'main')
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { requireGreen: false } }))
  const k = new Kernel({ dataDir, home })
  onTestFinished(() => k.stop())
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  const opened: { cwd: string; title: string; body: string; base: string; draft?: boolean; remote: string }[] = []
  const info = (workspaceId: string): PrInfo => ({ workspaceId, number: 7, url: URL, title: 'x', state: 'open', baseRef: 'main', checks: [], comments: [], conflicts: [] })
  const host: CodeHost = {
    info: async (_cwd, _ref, workspaceId) => info(workspaceId),
    merge: async () => {}, ready: async () => {}, reopen: async () => {},
    create: async (cwd, o, to) => {
      await git(cwd, 'push', '-q', '-u', to, 'HEAD')
      opened.push({ cwd, ...o, remote: to })
      return { number: 7, url: URL }
    }
  }
  k.github = host
  const project = await k.projects.addProject(repo)
  await k.team.agents(project.id)
  return { k, h: k.handlers(), repo, remote, home, dataDir, project, host, opened }
}

/** Nothing in the project's checkout is uncommitted: no agent file Kernel wrote, changed or moved, and no other file either. */
async function clean(repo: string) {
  expect(await git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('')
}

const ids = (list: { id: string }[]) => list.map((a) => a.id)

describe('who an agent change is for (KERNEL-466)', () => {
  it('hires for me into ~/.claude/agents, and for the team in a pull request from a workspace of its own', async () => {
    const { k, h, repo, remote, home, project, opened } = await boot()
    const before = k.store.workspaces(project.id).length

    const wren = await h['agents.draft']({ projectId: project.id, description: 'A designer who checks screens against DESIGN.md', name: 'Wren' })
    const mine = await h['agents.create']({ projectId: project.id, draft: wren })
    expect(mine).toMatchObject({ id: 'wren', origin: 'personal', file: join(home, '.claude', 'agents', 'wren.md') })
    expect(mine.pr).toBeUndefined()
    expect(await readFile(join(home, '.claude', 'agents', 'wren.md'), 'utf8')).toBe(wren.text)
    expect(k.store.workspaces(project.id)).toHaveLength(before)
    // A name the repo has is taken, so the user's own file would never be read in this project.
    await expect(h['agents.create']({ projectId: project.id, draft: { ...wren, id: 'christian', text: wren.text.replace('name: wren', 'name: christian') } })).rejects.toThrow(/already on the team/)
    await clean(repo)

    const teng = await h['agents.draft']({ projectId: project.id, description: 'QA. Runs the tests before review.', name: 'Teng' })
    const theirs = await h['agents.create']({ projectId: project.id, draft: teng, scope: 'team' })
    expect(theirs).toMatchObject({ id: 'teng', pr: { number: 7, url: URL } })
    const ws = k.store.workspace(theirs.pr!.workspaceId)!
    expect(ws).toMatchObject({ status: 'ready', mode: 'worktree', agentId: 'kernel-lead', title: 'Add Teng to the team', prNumber: 7, prUrl: URL })
    expect(opened).toEqual([expect.objectContaining({ cwd: ws.path, title: 'Add Teng to the team', base: ws.baseRef, remote: 'origin', body: expect.stringContaining('`.claude/agents/teng.md`') })])
    expect(await git(remote, 'show', `${ws.branch}:.claude/agents/teng.md`)).toBe(teng.text)
    expect((await git(remote, 'log', '-1', '--format=%s', ws.branch)).trim()).toBe('Add Teng to the team')
    expect((await git(remote, 'diff', '--name-only', 'main', ws.branch)).trim()).toBe('.claude/agents/teng.md')
    // Teng joins once the PR merges. Until then she isn't on the team, and nothing of hers is in the checkout or ~/.claude/agents.
    expect(ids(await k.team.agents(project.id))).not.toContain('teng')
    expect(await readdir(join(home, '.claude', 'agents'))).toEqual(['wren.md'])
    await clean(repo)
  })

  it('edits for me over the repo file, and for the team with only the lines this save changes', async () => {
    const { k, h, repo, remote, dataDir, project, opened } = await boot()
    const kaiFile = join(repo, '.claude', 'agents', 'christian.md')

    const mine = await h['agents.save']({ projectId: project.id, agentId: 'christian', patch: { model: 'opus', effort: 'high' } })
    expect(mine).toMatchObject({ id: 'christian', model: 'opus', effort: 'high' })
    expect(mine.pr).toBeUndefined()
    expect(await readFile(kaiFile, 'utf8')).toBe(CHRISTIAN)
    expect(JSON.parse(await readFile(join(dataDir, 'agent-overrides.json'), 'utf8'))).toEqual({ [project.id]: { christian: { edit: { model: 'opus', effort: 'high' } } } })
    // A new chat with Christian starts on the model the user picked.
    const task = await k.workspaces.createWorkspace(project.id, { prompt: 'Build it', agentId: 'christian', title: 'Table' })
    expect(k.store.chats(task.id)[0].model).toMatch(/opus/)
    // A field set back to what the file says follows the file again.
    await h['agents.save']({ projectId: project.id, agentId: 'christian', patch: { model: 'sonnet', effort: 'high' } })
    expect(JSON.parse(await readFile(join(dataDir, 'agent-overrides.json'), 'utf8'))).toEqual({ [project.id]: { christian: { edit: { effort: 'high' } } } })
    await clean(repo)

    // For the team: the tools this save changes, never the effort the user keeps for themselves. Christian stays as he is until it merges.
    const theirs = await h['agents.save']({ projectId: project.id, agentId: 'christian', patch: { effort: 'high', tools: ['Read', 'Grep'] }, scope: 'team' })
    expect(theirs).toMatchObject({ id: 'christian', tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], pr: { number: 7 } })
    const ws = k.store.workspace(theirs.pr!.workspaceId)!
    expect(ws.title).toBe("Change Christian's agent file")
    expect(opened[0].body).toContain('Changes the tools in `.claude/agents/christian.md`.')
    const text = await git(remote, 'show', `${ws.branch}:.claude/agents/christian.md`)
    expect(text).toContain('tools: Read, Grep\n')
    expect(text).toContain('color: blue\n')
    expect(text).toContain('model: sonnet\n')
    expect(text).not.toContain('effort')
    expect((await git(remote, 'diff', '--name-only', 'main', ws.branch)).trim()).toBe('.claude/agents/christian.md')
    expect((await k.team.agents(project.id)).find((a) => a.id === 'christian')?.tools).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'])
    await clean(repo)

    // A save for the team that changes nothing opens nothing.
    const count = k.store.workspaces(project.id).length
    await expect(h['agents.save']({ projectId: project.id, agentId: 'christian', patch: { effort: 'high' }, scope: 'team' })).rejects.toThrow("Nothing to change: Christian's file already says that.")
    expect(k.store.workspaces(project.id)).toHaveLength(count)
  })

  it('retires for me on this Mac, and for the team with a pull request that moves the file', async () => {
    const { k, h, repo, remote, project } = await boot({ '.claude/agents/teng.md': IVY })
    const work = await k.workspaces.createWorkspace(project.id, { prompt: 'Build it', agentId: 'christian', title: 'Table' })

    expect(await h['agents.retire']({ projectId: project.id, agentId: 'christian' })).toEqual({ ok: true })
    expect(ids(await k.team.agents(project.id))).toEqual(['kernel-lead', 'teng'])
    expect(k.store.workspace(work.id)?.agentId).toBe('kernel-lead')
    expect(ids(await h['agents.list']({ projectId: project.id, retired: true }))).toEqual(['christian'])
    expect(await readFile(join(repo, '.claude', 'agents', 'christian.md'), 'utf8')).toBe(CHRISTIAN)
    await clean(repo)
    // Restore brings Christian back from where he never left.
    expect(await h['agents.restore']({ projectId: project.id, agentId: 'christian' })).toMatchObject({ id: 'christian' })
    expect(ids(await k.team.agents(project.id))).toEqual(['kernel-lead', 'christian', 'teng'])
    expect(await h['agents.list']({ projectId: project.id, retired: true })).toEqual([])

    // For the team: a PR moves Teng's file to .claude/retired-agents, and she leaves the team on this Mac now.
    const theirs = await h['agents.retire']({ projectId: project.id, agentId: 'teng', scope: 'team' })
    expect(theirs).toMatchObject({ ok: true, pr: { number: 7, url: URL } })
    const ws = k.store.workspace(theirs.pr!.workspaceId)!
    expect(ws.title).toBe('Retire Teng')
    expect((await git(remote, 'diff', '-M', '--name-status', 'main', ws.branch)).trim()).toBe('R100\t.claude/agents/teng.md\t.claude/retired-agents/teng.md')
    expect(ids(await k.team.agents(project.id))).toEqual(['kernel-lead', 'christian'])
    expect(await readFile(join(repo, '.claude', 'agents', 'teng.md'), 'utf8')).toBe(IVY)
    await clean(repo)
  })

  it("keeps a hire for me on a roster project's team without changing the roster, and puts a hire for the team on it in its PR", async () => {
    const { k, h, repo, remote, project } = await boot({ '.kernel/settings.toml': '[team]\nroster = ["christian"]\n', '.claude/agents/teng.md': IVY })
    expect(ids(await k.team.agents(project.id))).not.toContain('teng')

    const wren = await h['agents.draft']({ projectId: project.id, description: 'A designer who checks screens against DESIGN.md', name: 'Wren' })
    await h['agents.create']({ projectId: project.id, draft: wren })
    expect(ids(await k.team.agents(project.id))).toContain('wren')
    await clean(repo)

    const nia = await h['agents.draft']({ projectId: project.id, description: 'Docs writer. Keeps the README current.', name: 'Nia' })
    const theirs = await h['agents.create']({ projectId: project.id, draft: nia, scope: 'team' })
    const ws = k.store.workspace(theirs.pr!.workspaceId)!
    expect((await git(remote, 'diff', '--name-only', 'main', ws.branch)).trim().split('\n')).toEqual(['.claude/agents/nia.md', '.kernel/settings.toml'])
    expect(await git(remote, 'show', `${ws.branch}:.kernel/settings.toml`)).toBe('[team]\nroster = ["christian", "nia"]\n')
    await clean(repo)

    // A roster the user picks is the team they want here, over the agents they joined for themselves.
    await h['agents.setTeam']({ projectId: project.id, team: { roster: ['christian', 'teng'] } })
    const team = ids(await k.team.agents(project.id))
    expect(team).toContain('teng')
    expect(team).not.toContain('wren')
  })

  it('restores a file the team retired: to ~/.claude/agents for me, or in a pull request for the team', async () => {
    const { h, repo, remote, home, project, k } = await boot({ '.claude/retired-agents/teng.md': IVY })
    expect(ids(await h['agents.list']({ projectId: project.id, retired: true }))).toEqual(['teng'])

    const theirs = await h['agents.restore']({ projectId: project.id, agentId: 'teng', scope: 'team' })
    expect(theirs).toMatchObject({ id: 'teng', pr: { number: 7 } })
    const ws = k.store.workspace(theirs.pr!.workspaceId)!
    expect(ws.title).toBe('Bring Teng back')
    expect((await git(remote, 'diff', '-M', '--name-status', 'main', ws.branch)).trim()).toBe('R100\t.claude/retired-agents/teng.md\t.claude/agents/teng.md')

    const mine = await h['agents.restore']({ projectId: project.id, agentId: 'teng' })
    expect(mine).toMatchObject({ id: 'teng', origin: 'personal', file: join(home, '.claude', 'agents', 'teng.md') })
    expect(await readFile(join(home, '.claude', 'agents', 'teng.md'), 'utf8')).toBe(IVY)
    await clean(repo)
  })

  it('refuses a change for the team that the repo or its host cannot take, and leaves no workspace behind', async () => {
    const { k, h, repo, project, host } = await boot()
    const count = () => k.store.workspaces(project.id).length
    const before = count()

    // A file the repo never committed isn't the team's yet.
    await writeFile(join(repo, '.claude', 'agents', 'zed.md'), '---\nname: zed\ndescription: Data engineer.\n---\nYou are Zed.\n')
    await k.team.agents(project.id)
    await expect(h['agents.save']({ projectId: project.id, agentId: 'zed', patch: { model: 'opus' }, scope: 'team' })).rejects.toThrow("isn't committed, so the team doesn't have it yet")
    await expect(h['agents.retire']({ projectId: project.id, agentId: 'zed', scope: 'team' })).rejects.toThrow("isn't committed")
    expect(ids(await k.team.agents(project.id))).toContain('zed')
    await run('rm', [join(repo, '.claude', 'agents', 'zed.md')])

    // A host that can't open a PR, and a project that merges locally, take no change for the team.
    k.github = { ...host, create: undefined }
    const draft = await h['agents.draft']({ projectId: project.id, description: 'QA. Runs the tests.', name: 'Teng' })
    await expect(h['agents.create']({ projectId: project.id, draft, scope: 'team' })).rejects.toThrow("can't open pull requests on this project's code host")
    k.github = host
    k.store.saveProject({ ...k.store.project(project.id)!, host: 'local' })
    await expect(h['agents.create']({ projectId: project.id, draft, scope: 'team' })).rejects.toThrow("can't open pull requests on this project's code host")
    expect(count()).toBe(before)
    await clean(repo)
  })

  it("drops the workspace when the change can't be committed, and keeps the commit when only the PR fails", async () => {
    const { k, h, repo, project, host } = await boot()
    const before = k.store.workspaces(project.id).length

    // A hook that refuses the commit: the workspace, its worktree and its branch go.
    const hooks = await mkdtemp(join(tmpdir(), 'kernel-hooks-'))
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', { mode: 0o755 })
    await git(repo, 'config', 'core.hooksPath', hooks)
    const draft = await h['agents.draft']({ projectId: project.id, description: 'QA. Runs the tests.', name: 'Teng' })
    await expect(h['agents.create']({ projectId: project.id, draft, scope: 'team' })).rejects.toThrow("Kernel couldn't commit the change. lint failed")
    expect(k.store.workspaces(project.id)).toHaveLength(before)
    expect((await git(repo, 'branch', '--list')).trim()).toBe('* main')
    await git(repo, 'config', '--unset', 'core.hooksPath')

    // gh refuses the PR: the commit stays in its workspace, where Create PR finishes it, and Christian still leaves on this Mac.
    k.github = { ...host, create: async () => { throw new Error('gh pr create --title Retire Christian failed (1): could not find any remote') } }
    const r = await h['agents.retire']({ projectId: project.id, agentId: 'christian', scope: 'team' })
    expect(r.pr).toEqual({ workspaceId: expect.any(String), error: 'could not find any remote' })
    const ws = k.store.workspace(r.pr!.workspaceId)!
    expect(ws).toMatchObject({ status: 'ready', prState: 'none' })
    expect((await git(ws.path, 'log', '-1', '--format=%s')).trim()).toBe('Retire Christian')
    expect(ids(await k.team.agents(project.id))).not.toContain('christian')
    await clean(repo)
  })

  it("lets the user pick on the hire card who the Lead's new agent is for", async () => {
    const { k, repo, home, project, opened } = await boot()
    const chat = await k.lead.leadChat(project.id)
    const lead = (await k.team.agents(project.id)).find((a) => a.lead)!
    const hire = kernelTools(k.lead.leadToolDeps(project.id, lead, chat)).find((t) => t.name === 'create_agent')!
    const call = async (args: object) => ((await hire.handler(args as never, {})).content[0] as { text: string }).text
    const card = async () => vi.waitFor(() => {
      const a = k.store.approvals({ projectId: project.id, pendingOnly: true }).find((x) => x.kind === 'agent')
      expect(a).toBeTruthy()
      return a!
    })

    // Kernel proposes no one: the card starts on Just for me.
    let asked = call({ id: 'wren', description: 'Designer. Checks screens.', prompt: 'You are Wren.' })
    let pending = await card()
    expect(pending.agentFile).toMatchObject({ path: '~/.claude/agents/wren.md', scope: 'me' })
    k.approvals.decide(pending.id, { behavior: 'allow' })
    const saved = await asked
    expect(saved.startsWith(`Saved ${join(home, '.claude', 'agents', 'wren.md')}, just for the user on this Mac. Wren joins the team`)).toBe(true)

    // Kernel proposes the team, and the user keeps it for themselves.
    asked = call({ id: 'nia', description: 'Docs writer.', prompt: 'You are Nia.', scope: 'team' })
    pending = await card()
    expect(pending.agentFile).toMatchObject({ path: '.claude/agents/nia.md', scope: 'team' })
    k.approvals.decide(pending.id, { behavior: 'allow', scope: 'me' })
    expect(await asked).toMatch(/^Saved .*nia\.md, just for the user on this Mac\./)

    // And the other way round: the user sends Kernel's personal hire to the team.
    asked = call({ id: 'teng', description: 'QA. Runs the tests.', prompt: 'You are Teng.' })
    k.approvals.decide((await card()).id, { behavior: 'allow', scope: 'team' })
    const text = await asked
    expect(text).toMatch(/^Opened PR #7 \(https:\/\/github\.com\/o\/r\/pull\/7\) that adds \.claude\/agents\/teng\.md, from workspace \S+\. teng joins the team once it merges\.$/)
    expect(opened.map((o) => o.title)).toEqual(['Add Teng to the team'])
    expect((await readdir(join(home, '.claude', 'agents'))).sort()).toEqual(['nia.md', 'wren.md'])
    await clean(repo)
  })
})

describe("the user's own edit over an agent file (KERNEL-466)", () => {
  const file = agentFromFile('/repo/.claude/agents/christian.md', CHRISTIAN.replace('model: sonnet', 'model: gpt-6-astra\nprovider: codex'))

  it('unpins a model the file pins, gives every tool for an emptied list, and keeps only what differs from the file', () => {
    const edit = ownEditOf(file, file, { model: '', tools: [], description: file.description, prompt: 'You are Christian.\n' })
    expect(edit).toEqual({ model: '', tools: [] })
    const christian = withOwnEdit(file, edit)
    expect(christian).toMatchObject({ model: undefined, provider: undefined, tools: undefined, prompt: 'You are Christian.' })
    // Picking the file's model again, on its provider, leaves nothing to keep.
    expect(ownEditOf(file, christian, { model: 'gpt-6-astra', provider: 'codex', tools: file.tools })).toBeUndefined()
  })

  it('sends the team only the fields a save changed from what the user saw', () => {
    const mine = withOwnEdit(file, { effort: 'high' })
    expect(editedFields(mine, { effort: 'high', model: 'gpt-6-astra', tools: ['Read'], prompt: ' You are Christian. ' })).toEqual({ tools: ['Read'] })
    expect(editedFields(mine, { model: 'opus', provider: 'claude' })).toEqual({ model: 'opus', provider: 'claude' })
  })
})
