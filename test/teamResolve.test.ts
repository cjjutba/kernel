import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentDef, TeamConfig } from '@shared/types'
import { reviewerChoice } from '@shared/team'
import { agentFromFile } from '../src/main/services/agents'
import { loadBuiltins } from '../src/main/services/builtins'
import { adviseRoster, resolveTeam, writtenAsSubagent } from '../src/main/services/teamResolve'

// KERNEL-397: one team per room, whatever shape its .claude/agents folder has. Kernel's Rowan fills a missing Lead, and
// since KERNEL-553 no built-in agent fills a missing reviewer: Kernel's code review runs instead (KERNEL-549).
const STARTERS = join(__dirname, '..', 'docs', 'starter-agents')

// The body mentions a pull request, so a file with no tools line reads as a teammate, not a subagent (KERNEL-465).
const file = (name: string, head: string, body = 'Open a pull request when the task is done.') => agentFromFile(`/repo/.claude/agents/${name}.md`, `---\n${head}\n---\n${body}`)

async function team(files: AgentDef[], config?: TeamConfig, o: { starters?: boolean } = {}) {
  const builtins = await loadBuiltins(o.starters === false ? undefined : STARTERS, files)
  return resolveTeam({ files, config, builtins })
}

const roles = (agents: AgentDef[]) => agents.map((a) => [a.id, a.name, a.lead ? 'lead' : a.reviewer ? 'reviewer' : a.member ? 'member' : 'helper', ...(a.builtIn ? ['builtin'] : [])])
const warningsOf = (agents: AgentDef[]) => Object.fromEntries(agents.filter((a) => a.warnings?.length).map((a) => [a.id, a.warnings!.map((w) => w.detail ? `${w.kind}:${w.detail}` : w.kind)]))

const KAI = file('kai', 'name: kai\ndescription: Frontend engineer.\ntools: Read, Edit, Write, Bash, Grep, Glob')
const NOOR = file('noor', 'name: noor\ndescription: Backend engineer.')
const ROWAN = file('rowan', 'name: rowan\ndescription: Lead. Plans.\nrole: Lead\nlead: true')
const THEO = file('theo', 'name: theo\ndescription: Reviewer. Read-only.\nrole: Reviewer\ntools: Read, Grep, Glob, Bash')

