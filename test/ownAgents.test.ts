import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ActivityEvent } from '@shared/types'
import type { TelemetryEvent } from '@shared/telemetry'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import type { KernelOptions } from '../src/main/features/options'
import { LEAD_SHARING_RULE, SHARE_RULE, TEAMMATE_RULE } from '../src/main/services/handoff'
import { kernelTools } from '../src/main/services/kernelMcp'
import { claudeAgents } from '../src/main/services/pluginAgents'
import { git } from '../src/main/services/exec'
import { tempRepo } from './helpers'

// A chat with Rowan's held first message goes out through the real send once its setup passes (KERNEL-405). The stub's
// `supportedAgents` answers with `sdk.agents`, and each query's options are kept, for plugin agents (KERNEL-463).
const sdk = vi.hoisted(() => ({ agents: [] as { name: string; description: string; model?: string }[], options: [] as unknown[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => {
  const stub = await import('./sdkStub')
  return { ...await original<object>(), ...stub, query: (a: { options?: unknown }) => { sdk.options.push(a.options); return { ...stub.query(), supportedAgents: async () => sdk.agents } } }
})

// KERNEL-397: a repo that brings its own .claude/agents works as it is. Kernel's Rowan fills a missing Lead without writing
// a file, Kernel's code review a missing reviewer (KERNEL-553), and [team] in .kernel/settings.toml holds what the user changes.
const STARTERS = join(__dirname, '..', 'docs', 'starter-agents')

const AGENTS = {
  '.claude/agents/architect.md': '---\nname: architect\ndescription: >-\n  Designs the system.\n  Writes no code.\ntools: Read, Grep, Glob\n---\nYou design.',
  '.claude/agents/api.md': '---\nname: api\ndescription: Backend engineer. Builds the API.\n---\nYou build the API and open a PR.',
  '.claude/agents/web.md': '---\nname: web\ndescription: Frontend engineer.\ntools: Read, Edit, Write, Bash, Grep, Glob\n---\nYou build the UI.'
}

const SETTINGS = '# Kernel settings for this repo. Commit it so the whole team shares it.\n\n[linear]\nteam = "SHOP"\n'

/** `home` writes files into the temp home folder, given its path. */
async function boot(files: Record<string, string> = AGENTS, o: { home?: (home: string) => Record<string, string>; claudeAgents?: KernelOptions['claudeAgents'] } = {}) {
  const repo = await tempRepo({ 'README.md': '# shop\n', '.kernel/settings.toml': SETTINGS, ...files })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  for (const [f, text] of Object.entries(o.home?.(home) ?? {})) { await mkdir(dirname(join(home, f)), { recursive: true }); await writeFile(join(home, f), text) }
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home, starterDir: STARTERS, claudeAgents: o.claudeAgents })
  onTestFinished(() => k.stop())
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  const tracked: TelemetryEvent[] = []
  const activity: ActivityEvent[] = []
  const onTrack = (e: TelemetryEvent) => tracked.push(e)
  const onActivity = (e: ActivityEvent) => activity.push(e)
  bus.on('track', onTrack)
  bus.on('activity', onActivity)
  onTestFinished(() => { bus.off('track', onTrack); bus.off('activity', onActivity) })
  const room = await k.addRoom(repo)
  return { k, h: k.handlers(), repo, home, room, tracked, activity }
}

/** The Lead's tools in the room's Lead chat. */
async function leadTools(k: Kernel, roomId: string) {
  const chat = await k.leadChat(roomId)
  const lead = (await k.agents(roomId)).find((a) => a.lead)!
  const tools = Object.fromEntries(kernelTools(k.lead.leadToolDeps(roomId, lead, chat)).map((t) => [t.name, t]))
  const call = async (name: string, args: object) => {
    const r = await tools[name].handler(args as never, {})
    return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
  }
  return { chat, call }
}

describe("a repo's own agents (KERNEL-397)", () => {
  it("gets Kernel's Rowan and no reviewer agent, and the Lead only hands tasks to agents that can open a PR", async () => {
    const { k, repo, room, tracked } = await boot()
    const team = await k.agents(room.id)
    expect(team.map((a) => [a.id, a.name, a.lead, a.reviewer, a.member])).toEqual([
      ['kernel-lead', 'Rowan', true, false, false], ['api', 'Api', false, false, true], ['architect', 'Architect', false, false, false],
      ['web', 'Web', false, false, true]
    ])
    expect(team.find((a) => a.id === 'architect')?.description).toBe('Designs the system. Writes no code.')
    // Nothing was written to the repo.
    expect((await readdir(join(repo, '.claude', 'agents'))).sort()).toEqual(['api.md', 'architect.md', 'web.md'])
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toBe(SETTINGS)

    const { chat, call } = await leadTools(k, room.id)
    expect(k.store.workspace(chat.workspaceId)?.agentId).toBe('kernel-lead')
    expect(k.sessions['d'].agentFor(k.store.workspace(chat.workspaceId)!)).toMatchObject({ id: 'kernel-lead', builtIn: 'lead', prompt: expect.stringMatching(/^You are Rowan/) })
    // Kernel starts reviews itself, so the Lead's rule has no review line (KERNEL-549).
    expect(k.tools.rulesFor(k.store.workspace(chat.workspaceId)!, team[0])).toBe(LEAD_SHARING_RULE)

    const list = (await call('list_agents', {})).text
    expect(list).toContain('kernel-lead: Rowan, Lead (the Lead, you).')
    expect(list).toContain("architect: Architect, Architect (helper, doesn't take tasks). Designs the system. Writes no code.")
    expect(list).not.toContain('kernel-reviewer')
    expect(await call('create_workspace', { agent: 'architect', title: 'Design', brief: 'Design it.' })).toEqual({
      isError: true, text: "Not created: Architect is a helper in this room and doesn't take tasks. Use an id from list_agents: api (Api, Backend), web (Web, Frontend)."
    })
    expect(tracked).toContainEqual({ name: 'handoff.refused', reason: 'helper' })
    // Kernel's Theo is no agent the Lead can hand work to (KERNEL-553).
    expect(await call('create_workspace', { agent: 'kernel-reviewer', title: 'Build', brief: 'Build it.' })).toMatchObject({ isError: true })
    const work = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'web', title: 'Cart' })
    // The repo's own agent, whose file says nothing about Kernel, gets Kernel's teammate and sharing rules.
    expect(k.tools.rulesFor(work, team.find((a) => a.id === 'web'))).toBe(`${TEAMMATE_RULE}\n${SHARE_RULE}`)
    // No agent reviews, so Kernel's code review runs, and the reviewer comes from `builtin` as Theo did.
    expect(tracked.slice(0, 2)).toEqual([
      { name: 'team.resolved', leadFrom: 'builtin', reviewerFrom: 'builtin', agents: '1-5', helpers: '1-5', warnings: '1-5' },
      { name: 'agent.warning', kind: 'cant-open-pr' }
    ])
    // Once per change in the room's shape, not at every read.
    expect(tracked.filter((e) => e.name === 'team.resolved')).toHaveLength(1)
  })

  it('writes only what the user changed to [team], and the Lead\'s chats follow a new Lead', async () => {
    const { k, h, repo, room } = await boot()
    const { chat } = await leadTools(k, room.id)
    const settings = join(repo, '.kernel', 'settings.toml')
    const before = await readFile(settings, 'utf8')

    let team = await h['agents.setTeam']({ roomId: room.id, team: { lead: 'api', reviewer: 'none', members: ['api', 'web', 'architect'], helpers: [] }, from: 'settings' })
    expect(team.map((a) => [a.id, a.lead, a.reviewer, a.member])).toEqual([['api', true, false, false], ['architect', false, false, true], ['web', false, false, true]])
    expect(await readFile(settings, 'utf8')).toBe(`${before.replace(/\n+$/, '')}\n\n[team]\nlead = "api"\nreviewer = "none"\nmembers = ["architect"]\n`)
    // The Lead's workspace, with its chats, is the new Lead's now.
    const ws = k.store.workspace(chat.workspaceId)!
    expect(ws.agentId).toBe('api')
    expect(k.chatTabs(ws.id).map((c) => c.id)).toContain(chat.id)
    expect(k.tools.rulesFor(ws, team[0])).toBe(LEAD_SHARING_RULE)

    // Back to what Kernel works out on its own: the table goes, and the rest of the file is as it was.
    team = await h['agents.setTeam']({ roomId: room.id, team: { lead: 'kernel-lead', reviewer: 'kernel-reviewer', members: [], helpers: ['architect'] } })
    expect(await readFile(settings, 'utf8')).toBe(before)
    expect(k.store.workspace(chat.workspaceId)?.agentId).toBe('kernel-lead')
    await expect(h['agents.setTeam']({ roomId: room.id, team: { lead: 'ghost' } })).rejects.toThrow('ghost is not on this team.')
    // An agent with open work of its own can't lead: that work would run as the Lead's.
    await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'web', title: 'Cart' })
    await expect(h['agents.setTeam']({ roomId: room.id, team: { lead: 'web' } })).rejects.toThrow('Web has an open workspace. Archive it first, or pick another Lead.')
    await expect(h['agents.setTeam']({ roomId: room.id, team: { lead: 'web', reviewer: 'web' } })).rejects.toThrow("can't also review")
  })

  it("customizes Kernel's Rowan into rowan.md, and the Lead's workspace follows it", async () => {
    const { k, h, repo, room, tracked } = await boot()
    const { chat } = await leadTools(k, room.id)
    await expect(h['agents.save']({ roomId: room.id, agentId: 'kernel-lead', patch: { model: 'opus' } })).rejects.toThrow(/Customize it/)
    await expect(h['agents.retire']({ roomId: room.id, agentId: 'kernel-lead' })).rejects.toThrow(/Kernel's own Lead/)
    const rowan = await h['agents.customize']({ roomId: room.id, agentId: 'kernel-lead' })
    expect(rowan).toMatchObject({ id: 'rowan', name: 'Rowan', lead: true, file: join(repo, '.claude', 'agents', 'rowan.md') })
    expect(rowan.builtIn).toBeUndefined()
    const text = await readFile(join(repo, '.claude', 'agents', 'rowan.md'), 'utf8')
    expect(text).toMatch(/^---\nname: rowan\ndescription: Lead\./)
    expect(text).not.toContain('model:')
    expect(k.store.workspace(chat.workspaceId)?.agentId).toBe('rowan')
    expect(tracked).toContainEqual({ name: 'builtin.customized', which: 'lead' })
    await expect(h['agents.customize']({ roomId: room.id, agentId: 'rowan' })).rejects.toThrow(/already has a file/)
  })

  it('adds one starter agent to a team that has agents, Theo as its reviewer (KERNEL-553)', async () => {
    const { k, h, repo, room } = await boot()
    expect((await h['agents.addStarter']({ roomId: room.id, id: 'ivy' })).id).toBe('ivy')
    expect((await readdir(join(repo, '.claude', 'agents'))).sort()).toEqual(['api.md', 'architect.md', 'ivy.md', 'web.md'])
    await expect(h['agents.addStarter']({ roomId: room.id, id: 'ivy' })).rejects.toThrow('Ivy is already on the team.')
    await expect(h['agents.addStarter']({ roomId: room.id, id: 'rowan' })).rejects.toThrow("isn't one of Kernel's starter agents")
    expect((await k.agents(room.id)).find((a) => a.id === 'ivy')).toMatchObject({ member: true })
    // Theo's tools line can't edit, so Theo reviews and takes no tasks.
    const theo = await h['agents.addStarter']({ roomId: room.id, id: 'theo' })
    expect(theo).toMatchObject({ id: 'theo', name: 'Theo', reviewer: true, member: false, tools: ['Read', 'Grep', 'Glob', 'Bash'], file: join(repo, '.claude', 'agents', 'theo.md') })
    expect(theo.builtIn).toBeUndefined()
    expect(theo.warnings).toBeUndefined()
  })

  it("hands a retired reviewer's open reviews to the reviewer that takes over", async () => {
    const { k, h, room } = await boot({ ...AGENTS, '.claude/agents/checker.md': '---\nname: checker\ndescription: Reviews PRs.\nrole: Reviewer\ntools: Read, Grep\n---\nYou review.' })
    expect((await k.agents(room.id)).find((a) => a.reviewer)?.id).toBe('checker')
    const work = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'web', title: 'Cart' })
    const review = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'checker', title: 'Review', reviewOf: work.id })
    const chore = await k.createWorkspace(room.id, { prompt: 'Tidy the docs', agentId: 'checker', title: 'Docs' })
    await h['agents.retire']({ roomId: room.id, agentId: 'checker' })
    // With no other reviewer, the review goes to Kernel's code review (KERNEL-553), and anything else to the Lead.
    expect(k.store.workspace(review.id)?.agentId).toBe('kernel-reviewer')
    expect(k.store.workspace(chore.id)?.agentId).toBe('kernel-lead')
    await expect(h['agents.retire']({ roomId: room.id, agentId: 'kernel-lead' })).rejects.toThrow(/Kernel's own Lead/)
  })

  it('keeps the Lead chats of a room whose Lead file no longer marks it Lead', async () => {
    const rowan = '---\nname: rowan\ndescription: Lead. Plans.\nlead: true\n---\nYou are Rowan.'
    const { k, repo, room } = await boot({ '.claude/agents/rowan.md': rowan, '.claude/agents/web.md': AGENTS['.claude/agents/web.md'] })
    const { chat } = await leadTools(k, room.id)
    expect(k.store.workspace(chat.workspaceId)?.agentId).toBe('rowan')
    // Before KERNEL-397 a description that said Lead was enough. Now Kernel's Rowan leads, with the same chats.
    await writeFile(join(repo, '.claude', 'agents', 'rowan.md'), rowan.replace('lead: true\n', ''))
    const team = await k.agents(room.id)
    expect(team.map((a) => [a.id, a.name, a.lead])).toEqual([['kernel-lead', 'Lead', true], ['rowan', 'Rowan', false], ['web', 'Web', false]])
    // Its prompt has no pull request workflow either, so it starts as a helper (KERNEL-465).
    expect(team.find((a) => a.id === 'rowan')?.warnings).toEqual([{ kind: 'looks-like-subagent' }, { kind: 'looks-like-lead' }])
    expect(k.store.workspace(chat.workspaceId)?.agentId).toBe('kernel-lead')
    expect((await k.leadChat(room.id)).id).toBe(chat.id)
    await rm(join(repo, '.claude', 'agents', 'rowan.md'))
  })
})

