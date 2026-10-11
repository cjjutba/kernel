import { describe, expect, it } from 'vitest'
import { canOpenPr, toolKind, toolName, toolPolicy } from '../src/main/services/agentTools'

// KERNEL-397: an agent file's tools line holds in Kernel the way it does when Claude Code runs the file as a subagent.
describe('agent tools', () => {
  it('reads each form of a tools entry', () => {
    expect(['Bash(git:*)', ' Read ', 'Task', 'MultiEdit', 'LS', 'mcp__linear__get_issue'].map(toolName)).toEqual(['Bash', 'Read', 'Agent', 'Edit', 'Glob', 'mcp__linear__get_issue'])
  })

  it('knows who can take a task through to a pull request', () => {
    expect(canOpenPr(undefined)).toBe(true)
    expect(canOpenPr(['Read', 'Edit', 'Bash'])).toBe(true)
    expect(canOpenPr(['Read', 'MultiEdit', 'Bash(git:*)'])).toBe(true)
    expect(canOpenPr(['Read', 'Write'])).toBe(false)
    expect(canOpenPr(['Read', 'Grep', 'Glob', 'Bash'])).toBe(false)
  })

  it('lets an agent with no tools line use everything', () => {
    expect(toolPolicy(undefined)).toBeUndefined()
    expect(toolPolicy([])).toBeUndefined()
  })

  it("allows what the line lists, Kernel's own tools and the session's, and nothing else", () => {
    const theo = toolPolicy(['Read', 'Grep', 'Glob', 'Bash', 'mcp__linear__get_issue'])!
    expect(theo.hidden).toEqual(['Write', 'Edit', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent'])
    for (const t of ['Read', 'Bash', 'mcp__linear__get_issue', 'mcp__kernel__submit_review', 'mcp__kernel__share_file', 'ExitPlanMode', 'ToolSearch', 'Skill', 'TodoWrite']) expect(theo.allows(t), t).toBe(true)
    for (const t of ['Write', 'Edit', 'mcp__linear__save_issue', 'mcp__github__create_pull_request', 'WebFetch']) expect(theo.allows(t), t).toBe(false)
    const rowan = toolPolicy(['Read', 'Grep', 'Glob', 'Bash', 'mcp__linear'])!
    expect(rowan.allows('mcp__linear__save_issue')).toBe(true)
    expect(rowan.allows('mcp__linearx__thing')).toBe(false)
    expect(toolPolicy(['mcp__claude_ai_github__*'])!.allows('mcp__claude_ai_github__search_code')).toBe(true)
    expect(toolPolicy(['Task', 'Read'])!.allows('Agent')).toBe(true)
  })

  it('names a blocked tool without its MCP server', () => {
    expect(['Write', 'MultiEdit', 'mcp__acme_secret__deploy', 'Monitor'].map(toolKind)).toEqual(['Write', 'Edit', 'mcp', 'other'])
  })
})