describe('resolveTeam', () => {
  it("gives an empty room Kernel's Rowan as its only built-in agent, and no reviewer agent", async () => {
    const r = await team([])
    expect(roles(r.agents)).toEqual([['kernel-lead', 'Rowan', 'lead', 'builtin']])
    // The reviewer is Kernel's code review, which is no agent (KERNEL-553).
    expect([r.leadFrom, r.reviewerFrom]).toEqual(['builtin', 'builtin'])
    const [lead] = r.agents
    expect(lead).toMatchObject({ file: '', role: 'Lead' })
    expect([lead.model, lead.effort]).toEqual([undefined, undefined])
    expect(lead.prompt).toMatch(/^You are Rowan, the lead/)
  })

  it("reviews with a file whose role says review, else with no agent, and reads kernel-reviewer as Kernel's code review", async () => {
    const theo = await team([KAI, THEO])
    expect(roles(theo.agents)).toEqual([['kernel-lead', 'Rowan', 'lead', 'builtin'], ['kai', 'Kai', 'member'], ['theo', 'Theo', 'reviewer']])
    expect(theo.reviewerFrom).toBe('file')
    // A room that picked Kernel's Theo before KERNEL-553 gets Kernel's code review, and "none" still means no review.
    for (const reviewer of ['kernel-reviewer', 'none']) {
      const r = await team([KAI, THEO], { reviewer })
      expect(r.agents.filter((a) => a.reviewer || a.builtIn === 'reviewer')).toEqual([])
      expect(r.reviewerFrom).toBe('setting')
    }
    // Neither names a missing agent, with the starter folder or without it.
    expect(warningsOf((await team([KAI], { reviewer: 'kernel-reviewer' }, { starters: false })).agents)).toEqual({})
  })

  it("shows the reviewing agent, else none when the repo turned review off, else Kernel's code review (KERNEL-590)", async () => {
    expect(reviewerChoice((await team([KAI, THEO])).agents)).toBe('theo')
    const cases: [TeamConfig | undefined, string][] = [[undefined, 'kernel-reviewer'], [{ reviewer: 'kernel-reviewer' }, 'kernel-reviewer'], [{ reviewer: 'none' }, 'none']]
    for (const [config, shown] of cases) expect(reviewerChoice((await team([KAI], config)).agents, config)).toBe(shown)
  })

  it("keeps Kernel's Theo off every team, named Theo for the review workspaces it ran", async () => {
    const { theo } = await loadBuiltins(STARTERS, [THEO])
    expect(theo).toMatchObject({ id: 'kernel-reviewer', name: 'Theo', role: 'Reviewer', file: '', lead: false, builtIn: 'reviewer', tools: ['Read', 'Grep', 'Glob', 'Bash'] })
    expect(theo?.prompt).toMatch(/^You are Theo, the reviewer\./)
    expect([theo?.model, theo?.effort]).toEqual([undefined, undefined])
    expect((await team([THEO])).agents.map((a) => a.id)).toEqual(['kernel-lead', 'theo'])
  })

  it("keeps a Kernel starter team as it is, with no built-ins", async () => {
    const r = await team([KAI, NOOR, ROWAN, THEO])
    expect(roles(r.agents)).toEqual([['rowan', 'Rowan', 'lead'], ['kai', 'Kai', 'member'], ['noor', 'Noor', 'member'], ['theo', 'Theo', 'reviewer']])
    expect([r.leadFrom, r.reviewerFrom]).toEqual(['file', 'file'])
    expect(warningsOf(r.agents)).toEqual({})
  })

  it("resolves this repo's own team", async () => {
    const dir = join(__dirname, '..', '.claude', 'agents')
    const files = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => agentFromFile(join(dir, f), readFileSync(join(dir, f), 'utf8')))
    const r = await team(files)
    expect(r.agents[0]).toMatchObject({ id: 'rowan', lead: true })
    expect(r.agents.find((a) => a.id === 'theo')).toMatchObject({ reviewer: true, member: false })
    expect(r.agents.filter((a) => a.member).map((a) => a.id).sort()).toEqual(['ivy', 'kai', 'lumi', 'noor'])
    expect(r.agents.some((a) => a.builtIn)).toBe(false)
  })

  it('brings Rowan to a repo of helpers, and lets its own reviewer review', async () => {
    const files = [
      file('code-reviewer', 'name: code-reviewer\ndescription: >-\n  Reviews pull requests.\n  Use proactively.\ntools: Read, Grep, Glob'),
      file('test-runner', 'name: test-runner\ndescription: Runs the tests.\ntools: Bash, Read'),
      file('doc-writer', 'name: doc-writer\ndescription: Writes docs.\ntools: Read, Write')
    ]
    const r = await team(files)
    expect(roles(r.agents)).toEqual([['kernel-lead', 'Rowan', 'lead', 'builtin'], ['code-reviewer', 'Code Reviewer', 'reviewer'], ['doc-writer', 'Doc Writer', 'helper'], ['test-runner', 'Test Runner', 'helper']])
    expect([r.leadFrom, r.reviewerFrom]).toEqual(['builtin', 'file'])
    expect(warningsOf(r.agents)).toEqual({ 'doc-writer': ['cant-open-pr'], 'test-runner': ['cant-open-pr'] })
  })

  it('makes no Lead of an agent whose description only says it leads, and says so', async () => {
    const r = await team([file('tech-lead', 'name: tech-lead\ndescription: Lead engineer. Reviews architecture.'), KAI])
    expect(r.agents[0].id).toBe('kernel-lead')
    expect(r.agents.find((a) => a.id === 'tech-lead')).toMatchObject({ lead: false, member: true, warnings: [{ kind: 'looks-like-lead' }] })
  })

  it('lets one of two Leads lead, by name, and warns on the other', async () => {
    const r = await team([file('zed', 'name: zed\ndescription: Plans.\nlead: true'), file('ada', 'name: ada\ndescription: Plans too.\nrole: Lead'), KAI])
    expect(roles(r.agents)).toEqual([['ada', 'Ada', 'lead'], ['kai', 'Kai', 'member'], ['zed', 'Zed', 'member']])
    expect(warningsOf(r.agents)).toEqual({ zed: ['second-lead:Ada'] })
  })

  it('follows [team]: the Lead, no reviewer, and who takes tasks', async () => {
    const helper = file('scout', 'name: scout\ndescription: Looks things up.\ntools: Read, WebFetch')
    const r = await team([KAI, NOOR, ROWAN, helper], { lead: 'noor', reviewer: 'none', helpers: ['kai'], members: ['scout'] })
    expect(roles(r.agents)).toEqual([['noor', 'Noor', 'lead'], ['kai', 'Kai', 'helper'], ['rowan', 'Rowan', 'member'], ['scout', 'Scout', 'member']])
    expect([r.leadFrom, r.reviewerFrom]).toEqual(['setting', 'setting'])
    expect(warningsOf(r.agents)).toEqual({ rowan: ['second-lead:Noor'] })
    const builtins = await team([KAI, ROWAN], { lead: 'kernel-lead', reviewer: 'kernel-reviewer' })
    expect(roles(builtins.agents)).toEqual([['kernel-lead', 'Lead', 'lead', 'builtin'], ['kai', 'Kai', 'member'], ['rowan', 'Rowan', 'member']])
    expect([builtins.leadFrom, builtins.reviewerFrom]).toEqual(['setting', 'setting'])
  })

  it('flags a [team] setting that names nobody, and resolves as if it were not there', async () => {
    const r = await team([KAI, ROWAN], { lead: 'ghost', reviewer: 'rowan' })
    expect(roles(r.agents)).toEqual([['rowan', 'Rowan', 'lead'], ['kai', 'Kai', 'member']])
    // With no reviewer to hold it, the reviewer's warning goes to the Lead.
    expect(warningsOf(r.agents)).toEqual({ rowan: ['setting-missing:lead = "ghost"', 'setting-missing:reviewer = "rowan"'] })
  })

  it("names Kernel's Rowan apart from a repo's own Rowan", async () => {
    const r = await team([file('rowan', 'name: rowan\ndescription: Frontend engineer.\nrole: Frontend'), file('theo', 'name: theo\ndescription: Data engineer.\nrole: Data')])
    expect(roles(r.agents)).toEqual([['kernel-lead', 'Lead', 'lead', 'builtin'], ['rowan', 'Rowan', 'member'], ['theo', 'Theo', 'member']])
    expect(r.agents[0].prompt).toMatch(/^You are the Lead of this room's team in Kernel\./)
    const both = await team([file('rowan', 'name: rowan\ndescription: x\nrole: Frontend'), file('lead', 'name: lead\ndescription: x\nrole: Data')])
    expect(both.agents[0]).toMatchObject({ id: 'kernel-lead', name: 'Kernel Lead' })
  })

  it("skips a file that takes Kernel's ids or another file's name", async () => {
    // kernel-reviewer stays reserved after KERNEL-553, so review workspaces Kernel's Theo ran never point at a repo's file.
    const r = await team([file('kernel-lead', 'name: kernel-lead\ndescription: Mine.\nlead: true'), file('kernel-reviewer', 'name: kernel-reviewer\ndescription: Mine.\nrole: Reviewer'), file('a', 'name: kai\ndescription: First.'), file('b', 'name: kai\ndescription: Second.')])
    expect(roles(r.agents)).toEqual([['kernel-lead', 'Rowan', 'lead', 'builtin'], ['kai', 'Kai', 'member']])
    expect(r.agents.find((a) => a.id === 'kai')?.description).toBe('First.')
    expect(warningsOf(r.agents)).toEqual({ 'kernel-lead': ['reserved-id:kernel-lead.md', 'reserved-id:kernel-reviewer.md'], kai: ['duplicate-id:b.md'] })
  })

  // KERNEL-451: a broken file shows on Team with its error and does nothing else.
  it("keeps a file Kernel can't read on the team with its error, never as the Lead, the reviewer or a teammate", async () => {
    const broken = (name: string, head: string) => agentFromFile(`/repo/.claude/agents/${name}.md`, `---\n${head}\n---\nBody`)
    const r = await team([broken('ada', 'name: ada\ndescription: "Plans.\nlead: true'), broken('rex', 'name: rex\ndescription: "Reviews.\nrole: Reviewer'), KAI], { reviewer: 'rex' })
    expect(roles(r.agents)).toEqual([['kernel-lead', 'Rowan', 'lead', 'builtin'], ['ada', 'Ada', 'helper'], ['kai', 'Kai', 'member'], ['rex', 'Rex', 'helper']])
    const kinds = Object.fromEntries(r.agents.map((a) => [a.id, a.warnings?.map((w) => w.kind) ?? []]))
    expect(kinds).toEqual({ 'kernel-lead': ['setting-missing'], ada: ['unreadable-file'], kai: [], rex: ['unreadable-file'] })
    // A file that reads keeps the name, even when the broken one comes first by file name.
    const twin = await team([broken('kai', 'name: kai\ndescription: "Frontend'), file('kai2', 'name: kai\ndescription: Frontend engineer.\ntools: Read, Edit, Bash')])
    expect(twin.agents.find((a) => a.id === 'kai')).toMatchObject({ file: '/repo/.claude/agents/kai2.md', member: true, warnings: [{ kind: 'duplicate-id', detail: 'kai.md' }] })
  })

  it('makes a helper of an agent whose disallowedTools takes away Bash or every editing tool', async () => {
    const r = await team([file('scout', 'name: scout\ndescription: x\ndisallowedTools: Bash'), file('pen', 'name: pen\ndescription: x\ndisallowedTools: [Edit, Write]'), NOOR], undefined, { starters: false })
    expect(roles(r.agents)).toEqual([['noor', 'Noor', 'member'], ['pen', 'Pen', 'helper'], ['scout', 'Scout', 'helper']])
    expect(warningsOf(r.agents)).toEqual({ pen: ['cant-open-pr'], scout: ['cant-open-pr'] })
  })

  it('reads tool lines in every form, and an agent with only MCP tools is a helper', async () => {
    const r = await team([
      file('flow', 'name: flow\ndescription: x\ntools: [Read, MultiEdit, Bash]'),
      file('block', 'name: block\ndescription: x\ntools:\n  - Read\n  - Write\n  - Bash(git:*)'),
      file('mcp', 'name: mcp\ndescription: x\ntools: mcp__github'),
      file('blank', 'name: blank\ndescription: ""')
    ], undefined, { starters: false })
    expect(roles(r.agents)).toEqual([['blank', 'Blank', 'member'], ['block', 'Block', 'member'], ['flow', 'Flow', 'member'], ['mcp', 'Mcp', 'helper']])
    // No Lead without the starter folder. Kernel's code review is bundled into the app, so it needs none.
    expect([r.leadFrom, r.reviewerFrom]).toEqual(['none', 'builtin'])
    expect(warningsOf(r.agents)).toEqual({ blank: ['no-description'], mcp: ['cant-open-pr'] })
  })

  // KERNEL-465: a subagent collection's files have no tools line, which would make every one of them a teammate.
  it('makes a helper of an agent written as a subagent with no pull request workflow, and says so', async () => {
    const files = [
      file('architect', 'name: architect\ndescription: Designs the system. Use proactively.', 'You are a senior architect. Return a design.'),
      file('api', 'name: api\ndescription: Builds the API, then opens a pull request.', 'You build the API.'),
      file('fixer', 'name: fixer\ndescription: Fixes bugs.', 'Work on your own branch.'),
      file('porter', 'name: porter\ndescription: Ports code.', 'Stay in your worktree. Open a PR.'),
      file('editor', 'name: editor\ndescription: Edits copy.\ntools: Read, Edit, Bash', 'You edit copy.'),
      file('reader', 'name: reader\ndescription: Reads code.\ntools: Read, Grep', 'You read code.')
    ]
    const r = await team(files, undefined, { starters: false })
    expect(roles(r.agents)).toEqual([['api', 'Api', 'member'], ['architect', 'Architect', 'helper'], ['editor', 'Editor', 'member'], ['fixer', 'Fixer', 'member'], ['porter', 'Porter', 'member'], ['reader', 'Reader', 'helper']])
    // An agent whose tools can't open a pull request says that instead.
    expect(warningsOf(r.agents)).toEqual({ architect: ['looks-like-subagent'], reader: ['cant-open-pr'] })
    expect(files.map(writtenAsSubagent)).toEqual([true, false, false, false, false, true])
    // [team] decides over the default, with nothing to warn about.
    const kept = await team(files, { members: ['architect'], helpers: ['api'] }, { starters: false })
    expect(roles(kept.agents).slice(0, 2)).toEqual([['api', 'Api', 'helper'], ['architect', 'Architect', 'member']])
    expect(warningsOf(kept.agents)).toEqual({ reader: ['cant-open-pr'] })
    // One can still lead: the Lead takes no tasks either way.
    expect(warningsOf((await team(files.slice(0, 2), { lead: 'architect' }, { starters: false })).agents)).toEqual({})
  })

  it("keeps only the roster's agents on the team, and the Lead and the reviewer whatever it says", async () => {
    const files = [KAI, NOOR, ROWAN, THEO, file('ivy', 'name: ivy\ndescription: QA.\nrole: QA')]
    const r = await team(files, { roster: ['kai', 'ghost'] })
    expect(roles(r.agents)).toEqual([['rowan', 'Rowan', 'lead'], ['kai', 'Kai', 'member'], ['theo', 'Theo', 'reviewer']])
    expect([r.leadFrom, r.reviewerFrom]).toEqual(['file', 'file'])
    // An id that names nobody is left out quietly: a retired agent's id stays on the roster, so restoring it puts it back.
    expect(warningsOf(r.agents)).toEqual({})
    // [team] picks the Lead from every file, on the roster or not.
    expect(roles((await team(files, { roster: ['kai'], lead: 'noor', reviewer: 'none' })).agents)).toEqual([['noor', 'Noor', 'lead'], ['kai', 'Kai', 'member']])
    // An empty roster is no roster.
    expect((await team(files, { roster: [] })).agents).toHaveLength(5)
  })

  it('asks for a roster past 12 agent files, suggesting the agents that take tasks', async () => {
    const teammates = Array.from({ length: 11 }, (_, i) => file(`dev${i + 10}`, `name: dev${i + 10}\ndescription: Engineer.`))
    const helpers = [file('scout', 'name: scout\ndescription: Looks things up.\ntools: Read'), file('architect', 'name: architect\ndescription: Designs.', 'You design.')]
    const all = (await team([...teammates, ...helpers])).agents
    expect(adviseRoster(all)).toEqual({ agents: 13, needed: true, suggested: teammates.map((a) => a.id) })
    expect(adviseRoster(all, { roster: ['dev10'] })).toMatchObject({ agents: 13, needed: false })
    // Kernel's own Rowan doesn't count.
    expect(adviseRoster((await team([...teammates, helpers[0]])).agents)).toEqual({ agents: 12, needed: false, suggested: teammates.map((a) => a.id) })
  })
})
