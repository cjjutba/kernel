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
import { tempRepo } from './helpers'

// KERNEL-466: a hire, an edit, a retire and a restore are for the user on this Mac, or for the team in a pull request. Either
// way the room's own checkout is never left with an agent file Kernel wrote, changed or moved.

const ROWAN = '---\nname: rowan\ndescription: Lead. Plans and hands out tasks.\nlead: true\n---\nYou are Rowan.\n'
const KAI = '---\nname: kai\ndescription: Frontend engineer. Builds UI.\nmodel: sonnet\ntools: Read, Edit, Write, Bash, Grep, Glob\ncolor: blue\n---\nYou are Kai.\n'
const IVY = '---\nname: ivy\ndescription: QA. Runs the tests before review.\ntools: Read, Edit, Write, Bash, Grep, Glob\n---\nYou are Ivy.\n'
const URL = 'https://github.com/o/r/pull/7'

/** A room whose repo has a remote, and a code host that pushes there and says PR #7 opened. */
async function boot(files: Record<string, string> = {}) {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/rowan.md': ROWAN, '.claude/agents/kai.md': KAI, ...files })
  const remote = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
  await run('git', ['init', '-q', '--bare', '-b', 'main', remote])
  await git(repo, 'remote', 'add', 'origin', remote)
  await git(repo, 'push', '-q', '-u', 'origin', 'main')
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { requireGreen: false } }))
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
  const room = await k.rooms.addRoom(repo)
  await k.team.agents(room.id)
  return { k, h: k.handlers(), repo, remote, home, dataDir, room, host, opened }
}

