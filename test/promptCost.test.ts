import { describe, expect, it } from 'vitest'
import { LEAD_RULE, forProvider } from '../src/main/services/handoff'
import { kernelTools } from '../src/main/services/kernelMcp'
import { teammateTools } from '../src/main/services/teammateMcp'
import { reviewTools } from '../src/main/services/reviewMcp'
import { ALWAYS_LOAD, kernelServer, LEAD_ALWAYS_LOADED } from '../src/main/services/kernelServer'
import { toolSpecs } from '../src/main/services/providers/codex/tools'
import { costTable, promptCosts } from './promptCost'

// lean-lead-prompt: what every session pays before the user says anything, and which of the Lead's tools wait behind tool search.

const stub = {} as never
const words = (t: string) => t.split(/\s+/).filter(Boolean).length

/** The `_meta` the SDK registered for each tool of a server built by `kernelServer`. */
function metaOf(server: ReturnType<typeof kernelServer>): Record<string, Record<string, unknown> | undefined> {
  const registered = (server.instance as unknown as { _registeredTools: Record<string, { _meta?: Record<string, unknown> }> })._registeredTools
  return Object.fromEntries(Object.entries(registered).map(([name, t]) => [name, t._meta]))
}

describe('what each session pays up front (lean-lead-prompt)', () => {
  it('prints the table with KERNEL_PROMPT_COST=1', () => {
    if (process.env.KERNEL_PROMPT_COST) console.log(`\nLEAD_RULE words: ${words(LEAD_RULE)}\n${costTable()}`)
    expect(costTable()).toMatch(/^lead/)
  })

  it('keeps the Lead rule under 550 words and the Lead, teammate and reviewer prompts under their budgets', () => {
    expect(words(LEAD_RULE)).toBeLessThan(550)
    const c = promptCosts()
    // Before this change: Lead rule text 1,628 tokens and tools 4,654 (all loaded), teammate 364 and 911, reviewer 624 and 797.
    expect(c.lead.rule.tokens).toBeLessThan(1350)
    expect(c.lead.loaded.tokens).toBeLessThan(2200)
    expect(c.lead.tools.tokens).toBeLessThan(4400)
    expect(c.teammate.tools.tokens).toBeLessThan(850)
    expect(c.reviewer.tools.tokens).toBeLessThan(780)
  })
})

describe("the Lead's tools wait behind tool search, except the ones most sessions call (lean-lead-prompt)", () => {
  const names = kernelTools(stub).map((t) => t.name)

  it('always loads the hand-off, planning and question tools, and defers the rest', () => {
    expect([...LEAD_ALWAYS_LOADED].sort()).toEqual(['ask_user', 'create_workspace', 'list_agents', 'list_workspaces', 'message_agent', 'request_plan_approval', 'say'])
    for (const name of LEAD_ALWAYS_LOADED) expect(names, name).toContain(name)
    const meta = metaOf(kernelServer(kernelTools(stub), 'x', { loaded: LEAD_ALWAYS_LOADED }))
    for (const name of names) expect(meta[name]?.[ALWAYS_LOAD], name).toBe(LEAD_ALWAYS_LOADED.includes(name))
    for (const rare of ['create_agent', 'set_project_scripts', 'overrule_blockers', 'file_issue', 'link_issue', 'archive_workspace', 'merge_workspace', 'read_plans', 'wait_for_merge']) expect(meta[rare]?.[ALWAYS_LOAD], rare).toBe(false)
  })

  it("keeps a teammate's and a reviewer's few tools always loaded", () => {
    for (const tools of [teammateTools({} as never), reviewTools({} as never)]) {
      const meta = metaOf(kernelServer(tools))
      for (const t of tools) expect(meta[t.name]?.[ALWAYS_LOAD], t.name).toBe(true)
    }
  })

  it('keeps every Lead tool described, and gives Codex the same tool names with no tool search', () => {
    const tools = kernelTools(stub)
    for (const t of tools) expect(t.description.length, t.name).toBeGreaterThan(20)
    expect(toolSpecs(tools).map((s) => s.name).sort()).toEqual([
      'kernel_archive_workspace', 'kernel_ask_user', 'kernel_create_agent', 'kernel_create_workspace', 'kernel_file_issue', 'kernel_link_issue', 'kernel_list_agents',
      'kernel_list_workspaces', 'kernel_merge_workspace', 'kernel_message_agent', 'kernel_overrule_blockers', 'kernel_read_plans', 'kernel_request_plan_approval',
      'kernel_say', 'kernel_set_project_scripts', 'kernel_wait_for_merge'
    ])
  })
})

describe("the Lead's rule says what it means (lean-lead-prompt)", () => {
  it('says what to do with a Team update from a closed tab, with plain criteria and no undefined words', () => {
    expect(LEAD_RULE).toContain('If it says it comes from a tab the user closed, that work is yours now: handle it like your own hand-offs.')
    expect(LEAD_RULE).toContain('stays in one area of the code, takes about an hour and has no parallel pieces')
    expect(LEAD_RULE).not.toMatch(/\blane\b|\bshort\b.*\bPR\b/)
    expect(LEAD_RULE).toContain('Mixed work: do the quick one-area part yourself and hand off the rest in the same turn.')
  })

  it('makes one clear ask a go-ahead for your own work or one teammate, and two or more teammates one yes-or-no question', () => {
    expect(LEAD_RULE).toContain('One clear ask, even as a question, is a go-ahead for work you do yourself or give to one teammate. For two or more teammates, say who gets what, ask one yes-or-no question')
    expect(LEAD_RULE).not.toContain('Before creating several workspaces')
  })

  it('names failed checks, puts the PR parts inside the repo template, and ends only a report of finished work with a line', () => {
    expect(LEAD_RULE).toContain('Fix failed checks, review blockers and merge conflicts.')
    expect(LEAD_RULE).toContain("In the PR body, inside the repo's template if it has one, write What changed")
    expect(LEAD_RULE).toContain('When you report finished work, end with one line')
    expect(LEAD_RULE).toContain('You may change files in the folder this chat works in.')
    expect(LEAD_RULE).not.toContain('This chat has a folder and branch of its own')
  })

  it('keeps naming tools the way Codex calls them', () => {
    expect(forProvider(LEAD_RULE, 'codex')).toContain('kernel_create_workspace')
    expect(forProvider(LEAD_RULE, 'codex')).not.toContain('mcp__kernel__')
  })
})