// KERNEL-553: Rowan is Kernel's only built-in agent, and Theo is a starter. Kernel's code review (KERNEL-549) covers a room
// that has no reviewer, so a room whose reviewer was Kernel's Theo keeps a review on every PR.
describe("a room whose reviewer was Kernel's Theo (KERNEL-553)", () => {
  /** Web's work, committed in its own worktree, on a PR that passed checks. */
  async function pr(k: Kernel, roomId: string, n: number) {
    const ws = await k.createWorkspace(roomId, { prompt: 'Build it', agentId: 'web', title: `Task ${n}` })
    await writeFile(join(ws.path, `task-${n}.txt`), 'done\n')
    await git(ws.path, 'add', '-A')
    await git(ws.path, 'commit', '-qm', 'work')
    k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prNumber: 100 + n, prTitle: `Task ${n}`, prState: 'ready', prHead: (await git(ws.path, 'rev-parse', 'HEAD')).trim() })
    return k.store.workspace(ws.id)!
  }

  // Before the upgrade, a room with no reviewer file had Kernel's Theo, and one that picked Theo in Settings saved its id.
  for (const [what, settings] of [['no [team] reviewer', SETTINGS], ['[team] reviewer = "kernel-reviewer"', `${SETTINGS}\n[team]\nreviewer = "kernel-reviewer"\n`]]) {
    it(`gets Kernel's code review on every PR with ${what}, and its old reviews still run Theo`, async () => {
      const { k, h, room } = await boot({ ...AGENTS, '.kernel/settings.toml': settings })
      const team = await k.agents(room.id)
      expect(team.filter((a) => a.builtIn).map((a) => a.id)).toEqual(['kernel-lead'])
      expect(team.some((a) => a.reviewer)).toBe(false)

      // A review Kernel's Theo had open when the app upgraded: a workspace on its reserved id, with a chat from before review kinds.
      const old = await pr(k, room.id, 1)
      const made = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'web', title: 'Review PR #101', reviewOf: old.id })
      const review = k.store.saveWorkspace({ ...made, agentId: 'kernel-reviewer' })
      expect(k.sessions['d'].agentFor(review)).toMatchObject({ id: 'kernel-reviewer', name: 'Theo', tools: ['Read', 'Grep', 'Glob', 'Bash'], prompt: expect.stringMatching(/^You are Theo, the reviewer\./) })
      expect(k.reviews.reviewState(old).open).toMatchObject({ workspaceId: review.id, name: 'Theo' })
      await expect(h['agents.customize']({ roomId: room.id, agentId: 'kernel-reviewer' })).rejects.toThrow("Only Kernel's Rowan can be customized.")

      // Each PR after it gets Kernel's code review.
      for (const n of [2, 3]) {
        const next = await pr(k, room.id, n)
        await k.reviews.onReady(next.id)
        const rws = k.store.workspaces(room.id).filter((w) => w.reviewOf === next.id)
        expect(rws).toHaveLength(1)
        const chat = k.store.chats(rws[0].id).find((c) => c.lens?.kind === 'code')!
        expect(chat.lens).toEqual({ kind: 'code' })
        expect(k.sessions['d'].agentFor(rws[0], chat)).toMatchObject({ id: 'kernel-reviewer', name: 'Code review', prompt: expect.stringMatching(/^You run the code review/) })
      }
    })
  }

  it('reviews no PR with [team] reviewer = "none", and keeps that choice when Settings saves it', async () => {
    const { k, h, repo, room } = await boot()
    // "No reviewer" differs from what Kernel does on its own now, so it is written. Kernel's code review is the default, so it isn't.
    await h['agents.setTeam']({ roomId: room.id, team: { reviewer: 'none' } })
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toContain('\n[team]\nreviewer = "none"\n')
    await h['agents.setTeam']({ roomId: room.id, team: { reviewer: 'kernel-reviewer' } })
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toBe(SETTINGS)

    const off = await boot({ ...AGENTS, '.kernel/settings.toml': `${SETTINGS}\n[team]\nreviewer = "none"\n` })
    const ws = await pr(off.k, off.room.id, 1)
    await off.k.reviews.onReady(ws.id)
    expect(off.k.store.workspaces(off.room.id).filter((w) => w.reviewOf === ws.id)).toEqual([])
  })
})

