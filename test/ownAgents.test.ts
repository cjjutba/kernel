import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TelemetryEvent } from '@shared/telemetry'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { LEAD_REVIEW_RULE, SHARE_RULE, TEAMMATE_RULE } from '../src/main/services/handoff'
import { kernelTools } from '../src/main/services/kernelMcp'
import { tempRepo } from './helpers'

// KERNEL-397: a repo that brings its own .claude/agents works as it is. Kernel's Rowan and Theo fill a missing Lead and
// reviewer without writing a file, and [team] in .kernel/settings.toml holds what the user changes.
const STARTERS = join(__dirname, '..', 'docs', 'starter-agents')

const AGENTS = {
  '.claude/agents/architect.md': '---\nname: architect\ndescription: >-\n  Designs the system.\n  Writes no code.\ntools: Read, Grep, Glob\n---\nYou design.',
  '.claude/agents/api.md': '---\nname: api\ndescription: Backend engineer. Builds the API.\n---\nYou build the API.',
  '.claude/agents/web.md': '---\nname: web\ndescription: Frontend engineer.\ntools: Read, Edit, Write, Bash, Grep, Glob\n---\nYou build the UI.'
}

const SETTINGS = '# Kernel settings for this repo. Commit it so the whole team shares it.\n\n[linear]\nteam = "SHOP"\n'