/** Nothing in the room's checkout is uncommitted: no agent file Kernel wrote, changed or moved, and no other file either. */
async function clean(repo: string) {
  expect(await git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('')
}

const ids = (list: { id: string }[]) => list.map((a) => a.id)

describe('who an agent change is for (KERNEL-466)', () => {
  it('hires for me into ~/.claude/agents, and for the team in a pull request from a workspace of its own', async () => {
    const { k, h, repo, remote, home, room, opened } = await boot()
    const before = k.store.workspaces(room.id).length

    const lumi = await h['agents.draft']({ roomId: room.id, description: 'A designer who checks screens against DESIGN.md', name: 'Lumi' })
    const mine = await h['agents.create']({ roomId: room.id, draft: lumi })
    expect(mine).toMatchObject({ id: 'lumi', origin: 'personal', file: join(home, '.claude', 'agents', 'lumi.md') })
    expect(mine.pr).toBeUndefined()
    expect(await readFile(join(home, '.claude', 'agents', 'lumi.md'), 'utf8')).toBe(lumi.text)
    expect(k.store.workspaces(room.id)).toHaveLength(before)
    // A name the repo has is taken, so the user's own file would never be read in this room.
    await expect(h['agents.create']({ roomId: room.id, draft: { ...lumi, id: 'kai', text: lumi.text.replace('name: lumi', 'name: kai') } })).rejects.toThrow(/already on the team/)
    await clean(repo)

    const ivy = await h['agents.draft']({ roomId: room.id, description: 'QA. Runs the tests before review.', name: 'Ivy' })
    const theirs = await h['agents.create']({ roomId: room.id, draft: ivy, scope: 'team' })
    expect(theirs).toMatchObject({ id: 'ivy', pr: { number: 7, url: URL } })
    const ws = k.store.workspace(theirs.pr!.workspaceId)!
    expect(ws).toMatchObject({ status: 'ready', mode: 'worktree', agentId: 'rowan', title: 'Add Ivy to the team', prNumber: 7, prUrl: URL })
    expect(opened).toEqual([expect.objectContaining({ cwd: ws.path, title: 'Add Ivy to the team', base: ws.baseRef, remote: 'origin', body: expect.stringContaining('`.claude/agents/ivy.md`') })])
    expect(await git(remote, 'show', `${ws.branch}:.claude/agents/ivy.md`)).toBe(ivy.text)
    expect((await git(remote, 'log', '-1', '--format=%s', ws.branch)).trim()).toBe('Add Ivy to the team')
    expect((await git(remote, 'diff', '--name-only', 'main', ws.branch)).trim()).toBe('.claude/agents/ivy.md')
    // Ivy joins once the PR merges. Until then she isn't on the team, and nothing of hers is in the checkout or ~/.claude/agents.
    expect(ids(await k.team.agents(room.id))).not.toContain('ivy')
    expect(await readdir(join(home, '.claude', 'agents'))).toEqual(['lumi.md'])
    await clean(repo)
  })

  it('edits for me over the repo file, and for the team with only the lines this save changes', async () => {
    const { k, h, repo, remote, dataDir, room, opened } = await boot()
    const kaiFile = join(repo, '.claude', 'agents', 'kai.md')

    const mine = await h['agents.save']({ roomId: room.id, agentId: 'kai', patch: { model: 'opus', effort: 'high' } })
    expect(mine).toMatchObject({ id: 'kai', model: 'opus', effort: 'high' })
    expect(mine.pr).toBeUndefined()
    expect(await readFile(kaiFile, 'utf8')).toBe(KAI)
    expect(JSON.parse(await readFile(join(dataDir, 'agent-overrides.json'), 'utf8'))).toEqual({ [room.id]: { kai: { edit: { model: 'opus', effort: 'high' } } } })
    // A new chat with Kai starts on the model the user picked.
    const task = await k.workspaces.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Table' })
    expect(k.store.chats(task.id)[0].model).toMatch(/opus/)
    // A field set back to what the file says follows the file again.
    await h['agents.save']({ roomId: room.id, agentId: 'kai', patch: { model: 'sonnet', effort: 'high' } })
    expect(JSON.parse(await readFile(join(dataDir, 'agent-overrides.json'), 'utf8'))).toEqual({ [room.id]: { kai: { edit: { effort: 'high' } } } })
    await clean(repo)

    // For the team: the tools this save changes, never the effort the user keeps for themselves. Kai stays as he is until it merges.
    const theirs = await h['agents.save']({ roomId: room.id, agentId: 'kai', patch: { effort: 'high', tools: ['Read', 'Grep'] }, scope: 'team' })
    expect(theirs).toMatchObject({ id: 'kai', tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], pr: { number: 7 } })
    const ws = k.store.workspace(theirs.pr!.workspaceId)!
    expect(ws.title).toBe("Change Kai's agent file")
    expect(opened[0].body).toContain('Changes the tools in `.claude/agents/kai.md`.')
    const text = await git(remote, 'show', `${ws.branch}:.claude/agents/kai.md`)
    expect(text).toContain('tools: Read, Grep\n')
    expect(text).toContain('color: blue\n')
    expect(text).toContain('model: sonnet\n')
    expect(text).not.toContain('effort')
    expect((await git(remote, 'diff', '--name-only', 'main', ws.branch)).trim()).toBe('.claude/agents/kai.md')
    expect((await k.team.agents(room.id)).find((a) => a.id === 'kai')?.tools).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'])
    await clean(repo)

    // A save for the team that changes nothing opens nothing.
    const count = k.store.workspaces(room.id).length
    await expect(h['agents.save']({ roomId: room.id, agentId: 'kai', patch: { effort: 'high' }, scope: 'team' })).rejects.toThrow("Nothing to change: Kai's file already says that.")
    expect(k.store.workspaces(room.id)).toHaveLength(count)
  })

  it('retires for me on this Mac, and for the team with a pull request that moves the file', async () => {
    const { k, h, repo, remote, room } = await boot({ '.claude/agents/ivy.md': IVY })
    const work = await k.workspaces.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Table' })

    expect(await h['agents.retire']({ roomId: room.id, agentId: 'kai' })).toEqual({ ok: true })
    expect(ids(await k.team.agents(room.id))).toEqual(['rowan', 'ivy'])
    expect(k.store.workspace(work.id)?.agentId).toBe('rowan')
    expect(ids(await h['agents.list']({ roomId: room.id, retired: true }))).toEqual(['kai'])
    expect(await readFile(join(repo, '.claude', 'agents', 'kai.md'), 'utf8')).toBe(KAI)
    await clean(repo)
    // Restore brings Kai back from where he never left.
    expect(await h['agents.restore']({ roomId: room.id, agentId: 'kai' })).toMatchObject({ id: 'kai' })
    expect(ids(await k.team.agents(room.id))).toEqual(['rowan', 'ivy', 'kai'])
    expect(await h['agents.list']({ roomId: room.id, retired: true })).toEqual([])

    // For the team: a PR moves Ivy's file to .claude/retired-agents, and she leaves the team on this Mac now.
    const theirs = await h['agents.retire']({ roomId: room.id, agentId: 'ivy', scope: 'team' })
    expect(theirs).toMatchObject({ ok: true, pr: { number: 7, url: URL } })
    const ws = k.store.workspace(theirs.pr!.workspaceId)!
    expect(ws.title).toBe('Retire Ivy')
    expect((await git(remote, 'diff', '-M', '--name-status', 'main', ws.branch)).trim()).toBe('R100\t.claude/agents/ivy.md\t.claude/retired-agents/ivy.md')
    expect(ids(await k.team.agents(room.id))).toEqual(['rowan', 'kai'])
    expect(await readFile(join(repo, '.claude', 'agents', 'ivy.md'), 'utf8')).toBe(IVY)
    await clean(repo)
  })

  it('restores a file the team retired: to ~/.claude/agents for me, or in a pull request for the team', async () => {
    const { h, repo, remote, home, room, k } = await boot({ '.claude/retired-agents/ivy.md': IVY })
    expect(ids(await h['agents.list']({ roomId: room.id, retired: true }))).toEqual(['ivy'])

    const theirs = await h['agents.restore']({ roomId: room.id, agentId: 'ivy', scope: 'team' })
    expect(theirs).toMatchObject({ id: 'ivy', pr: { number: 7 } })
    const ws = k.store.workspace(theirs.pr!.workspaceId)!
    expect(ws.title).toBe('Bring Ivy back')
    expect((await git(remote, 'diff', '-M', '--name-status', 'main', ws.branch)).trim()).toBe('R100\t.claude/retired-agents/ivy.md\t.claude/agents/ivy.md')

    const mine = await h['agents.restore']({ roomId: room.id, agentId: 'ivy' })
    expect(mine).toMatchObject({ id: 'ivy', origin: 'personal', file: join(home, '.claude', 'agents', 'ivy.md') })
    expect(await readFile(join(home, '.claude', 'agents', 'ivy.md'), 'utf8')).toBe(IVY)
    await clean(repo)
  })

  it('refuses a change for the team that the repo or its host cannot take, and leaves no workspace behind', async () => {
    const { k, h, repo, room, host } = await boot()
    const count = () => k.store.workspaces(room.id).length
    const before = count()

    // A file the repo never committed isn't the team's yet.
    await writeFile(join(repo, '.claude', 'agents', 'zed.md'), '---\nname: zed\ndescription: Data engineer.\n---\nYou are Zed.\n')
    await k.team.agents(room.id)
    await expect(h['agents.save']({ roomId: room.id, agentId: 'zed', patch: { model: 'opus' }, scope: 'team' })).rejects.toThrow("isn't committed, so the team doesn't have it yet")
    await expect(h['agents.retire']({ roomId: room.id, agentId: 'zed', scope: 'team' })).rejects.toThrow("isn't committed")
    expect(ids(await k.team.agents(room.id))).toContain('zed')
    await run('rm', [join(repo, '.claude', 'agents', 'zed.md')])

    // A host that can't open a PR, and a room that merges locally, take no change for the team.
    k.github = { ...host, create: undefined }
    const draft = await h['agents.draft']({ roomId: room.id, description: 'QA. Runs the tests.', name: 'Ivy' })
    await expect(h['agents.create']({ roomId: room.id, draft, scope: 'team' })).rejects.toThrow("can't open pull requests on this room's code host")
    k.github = host
    k.store.saveRoom({ ...k.store.room(room.id)!, host: 'local' })
    await expect(h['agents.create']({ roomId: room.id, draft, scope: 'team' })).rejects.toThrow(/merges locally/)
    expect(count()).toBe(before)
    await clean(repo)
  })

  it("drops the workspace when the change can't be committed, and keeps the commit when only the PR fails", async () => {
    const { k, h, repo, room, host } = await boot()
    const before = k.store.workspaces(room.id).length

    // A hook that refuses the commit: the workspace, its worktree and its branch go.
    const hooks = await mkdtemp(join(tmpdir(), 'kernel-hooks-'))
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', { mode: 0o755 })
    await git(repo, 'config', 'core.hooksPath', hooks)
    const draft = await h['agents.draft']({ roomId: room.id, description: 'QA. Runs the tests.', name: 'Ivy' })
    await expect(h['agents.create']({ roomId: room.id, draft, scope: 'team' })).rejects.toThrow("Kernel couldn't commit the change. lint failed")
    expect(k.store.workspaces(room.id)).toHaveLength(before)
    expect((await git(repo, 'branch', '--list')).trim()).toBe('* main')
    await git(repo, 'config', '--unset', 'core.hooksPath')

    // gh refuses the PR: the commit stays in its workspace, where Create PR finishes it, and Kai still leaves on this Mac.
    k.github = { ...host, create: async () => { throw new Error('gh pr create --title Retire Kai failed (1): could not find any remote') } }
    const r = await h['agents.retire']({ roomId: room.id, agentId: 'kai', scope: 'team' })
    expect(r.pr).toEqual({ workspaceId: expect.any(String), error: 'could not find any remote' })
    const ws = k.store.workspace(r.pr!.workspaceId)!
    expect(ws).toMatchObject({ status: 'ready', prState: 'none' })
    expect((await git(ws.path, 'log', '-1', '--format=%s')).trim()).toBe('Retire Kai')
    expect(ids(await k.team.agents(room.id))).not.toContain('kai')
    await clean(repo)
  })

  it("lets the user pick on the hire card who the Lead's new agent is for", async () => {
    const { k, repo, home, room, opened } = await boot()
    const chat = await k.lead.leadChat(room.id)
    const lead = (await k.team.agents(room.id)).find((a) => a.lead)!
    const hire = kernelTools(k.lead.leadToolDeps(room.id, lead, chat)).find((t) => t.name === 'hire_agent')!
    const call = async (args: object) => ((await hire.handler(args as never, {})).content[0] as { text: string }).text
    const card = async () => vi.waitFor(() => {
      const a = k.store.approvals({ roomId: room.id, pendingOnly: true }).find((x) => x.kind === 'agent')
      expect(a).toBeTruthy()
      return a!
    })

    // Rowan proposes no one: the card starts on Just for me.
    let asked = call({ id: 'lumi', description: 'Designer. Checks screens.', prompt: 'You are Lumi.' })
    let pending = await card()
    expect(pending.agentFile).toMatchObject({ path: '~/.claude/agents/lumi.md', scope: 'me' })
    k.approvals.decide(pending.id, { behavior: 'allow' })
    expect(await asked).toBe(`Saved ${join(home, '.claude', 'agents', 'lumi.md')}. lumi joins the user's team on this Mac, in every room.`)

    // Rowan proposes the team, and the user keeps it for themselves.
    asked = call({ id: 'nia', description: 'Docs writer.', prompt: 'You are Nia.', scope: 'team' })
    pending = await card()
    expect(pending.agentFile).toMatchObject({ path: '.claude/agents/nia.md', scope: 'team' })
    k.approvals.decide(pending.id, { behavior: 'allow', scope: 'me' })
    expect(await asked).toMatch(/^Saved .*nia\.md\./)

    // And the other way round: the user sends Rowan's personal hire to the team.
    asked = call({ id: 'ivy', description: 'QA. Runs the tests.', prompt: 'You are Ivy.' })
    k.approvals.decide((await card()).id, { behavior: 'allow', scope: 'team' })
    const text = await asked
    expect(text).toMatch(/^Opened PR #7 \(https:\/\/github\.com\/o\/r\/pull\/7\) that adds \.claude\/agents\/ivy\.md, from workspace \S+\. ivy joins the team once it merges\.$/)
    expect(opened.map((o) => o.title)).toEqual(['Add Ivy to the team'])
    expect((await readdir(join(home, '.claude', 'agents'))).sort()).toEqual(['lumi.md', 'nia.md'])
    await clean(repo)
  })
})

describe("the user's own edit over an agent file (KERNEL-466)", () => {
  const file = agentFromFile('/repo/.claude/agents/kai.md', KAI.replace('model: sonnet', 'model: gpt-6-astra\nprovider: codex'))

  it('unpins a model the file pins, gives every tool for an emptied list, and keeps only what differs from the file', () => {
    const edit = ownEditOf(file, file, { model: '', tools: [], description: file.description, prompt: 'You are Kai.\n' })
    expect(edit).toEqual({ model: '', tools: [] })
    const kai = withOwnEdit(file, edit)
    expect(kai).toMatchObject({ model: undefined, provider: undefined, tools: undefined, prompt: 'You are Kai.' })
    // Picking the file's model again, on its provider, leaves nothing to keep.
    expect(ownEditOf(file, kai, { model: 'gpt-6-astra', provider: 'codex', tools: file.tools })).toBeUndefined()
  })

  it('sends the team only the fields a save changed from what the user saw', () => {
    const mine = withOwnEdit(file, { effort: 'high' })
    expect(editedFields(mine, { effort: 'high', model: 'gpt-6-astra', tools: ['Read'], prompt: ' You are Kai. ' })).toEqual({ tools: ['Read'] })
    expect(editedFields(mine, { model: 'opus', provider: 'claude' })).toEqual({ model: 'opus', provider: 'claude' })
  })
})