// KERNEL-463: the user's own agents in ~/.claude/agents and Claude Code's plugin agents join every room's team, read the
// way the repo's files are. Kernel never writes either.
const PERSONAL = {
  '.claude/agents/scout.md': '---\nname: scout\ndescription: Researcher. Finds prior art, then opens a PR.\n---\nYou are Scout.',
  // The repo has a web.md too, and the repo's file wins, as it does in Claude Code.
  '.claude/agents/my-web.md': '---\nname: web\ndescription: My own frontend agent.\nmodel: opus\n---\nYou are my web.'
}

/** A plugin named kit, installed for the user from a marketplace, as Claude Code lays it out. */
const KIT = join('.claude', 'plugins', 'cache', 'market', 'kit', '1.0.0')
const plugin = (home: string) => ({
  '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'kit@market': [{ scope: 'user', installPath: join(home, KIT), version: '1.0.0' }] } }),
  [join(KIT, '.claude-plugin', 'plugin.json')]: JSON.stringify({ name: 'kit', agents: ['./extra/writer.md', '../outside.md'] }),
  [join(KIT, 'agents', 'code-reviewer.md')]: '---\nname: code-reviewer\ndescription: Reviews code for bugs and security problems.\ntools: Read, Grep, Glob\nmodel: sonnet\n---\nYou review code.',
  [join(KIT, 'agents', 'builder.md')]: '---\nname: builder\ndescription: Builds features end to end and opens a PR.\n---\nYou build features.',
  [join(KIT, 'extra', 'writer.md')]: '---\nname: writer\ndescription: Writes the docs and opens a PR.\n---\nYou write docs.',
  // Listed in plugin.json, but outside the plugin's folder.
  [join(dirname(KIT), 'outside.md')]: '---\nname: outside\ndescription: Not the plugin\'s.\n---\nYou are outside.'
})
const LISTED = [
  { name: 'Explore', description: 'Fast read-only search agent.', model: 'inherit' },
  { name: 'general-purpose', description: 'General-purpose agent.' },
  { name: 'scout', description: 'Researcher.' },
  { name: 'kit:code-reviewer', description: 'Reviews code for bugs and security problems.', model: 'sonnet' },
  { name: 'kit:builder', description: 'Builds features end to end and opens a PR.' },
  { name: 'kit:writer', description: 'Writes the docs and opens a PR.' },
  { name: 'kit:outside', description: "Not the plugin's." },
  { name: 'gone:helper', description: 'From a plugin that left no folder.' }
]