async function boot(files: Record<string, string> = AGENTS) {
  const repo = await tempRepo({ 'README.md': '# shop\n', '.kernel/settings.toml': SETTINGS, ...files })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home, starterDir: STARTERS })
  onTestFinished(() => k.stop())
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  const tracked: TelemetryEvent[] = []
  const onTrack = (e: TelemetryEvent) => tracked.push(e)
  bus.on('track', onTrack)
  onTestFinished(() => { bus.off('track', onTrack) })
  const room = await k.addRoom(repo)
  return { k, h: k.handlers(), repo, room, tracked }
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
  it("gets Kernel's Rowan and Theo, and the Lead only hands tasks to agents that can open a PR", async () => {
    const { k, repo, room, tracked } = await boot()
    const team = await k.agents(room.id)
    expect(team.map((a) => [a.id, a.name, a.lead, a.reviewer, a.member])).toEqual([
      ['kernel-lead', 'Rowan', true, false, false], ['api', 'Api', false, false, true], ['architect', 'Architect', false, false, false],
      ['kernel-reviewer', 'Theo', false, true, false], ['web', 'Web', false, false, true]
    ])
    expect(team.find((a) => a.id === 'architect')?.description).toBe('Designs the system. Writes no code.')
    // Nothing was written to the repo.
    expect((await readdir(join(repo, '.claude', 'agents'))).sort()).toEqual(['api.md', 'architect.md', 'web.md'])
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toBe(SETTINGS)

    const { chat, call } = await leadTools(k, room.id)
    expect(k.store.workspace(chat.workspaceId)?.agentId).toBe('kernel-lead')
    expect(k.sessions['d'].agentFor(k.store.workspace(chat.workspaceId)!)).toMatchObject({ id: 'kernel-lead', builtIn: 'lead', prompt: expect.stringMatching(/^You are Rowan/) })
    expect(k.tools.rulesFor(k.store.workspace(chat.workspaceId)!, team[0])).toContain(LEAD_REVIEW_RULE)

    const list = (await call('list_agents', {})).text
    expect(list).toContain('kernel-lead: Rowan, Lead (the Lead, you).')
    expect(list).toContain("architect: Architect, Architect (helper, doesn't take tasks). Designs the system. Writes no code.")
    expect(list).toContain('kernel-reviewer: Theo, Reviewer (reviews PRs).')
    expect(await call('create_workspace', { agent: 'architect', title: 'Design', brief: 'Design it.' })).toEqual({
      isError: true, text: "Not created: Architect is a helper in this room and doesn't take tasks. Use an id from list_agents: api (Api, Backend), web (Web, Frontend)."
    })
    expect(await call('create_workspace', { agent: 'kernel-reviewer', title: 'Build', brief: 'Build it.' })).toEqual({
      isError: true, text: "Not created: Theo is a helper in this room and doesn't take tasks, only reviews with review_of. Use an id from list_agents: api (Api, Backend), web (Web, Frontend)."
    })
    expect(tracked).toContainEqual({ name: 'handoff.refused', reason: 'helper' })
    // Kernel's Theo takes a review of a teammate's work.
    const work = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'web', title: 'Cart' })
    // The repo's own agent, whose file says nothing about Kernel, gets Kernel's teammate and sharing rules.
    expect(k.tools.rulesFor(work, team.find((a) => a.id === 'web'))).toBe(`${TEAMMATE_RULE}\n${SHARE_RULE}`)
    const reviewed = await call('create_workspace', { agent: 'kernel-reviewer', title: 'Review the cart', brief: 'Review it.', review_of: work.id })
    expect(reviewed).toMatchObject({ isError: false, text: expect.stringMatching(/^Created \S+ on \S+ for kernel-reviewer\./) })
    const review = k.store.workspaces(room.id).find((w) => w.reviewOf === work.id)!
    expect(k.sessions['d'].agentFor(review)).toMatchObject({ id: 'kernel-reviewer', tools: ['Read', 'Grep', 'Glob', 'Bash'] })
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
    // The Lead's workspace, with its chats, is the new Lead's now. With no reviewer, the Lead isn't told to ask for reviews.
    const ws = k.store.workspace(chat.workspaceId)!
    expect(ws.agentId).toBe('api')
    expect(k.chatTabs(ws.id).map((c) => c.id)).toContain(chat.id)
    expect(k.tools.rulesFor(ws, team[0]) ?? '').not.toContain(LEAD_REVIEW_RULE)

    // Back to what Kernel works out on its own: the table goes, and the rest of the file is as it was.
    team = await h['agents.setTeam']({ roomId: room.id, team: { lead: 'kernel-lead', reviewer: 'kernel-reviewer', members: [], helpers: ['architect'] } })
    expect(await readFile(settings, 'utf8')).toBe(before)
    expect(k.store.workspace(chat.workspaceId)?.agentId).toBe('kernel-lead')
    await expect(h['agents.setTeam']({ roomId: room.id, team: { lead: 'ghost' } })).rejects.toThrow('ghost is not on this team.')
    await expect(h['agents.setTeam']({ roomId: room.id, team: { lead: 'web', reviewer: 'web' } })).rejects.toThrow("can't also review")
  })

  it("customizes Kernel's Theo into theo.md, and the open reviews follow it", async () => {
    const { k, h, repo, room, tracked } = await boot()
    const review = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'kernel-reviewer', title: 'Review' })
    await expect(h['agents.save']({ roomId: room.id, agentId: 'kernel-reviewer', patch: { model: 'opus' } })).rejects.toThrow(/Customize it/)
    await expect(h['agents.retire']({ roomId: room.id, agentId: 'kernel-reviewer' })).rejects.toThrow(/Kernel's own reviewer/)
    await expect(h['agents.retire']({ roomId: room.id, agentId: 'kernel-lead' })).rejects.toThrow(/Kernel's own Lead/)
    const theo = await h['agents.customize']({ roomId: room.id, agentId: 'kernel-reviewer' })
    expect(theo).toMatchObject({ id: 'theo', name: 'Theo', reviewer: true, file: join(repo, '.claude', 'agents', 'theo.md') })
    expect(theo.builtIn).toBeUndefined()
    const text = await readFile(join(repo, '.claude', 'agents', 'theo.md'), 'utf8')
    expect(text).toMatch(/^---\nname: theo\ndescription: Reviewer\./)
    expect(text).not.toContain('model:')
    expect(text).toContain('submit_review')
    expect(k.store.workspace(review.id)?.agentId).toBe('theo')
    expect(tracked).toContainEqual({ name: 'builtin.customized', which: 'reviewer' })
    await expect(h['agents.customize']({ roomId: room.id, agentId: 'theo' })).rejects.toThrow(/already has a file/)
  })

  it('adds one starter teammate to a team that has agents', async () => {
    const { k, h, repo, room } = await boot()
    expect((await h['agents.addStarter']({ roomId: room.id, id: 'ivy' })).id).toBe('ivy')
    expect((await readdir(join(repo, '.claude', 'agents'))).sort()).toEqual(['api.md', 'architect.md', 'ivy.md', 'web.md'])
    await expect(h['agents.addStarter']({ roomId: room.id, id: 'ivy' })).rejects.toThrow('Ivy is already on the team.')
    await expect(h['agents.addStarter']({ roomId: room.id, id: 'rowan' })).rejects.toThrow("isn't one of Kernel's starter agents")
    expect((await k.agents(room.id)).find((a) => a.id === 'ivy')).toMatchObject({ member: true })
  })

  it("hands a retired reviewer's open reviews to the reviewer that takes over", async () => {
    const { k, h, room } = await boot({ ...AGENTS, '.claude/agents/checker.md': '---\nname: checker\ndescription: Reviews PRs.\nrole: Reviewer\ntools: Read, Grep\n---\nYou review.' })
    expect((await k.agents(room.id)).find((a) => a.reviewer)?.id).toBe('checker')
    const review = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'checker', title: 'Review' })
    await h['agents.retire']({ roomId: room.id, agentId: 'checker' })
    expect(k.store.workspace(review.id)?.agentId).toBe('kernel-reviewer')
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
    expect(team.map((a) => [a.id, a.name, a.lead])).toEqual([['kernel-lead', 'Lead', true], ['rowan', 'Rowan', false], ['kernel-reviewer', 'Theo', false], ['web', 'Web', false]])
    expect(team.find((a) => a.id === 'rowan')?.warnings).toEqual([{ kind: 'looks-like-lead' }])
    expect(k.store.workspace(chat.workspaceId)?.agentId).toBe('kernel-lead')
    expect((await k.leadChat(room.id)).id).toBe(chat.id)
    await rm(join(repo, '.claude', 'agents', 'rowan.md'))
  })
})
