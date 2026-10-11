import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentDef, TeamConfig } from '@shared/types'
import { agentFromFile } from '../src/main/services/agents'
import { loadBuiltins } from '../src/main/services/builtins'
import { resolveTeam } from '../src/main/services/teamResolve'

// KERNEL-397: one team per room, whatever shape its .claude/agents folder has. Kernel's Rowan and Theo fill the gaps.
const STARTERS = join(__dirname, '..', 'docs', 'starter-agents')

const file = (name: string, head: string, body = 'Body') => agentFromFile(`/repo/.claude/agents/${name}.md`, `---\n${head}\n---\n${body}`)

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
  it('gives an empty room Kernel\'s Rowan and Theo, and no teammates', async () => {
    const r = await team([])
    expect(roles(r.agents)).toEqual([['kernel-lead', 'Rowan', 'lead', 'builtin'], ['kernel-reviewer', 'Theo', 'reviewer', 'builtin']])
    expect([r.leadFrom, r.reviewerFrom]).toEqual(['builtin', 'builtin'])
    const [lead, reviewer] = r.agents
    expect(lead).toMatchObject({ file: '', role: 'Lead' })
    expect([lead.model, lead.effort]).toEqual([undefined, undefined])
    expect(lead.prompt).toMatch(/^You are Rowan, the lead/)
    expect(reviewer).toMatchObject({ tools: ['Read', 'Grep', 'Glob', 'Bash'], member: false })
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
    expect(roles(r.agents)).toEqual([['ada', 'Ada', 'lead'], ['kai', 'Kai', 'member'], ['kernel-reviewer', 'Theo', 'reviewer', 'builtin'], ['zed', 'Zed', 'member']])
    expect(warningsOf(r.agents)).toEqual({ zed: ['second-lead:Ada'] })
  })

  it('follows [team]: the Lead, no reviewer, and who takes tasks', async () => {
    const helper = file('scout', 'name: scout\ndescription: Looks things up.\ntools: Read, WebFetch')
    const r = await team([KAI, NOOR, ROWAN, helper], { lead: 'noor', reviewer: 'none', helpers: ['kai'], members: ['scout'] })
    expect(roles(r.agents)).toEqual([['noor', 'Noor', 'lead'], ['kai', 'Kai', 'helper'], ['rowan', 'Rowan', 'member'], ['scout', 'Scout', 'member']])
    expect([r.leadFrom, r.reviewerFrom]).toEqual(['setting', 'setting'])
    expect(warningsOf(r.agents)).toEqual({ rowan: ['second-lead:Noor'] })
    const builtins = await team([KAI, ROWAN], { lead: 'kernel-lead', reviewer: 'kernel-reviewer' })
    expect(roles(builtins.agents)).toEqual([['kernel-lead', 'Lead', 'lead', 'builtin'], ['kai', 'Kai', 'member'], ['rowan', 'Rowan', 'member'], ['kernel-reviewer', 'Theo', 'reviewer', 'builtin']])
  })

  it('flags a [team] setting that names nobody, and resolves as if it were not there', async () => {
    const r = await team([KAI, ROWAN], { lead: 'ghost', reviewer: 'rowan' })
    expect(roles(r.agents)).toEqual([['rowan', 'Rowan', 'lead'], ['kai', 'Kai', 'member'], ['kernel-reviewer', 'Theo', 'reviewer', 'builtin']])
    expect(warningsOf(r.agents)).toEqual({ rowan: ['setting-missing:lead = "ghost"'], 'kernel-reviewer': ['setting-missing:reviewer = "rowan"'] })
  })

  it("names Kernel's agents apart from a repo's own Rowan and Theo", async () => {
    const r = await team([file('rowan', 'name: rowan\ndescription: Frontend engineer.\nrole: Frontend'), file('theo', 'name: theo\ndescription: Data engineer.\nrole: Data')])
    expect(roles(r.agents)).toEqual([['kernel-lead', 'Lead', 'lead', 'builtin'], ['kernel-reviewer', 'Reviewer', 'reviewer', 'builtin'], ['rowan', 'Rowan', 'member'], ['theo', 'Theo', 'member']])
    expect(r.agents[0].prompt).toMatch(/^You are the Lead of this room's team in Kernel\./)
    expect(r.agents[1].prompt).toMatch(/^You are the reviewer\./)
    const both = await team([file('rowan', 'name: rowan\ndescription: x\nrole: Frontend'), file('lead', 'name: lead\ndescription: x\nrole: Data')])
    expect(both.agents[0]).toMatchObject({ id: 'kernel-lead', name: 'Kernel Lead' })
  })

  it("skips a file that takes Kernel's ids or another file's name", async () => {
    const r = await team([file('kernel-lead', 'name: kernel-lead\ndescription: Mine.\nlead: true'), file('a', 'name: kai\ndescription: First.'), file('b', 'name: kai\ndescription: Second.')])
    expect(roles(r.agents)).toEqual([['kernel-lead', 'Rowan', 'lead', 'builtin'], ['kai', 'Kai', 'member'], ['kernel-reviewer', 'Theo', 'reviewer', 'builtin']])
    expect(r.agents.find((a) => a.id === 'kai')?.description).toBe('First.')
    expect(warningsOf(r.agents)).toEqual({ 'kernel-lead': ['reserved-id:kernel-lead.md'], kai: ['duplicate-id:b.md'] })
  })

  it('reads tool lines in every form, and an agent with only MCP tools is a helper', async () => {
    const r = await team([
      file('flow', 'name: flow\ndescription: x\ntools: [Read, MultiEdit, Bash]'),
      file('block', 'name: block\ndescription: x\ntools:\n  - Read\n  - Write\n  - Bash(git:*)'),
      file('mcp', 'name: mcp\ndescription: x\ntools: mcp__github'),
      file('blank', 'name: blank\ndescription: ""')
    ], undefined, { starters: false })
    expect(roles(r.agents)).toEqual([['blank', 'Blank', 'member'], ['block', 'Block', 'member'], ['flow', 'Flow', 'member'], ['mcp', 'Mcp', 'helper']])
    expect([r.leadFrom, r.reviewerFrom]).toEqual(['none', 'none'])
    expect(warningsOf(r.agents)).toEqual({ blank: ['no-description'], mcp: ['cant-open-pr'] })
  })
})