describe('personal and plugin agents (KERNEL-463)', () => {
  it('adds the agents in ~/.claude/agents to every room, and the repo\'s file wins on the same name', async () => {
    const { k, h, repo, home, room } = await boot(AGENTS, { home: () => PERSONAL })
    const team = await k.agents(room.id)
    expect(team.find((a) => a.id === 'scout')).toMatchObject({ name: 'Scout', origin: 'personal', member: true, prompt: 'You are Scout.', file: join(home, '.claude', 'agents', 'scout.md') })
    expect(team.filter((a) => a.id === 'web')).toEqual([expect.objectContaining({ prompt: 'You build the UI.', file: join(repo, '.claude', 'agents', 'web.md') })])
    expect(team.find((a) => a.id === 'web')?.origin).toBeUndefined()
    // Claude Code leaves the personal file out without a word, and so does Kernel.
    expect(team.flatMap((a) => a.warnings ?? []).map((w) => w.kind)).not.toContain('duplicate-id')

    // Rowan hands it tasks like any teammate.
    const { call } = await leadTools(k, room.id)
    expect((await call('list_agents', {})).text).toContain('scout: Scout')
    expect((await call('create_workspace', { agent: 'scout', title: 'Prior art', brief: 'Find prior art.' })).text).toMatch(/^Created \S+ on \S+ for scout\./)

    // Its file is the user's own: saved for them, the profile rewrites it in ~/.claude/agents, and the team, which doesn't have
    // it, can't take a change. Retired for them, it leaves this room only, and its file stays (KERNEL-466).
    expect(await h['agents.save']({ roomId: room.id, agentId: 'scout', patch: { model: 'opus' } })).toMatchObject({ id: 'scout', origin: 'personal', model: 'opus' })
    expect(await readFile(join(home, '.claude', 'agents', 'scout.md'), 'utf8')).toContain('model: opus\n')
    await expect(h['agents.save']({ roomId: room.id, agentId: 'scout', patch: { model: 'sonnet' }, scope: 'team' })).rejects.toThrow("Scout's file is in ~/.claude/agents, so the team doesn't have Scout. Save the change just for you.")
    await expect(h['agents.retire']({ roomId: room.id, agentId: 'scout', scope: 'team' })).rejects.toThrow('Retire Scout just for you.')
    const before = await readFile(join(home, '.claude', 'agents', 'scout.md'), 'utf8')
    await h['agents.retire']({ roomId: room.id, agentId: 'scout' })
    expect((await k.agents(room.id)).map((a) => a.id)).not.toContain('scout')
    expect(await readFile(join(home, '.claude', 'agents', 'scout.md'), 'utf8')).toBe(before)
    expect((await h['agents.restore']({ roomId: room.id, agentId: 'scout' })).id).toBe('scout')
    expect(await readdir(join(repo, '.claude', 'agents'))).not.toContain('scout.md')

    // The same team rules: [team] can make it a helper.
    const helped = await h['agents.setTeam']({ roomId: room.id, team: { helpers: ['scout'] } })
    expect(helped.find((a) => a.id === 'scout')).toMatchObject({ member: false })

    // Another room has it too.
    const other = await k.addRoom(await tempRepo({ 'README.md': '# blog\n' }))
    expect((await k.agents(other.id)).find((a) => a.id === 'scout')).toMatchObject({ origin: 'personal', member: true })
  })

  it('picks up files added to and removed from ~/.claude/agents', async () => {
    const { k, home, room, activity } = await boot(AGENTS, { home: () => PERSONAL })
    await k.agents(room.id)
    await writeFile(join(home, '.claude', 'agents', 'mira.md'), '---\nname: mira\ndescription: Writer. Drafts release notes.\n---\nYou are Mira.')
    await vi.waitFor(() => expect(k.team.agentsSync(room.id).map((a) => a.id)).toContain('mira'), { timeout: 5000 })
    expect(k.team.agentsSync(room.id).find((a) => a.id === 'mira')).toMatchObject({ origin: 'personal', role: 'Writer' })
    expect(activity).toContainEqual(expect.objectContaining({ kind: 'agent.joined', roomId: room.id, agentId: 'mira' }))
    await rm(join(home, '.claude', 'agents', 'scout.md'))
    await vi.waitFor(() => expect(k.team.agentsSync(room.id).map((a) => a.id)).not.toContain('scout'), { timeout: 5000 })
  })

  it("adds plugin agents from Claude Code's list, read from the plugin's files, and never writes them", async () => {
    sdk.agents = LISTED
    const { k, h, repo, home, room, activity } = await boot(AGENTS, { home: (dir) => ({ ...PERSONAL, ...plugin(dir) }), claudeAgents })
    // Claude Code started in the home folder with only the user's settings, where plugins are turned on.
    expect(sdk.options).toContainEqual(expect.objectContaining({ cwd: home, settingSources: ['user'], settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {}, persistSession: false }))
    await vi.waitFor(() => expect(k.team.agentsSync(room.id).map((a) => a.id)).toContain('kit:builder'), { timeout: 5000 })
    const team = await k.agents(room.id)
    // Explore and the others without a colon are Claude Code's own or come from files Kernel reads itself.
    expect(team.filter((a) => a.origin === 'plugin').map((a) => [a.id, a.name, a.member, a.warnings])).toEqual([
      ['kit:builder', 'Builder', true, undefined],
      ['kit:code-reviewer', 'Code Reviewer', false, [{ kind: 'cant-open-pr' }]],
      ['gone:helper', 'Helper', false, [{ kind: 'unreadable-file', detail: "Kernel couldn't find its file in the gone plugin" }]],
      ['kit:outside', 'Outside', false, [{ kind: 'unreadable-file', detail: "Kernel couldn't find its file in the kit plugin" }]],
      ['kit:writer', 'Writer', true, undefined]
    ])
    expect(team.find((a) => a.id === 'kit:code-reviewer')).toMatchObject({ model: 'sonnet', tools: ['Read', 'Grep', 'Glob'], prompt: 'You review code.', file: join(home, KIT, 'agents', 'code-reviewer.md') })
    expect(team.find((a) => a.id === 'kit:writer')).toMatchObject({ prompt: 'You write docs.', file: join(home, KIT, 'extra', 'writer.md') })
    expect(team.filter((a) => a.id === 'scout')).toHaveLength(1)
    // They were there before Kernel heard of them, so nobody walks in.
    expect(activity.filter((e) => e.kind === 'agent.joined')).toEqual([])

    // A plugin brings its agents to every room, so its reviewer doesn't review unless [team] says so.
    expect(team.find((a) => a.reviewer)).toBeUndefined()
    const named = await h['agents.setTeam']({ roomId: room.id, team: { reviewer: 'kit:code-reviewer' } })
    expect(named.find((a) => a.reviewer)?.id).toBe('kit:code-reviewer')
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toContain('reviewer = "kit:code-reviewer"')

    // Rowan hands one a task, and its chat runs on the plugin's prompt.
    const { call } = await leadTools(k, room.id)
    expect((await call('create_workspace', { agent: 'kit:builder', title: 'Cart', brief: 'Build the cart.' })).text).toMatch(/^Created \S+ on \S+ for kit:builder\./)
    const ws = k.store.workspaces(room.id).find((w) => w.agentId === 'kit:builder')!
    expect(k.sessions['d'].agentFor(ws)).toMatchObject({ id: 'kit:builder', origin: 'plugin', prompt: 'You build features.' })

    const file = join(home, KIT, 'agents', 'builder.md')
    const before = await readFile(file, 'utf8')
    await expect(h['agents.save']({ roomId: room.id, agentId: 'kit:builder', patch: { model: 'opus' } })).rejects.toThrow("Builder comes from the kit plugin, and Kernel doesn't change a plugin's files.")
    await expect(h['agents.retire']({ roomId: room.id, agentId: 'kit:builder', scope: 'team' })).rejects.toThrow("Builder comes from the kit plugin, so the team's files don't have Builder.")
    // Retired for the user, it leaves this room, and the plugin's file stays as it is (KERNEL-466).
    await h['agents.retire']({ roomId: room.id, agentId: 'kit:builder' })
    expect((await k.agents(room.id)).map((a) => a.id)).not.toContain('kit:builder')
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('leaves plugin agents out when Claude Code fails to list them', async () => {
    let asked = 0
    const { k, room } = await boot(AGENTS, { claudeAgents: async () => { asked++; throw new Error('no claude') } })
    await k.agents(room.id)
    await k.agents(room.id)
    expect((await k.agents(room.id)).some((a) => a.origin === 'plugin')).toBe(false)
    // Once a launch, so a Mac without Claude Code doesn't start a process at every read.
    expect(asked).toBe(1)
  })
})
