import { describe, expect, it } from 'vitest'
import { canOpenPr, LEAD_FILES_ISSUES, mcpWarnings, missingServers, serverReach, toolKind, toolName, toolPolicy } from '../src/main/services/agentTools'
import { toolServerName } from '../src/main/services/mcp'
import { BUILD_CLOSED, buildWrite, guardVerdict, type Rules } from '../src/main/services/permissions'

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
    expect(toolPolicy(undefined, { disallowed: [] })).toBeUndefined()
  })

  // KERNEL-549: a review chat only reads, whatever its agent's file says. Bash stays for git and gh.
  it('keeps a read-only session from writing any file, a plan included, whatever its tools line says', () => {
    const plans = '/Users/you/.claude/plans'
    for (const p of [toolPolicy(undefined, { readOnly: true, plans })!, toolPolicy(['Read', 'Edit', 'Write', 'NotebookEdit', 'Bash'], { readOnly: true, plans })!]) {
      expect(p.hidden).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']))
      for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(p.allows(t, { file_path: `${plans}/plan.md` }), t).toBe(false)
      expect(p.disallows('Edit')).toBe(true)
      for (const t of ['Bash', 'Read', 'mcp__kernel__submit_review']) expect(p.allows(t), t).toBe(true)
    }
    // Without it, a plan file still takes a write.
    expect(toolPolicy(['Read'], { plans })!.allows('Write', { file_path: `${plans}/plan.md` })).toBe(true)
  })

  // KERNEL-451: an empty tools line is no tools in Claude Code, so the agent keeps only Kernel's tools and the session's.
  it('leaves an agent with an empty tools line only the tools every agent keeps', () => {
    const none = toolPolicy([])!
    expect(none.hidden).toEqual(['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent'])
    for (const t of ['mcp__kernel__create_workspace', 'ExitPlanMode', 'AskUserQuestion', 'TodoWrite']) expect(none.allows(t), t).toBe(true)
    for (const t of ['Read', 'Write', 'BashOutput', 'mcp__linear__get_issue']) expect(none.allows(t), t).toBe(false)
    expect(canOpenPr([])).toBe(false)
  })

  it('takes away what disallowedTools names, by name, alias, rule or server, and keeps what every agent keeps', () => {
    const p = toolPolicy(undefined, { disallowed: ['Bash(rm:*)', 'Task', 'WebFetch', 'mcp__github', 'mcp__sentry__*', 'mcp__linear__save_issue', 'ExitPlanMode', 'mcp__kernel__share_file', 'Write'], plans: '/Users/you/.claude/plans' })!
    expect(p.hidden).toEqual(['Bash', 'WebFetch', 'Agent', 'mcp__github', 'mcp__sentry', 'mcp__linear__save_issue'])
    for (const t of ['Bash', 'BashOutput', 'KillShell', 'Agent', 'WebFetch', 'Write', 'mcp__github__create_pull_request', 'mcp__sentry__get_issue', 'mcp__linear__save_issue']) {
      expect(p.allows(t), t).toBe(false)
      expect(p.disallows(t), t).toBe(true)
    }
    for (const t of ['Read', 'Edit', 'mcp__linear__get_issue', 'mcp__githubx__thing', 'ExitPlanMode', 'mcp__kernel__share_file']) expect(p.allows(t), t).toBe(true)
    expect(p.disallows('ExitPlanMode')).toBe(false)
    // Plan mode still writes its plan (D-023).
    expect(p.allows('Write', { file_path: '/Users/you/.claude/plans/quiet-otter.md' })).toBe(true)
    expect(canOpenPr(undefined, ['Bash'])).toBe(false)
    expect(canOpenPr(['Read', 'Edit', 'Write', 'Bash'], ['Edit'])).toBe(true)
    expect(canOpenPr(['Read', 'Edit', 'Bash'], ['MultiEdit'])).toBe(false)
  })

  it('takes every MCP server but Kernel\'s for mcp__* in disallowedTools, and grants none for it in a tools line', () => {
    const off = toolPolicy(['Read', 'mcp__linear'], { disallowed: ['mcp__*'] })!
    expect(off.hidden).not.toContain('mcp__*')
    for (const t of ['mcp__linear__get_issue', 'mcp__github__search']) expect(off.allows(t), t).toBe(false)
    expect(off.allows('mcp__kernel__create_workspace')).toBe(true)
    expect(off.server('linear')).toEqual({ on: false })
    expect(off.server('kernel')).toEqual({ on: true })
    const star = toolPolicy(['Read', 'mcp__*'])!
    expect(star.allows('mcp__linear__get_issue')).toBe(false)
    expect(missingServers(['mcp__*'], [])).toEqual([])
  })

  it('says how much of each MCP server a session may reach', () => {
    const both = toolPolicy(['Read', 'mcp__linear', 'mcp__github__search_code', 'mcp__github__get_file', 'mcp__sentry__get_issue'], { disallowed: ['mcp__linear__delete_issue', 'mcp__sentry'] })!
    expect(['linear', 'github', 'sentry', 'figma', 'kernel'].map((s) => both.server(s))).toEqual([
      { on: true, except: ['delete_issue'] }, { on: true, only: ['search_code', 'get_file'] }, { on: false }, { on: false }, { on: true }
    ])
    const unlisted = toolPolicy(undefined, { disallowed: ['Bash', 'mcp__github__merge_pull_request'] })!
    expect(['github', 'linear'].map((s) => unlisted.server(s))).toEqual([{ on: true, except: ['merge_pull_request'] }, { on: true }])
    expect(toolPolicy(['mcp__github__merge'], { disallowed: ['mcp__github__merge'] })!.server('github')).toEqual({ on: false })
  })

  it("allows what the line lists, Kernel's own tools and the session's, and nothing else", () => {
    const theo = toolPolicy(['Read', 'Grep', 'Glob', 'Bash', 'mcp__linear__get_issue'], { plans: '/Users/you/.claude/plans' })!
    expect(theo.hidden).toEqual(['WebFetch', 'WebSearch', 'NotebookEdit', 'Agent'])
    for (const t of ['Read', 'Bash', 'mcp__linear__get_issue', 'mcp__kernel__submit_review', 'mcp__kernel__share_file', 'ExitPlanMode', 'ToolSearch', 'Skill', 'TodoWrite']) expect(theo.allows(t), t).toBe(true)
    for (const t of ['Write', 'Edit', 'mcp__linear__save_issue', 'mcp__github__create_pull_request', 'WebFetch']) expect(theo.allows(t), t).toBe(false)
    // Plan mode writes its plan to ~/.claude/plans before it asks, whatever the tools line says (D-023).
    expect(theo.allows('Write', { file_path: '/Users/you/.claude/plans/quiet-otter.md' })).toBe(true)
    expect(theo.allows('Edit', { file_path: '/Users/you/.claude/plans/quiet-otter.md' })).toBe(true)
    for (const file_path of ['/Users/you/.claude/plans/sub/x.md', '/Users/you/.claude/plans/../settings.json', '/Users/you/.claude/plans/x.json', '/repo/src/index.ts']) expect(theo.allows('Write', { file_path }), file_path).toBe(false)
    const kernel = toolPolicy(['Read', 'Grep', 'Glob', 'Bash', 'mcp__linear'])!
    expect(kernel.allows('mcp__linear__save_issue')).toBe(true)
    expect(kernel.allows('mcp__linearx__thing')).toBe(false)
    expect(toolPolicy(['mcp__claude_ai_github__*'])!.allows('mcp__claude_ai_github__search_code')).toBe(true)
    expect(toolPolicy(['Task', 'Read'])!.allows('Agent')).toBe(true)
    // A background command started with Bash can be read and stopped, and only by an agent that has Bash.
    expect(theo.allows('BashOutput')).toBe(true)
    expect(toolPolicy(['Read'])!.allows('KillShell')).toBe(false)
  })

  it('names a blocked tool without its MCP server', () => {
    expect(['Write', 'MultiEdit', 'mcp__acme_secret__deploy', 'Monitor'].map(toolKind)).toEqual(['Write', 'Edit', 'mcp', 'other'])
  })

  const up = (...names: string[]) => names.map((name) => ({ name, status: 'connected' }))

  it('names each MCP server the tools line lists that the session lacks, once, with a connected match', () => {
    // A session names a claude.ai connector as Claude Code lists it, and its tools by the name made from that (KERNEL-464).
    const connected = up('kernel', 'claude.ai Linear', 'github')
    expect(missingServers(['Read', 'mcp__linear', 'mcp__linear__get_issue', 'mcp__sentry__*', 'mcp__github__create_pr'], connected)).toEqual([
      { server: 'linear', entry: 'mcp__linear', suggestion: 'claude_ai_Linear' },
      { server: 'sentry', entry: 'mcp__sentry__*' },
    ])
  })

  it("finds nothing missing without a tools line, for Kernel's own tools, or when every server is connected", () => {
    expect(missingServers(undefined, [])).toEqual([])
    expect(missingServers(['Read', 'mcp__kernel__submit_review', 'mcp__kernel'], [])).toEqual([])
    expect(missingServers(['mcp__linear__get_issue', 'mcp__github'], up('linear', 'github'))).toEqual([])
    expect(missingServers(['mcp__claude_ai_Linear__get_issue'], up('claude.ai Linear'))).toEqual([])
    // A server still connecting, or one a probe hasn't reached, counts as there.
    expect(missingServers(['mcp__linear'], [{ name: 'linear', status: 'pending' }, { name: 'github' }])).toEqual([])
  })

  // KERNEL-464: a server that failed, needs sign-in or is switched off fails its tools the way a missing one does.
  it('counts a server that failed, needs sign-in or is switched off as unusable, with why', () => {
    const servers = [
      { name: 'linear', status: 'failed' }, { name: 'claude.ai Notion', status: 'needs-auth' }, { name: 'fal-ai', status: 'disabled' },
      { name: 'figma', status: 'connected', enabled: false }, { name: 'github', status: 'connected' }
    ]
    expect(missingServers(['mcp__linear', 'mcp__claude_ai_Notion__search', 'mcp__fal-ai', 'mcp__figma__get_code', 'mcp__github'], servers)).toEqual([
      { server: 'linear', entry: 'mcp__linear', status: 'failed', name: 'linear' },
      { server: 'claude_ai_Notion', entry: 'mcp__claude_ai_Notion__search', status: 'needs-auth', name: 'claude.ai Notion' },
      { server: 'fal-ai', entry: 'mcp__fal-ai', status: 'disabled', name: 'fal-ai' },
      { server: 'figma', entry: 'mcp__figma__get_code', status: 'off', name: 'figma' }
    ])
    // A later report on the same server wins, so the project's switched-off list overrides a session that had it.
    expect(missingServers(['mcp__linear'], [{ name: 'linear', status: 'failed' }, { name: 'linear', status: 'connected' }])).toEqual([])
    // A failed server is never offered in place of a missing one.
    expect(missingServers(['mcp__linear'], [{ name: 'claude.ai Linear', status: 'needs-auth' }])).toEqual([{ server: 'linear', entry: 'mcp__linear' }])
  })

  it("makes a server's tool name the way Claude Code does", () => {
    expect(['claude.ai Linear', 'claude.ai  Google Drive ', 'my server', 'fal-ai', 'plugin:github:github'].map(toolServerName)).toEqual(['claude_ai_Linear', 'claude_ai_Google_Drive', 'my_server', 'fal-ai', 'plugin_github_github'])
  })

  // KERNEL-464: a confirmed `[mcp.aliases]` entry lets a file written for one Mac's server name reach this Mac's.
  it('reads a tools line through the project\'s aliases, adding the server each name stands for', () => {
    const aliases = { linear: 'claude.ai Linear', sentry: 'claude_ai_Sentry', kernel: 'linear', github: 'kernel', figma: '*' }
    const p = toolPolicy(['Read', 'mcp__linear', 'mcp__sentry__get_issue', 'mcp__figma'], { aliases, disallowed: ['mcp__linear__delete_issue'] })!
    for (const t of ['mcp__linear__get_issue', 'mcp__claude_ai_Linear__get_issue', 'mcp__claude_ai_Sentry__get_issue', 'mcp__sentry__get_issue']) expect(p.allows(t), t).toBe(true)
    for (const t of ['mcp__claude_ai_Linear__delete_issue', 'mcp__linear__delete_issue', 'mcp__claude_ai_Sentry__list_issues', 'mcp__github__search']) expect(p.allows(t), t).toBe(false)
    expect(p.hidden).toEqual(['Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent', 'mcp__linear__delete_issue', 'mcp__claude_ai_Linear__delete_issue'])
    expect(['claude_ai_Linear', 'claude_ai_Sentry', 'linear', 'kernel'].map((s) => p.server(s))).toEqual([
      { on: true, except: ['delete_issue'] }, { on: true, only: ['get_issue'] }, { on: true, except: ['delete_issue'] }, { on: true }
    ])
    // disallowedTools reads through them too.
    expect(toolPolicy(undefined, { aliases, disallowed: ['mcp__linear'] })!.allows('mcp__claude_ai_Linear__get_issue')).toBe(false)
    expect(missingServers(['mcp__linear__get_issue'], up('claude.ai Linear'), aliases)).toEqual([])
    expect(missingServers(['mcp__linear__get_issue'], [{ name: 'claude.ai Linear', status: 'failed' }], aliases)).toEqual([{ server: 'linear', entry: 'mcp__linear__get_issue', status: 'failed', name: 'claude.ai Linear' }])
  })

  it('turns what a tools line lacks into Team warnings, naming a missing server only once the list is whole', () => {
    const servers = [{ name: 'claude.ai Linear', status: 'needs-auth' }, { name: 'neon', status: 'failed' }, { name: 'figma', enabled: false }, { name: 'claude.ai Sentry', status: 'connected' }]
    const tools = ['Read', 'mcp__claude_ai_Linear', 'mcp__neon__run_sql', 'mcp__figma', 'mcp__sentry', 'mcp__slack']
    expect(mcpWarnings(tools, servers)).toEqual([
      { kind: 'mcp-needs-auth', detail: 'claude.ai Linear' }, { kind: 'mcp-failed', detail: 'neon' }, { kind: 'mcp-off', detail: 'figma' }
    ])
    expect(mcpWarnings(tools, servers, { complete: true }).slice(3)).toEqual([
      { kind: 'mcp-missing', detail: 'sentry', suggestion: 'claude_ai_Sentry' }, { kind: 'mcp-missing', detail: 'slack' }
    ])
    expect(mcpWarnings(tools, servers, { complete: true, aliases: { sentry: 'claude_ai_Sentry' } }).map((w) => w.detail)).toEqual(['claude.ai Linear', 'neon', 'figma', 'slack'])
    expect(mcpWarnings(undefined, servers, { complete: true })).toEqual([])
  })

  // KERNEL-476: the new agent card and create_agent's result list what a new agent can reach and what its file names but can't use.
  it("lists the servers a tools line reaches and the ones it names but can't use, never Kernel's own", () => {
    const servers = [
      { name: 'figma', status: 'connected' }, { name: 'claude.ai Linear', status: 'needs-auth' }, { name: 'neon', status: 'failed' },
      { name: 'github', enabled: false }, { name: 'notion', status: 'pending' }, { name: 'sentry' }, { name: 'kernel', status: 'connected' }
    ]
    const tools = ['Read', 'Edit', 'Bash', 'mcp__figma__*', 'mcp__claude_ai_Linear', 'mcp__neon__run_sql', 'mcp__github', 'mcp__notion', 'mcp__slack']
    // A starting or unreported server counts as there. Slack isn't named missing until the list is whole.
    expect(serverReach(tools, servers)).toEqual({
      reach: ['figma', 'notion'],
      blocked: [{ name: 'claude.ai Linear', why: 'needs-auth' }, { name: 'neon', why: 'failed' }, { name: 'github', why: 'off' }]
    })
    expect(serverReach(tools, servers, { complete: true }).blocked.slice(3)).toEqual([{ name: 'slack', why: 'missing' }])
    // No tools line reaches every working server. A line with no MCP entries reaches none.
    expect(serverReach(undefined, servers)).toEqual({ reach: ['figma', 'notion', 'sentry'], blocked: [] })
    expect(serverReach(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], servers, { complete: true })).toEqual({ reach: [], blocked: [] })
    // disallowedTools takes a server away, one tool of it leaves the rest, and an alias reaches the server it stands for.
    expect(serverReach(undefined, servers, { disallowed: ['mcp__figma', 'mcp__notion__search'] }).reach).toEqual(['notion', 'sentry'])
    expect(serverReach(['mcp__sentry__get_issue', 'mcp__lin'], [{ name: 'claude.ai Linear', status: 'connected' }, { name: 'sentry' }], { complete: true })).toEqual({
      reach: ['sentry'], blocked: [{ name: 'lin', why: 'missing', suggestion: 'claude_ai_Linear' }]
    })
    expect(serverReach(['mcp__linear'], [{ name: 'claude.ai Linear', status: 'connected' }], { aliases: { linear: 'claude.ai Linear' }, complete: true })).toEqual({ reach: ['claude.ai Linear'], blocked: [] })
  })

  it("takes a Lead's tracker issue writes away under the usual server names, keeps its reads, and leaves a teammate's alone (feat-lead-files-tracker-issues-only-with)", () => {
    const writes = ['mcp__linear__save_issue', 'mcp__linear__save_comment', 'mcp__claude_ai_Linear__save_issue', 'mcp__linear-server__create_issue', 'mcp__github__issue_write', 'mcp__github__add_issue_comment', 'mcp__claude_ai_github__issue_write', 'mcp__claude_ai_github__update_issue_comment']
    const reads = ['mcp__linear__get_issue', 'mcp__claude_ai_Linear__list_comments', 'mcp__github__issue_read', 'mcp__claude_ai_github__search_issues', 'mcp__figma__save_issue']
    for (const lead of ['handoff', 'build'] as const) {
      for (const tools of [undefined, ['Read', 'Bash', 'mcp__linear', 'mcp__github', 'mcp__claude_ai_Linear', 'mcp__claude_ai_github', 'mcp__linear-server', 'mcp__figma']]) {
        const p = toolPolicy(tools, { lead })!
        for (const t of writes) {
          expect(p.allows(t), t).toBe(false)
          expect(p.modeRefuses(t), t).toBe(LEAD_FILES_ISSUES)
        }
        for (const t of reads) expect(p.allows(t), t).toBe(true)
        expect(p.hidden).toEqual(expect.arrayContaining(['mcp__linear__save_issue', 'mcp__claude_ai_Linear__save_issue', 'mcp__github__issue_write', 'mcp__claude_ai_github__issue_write', 'mcp__claude_ai_github__add_issue_comment']))
        // Codex turns them off on the server by tool name.
        expect(p.server('linear')).toEqual({ on: true, except: expect.arrayContaining(['save_issue', 'save_comment']) })
        expect(p.server('github')).toEqual({ on: true, except: expect.arrayContaining(['issue_write', 'add_issue_comment']) })
        expect(p.server('figma')).toEqual({ on: true })
      }
    }
    // A line naming only some of a server's tools keeps the reads among them.
    expect(toolPolicy(['mcp__linear__get_issue', 'mcp__linear__save_issue'], { lead: 'handoff' })!.server('linear')).toEqual({ on: true, only: ['get_issue'] })
    const mate = toolPolicy(['Read', 'mcp__linear', 'mcp__github'])!
    for (const t of ['mcp__linear__save_issue', 'mcp__github__issue_write']) expect(mate.allows(t), t).toBe(true)
    expect(mate.hidden.some((t) => t.startsWith('mcp__'))).toBe(false)
  })

  it("takes a Lead's issue writes away on a server the project aliases to Linear or GitHub, whatever its name (feat-lead-files-tracker-issues-only-with)", () => {
    // The file's name on the left, the server's own on the right, as `[mcp.aliases]` has them, in either direction.
    const aliases = { linear: 'tracker', 'work-gh': 'github', 'claude.ai Linear': 'acme-issues' }
    const p = toolPolicy(undefined, { lead: 'handoff', aliases })!
    for (const t of ['mcp__tracker__save_issue', 'mcp__tracker__save_comment', 'mcp__work-gh__issue_write', 'mcp__acme-issues__create_issue']) {
      expect(p.allows(t), t).toBe(false)
      expect(p.modeRefuses(t), t).toBe(LEAD_FILES_ISSUES)
    }
    for (const t of ['mcp__tracker__get_issue', 'mcp__work-gh__issue_read', 'mcp__sentry__update_issue']) expect(p.allows(t), t).toBe(true)
    expect(p.hidden).toEqual(expect.arrayContaining(['mcp__tracker__save_issue', 'mcp__work-gh__issue_write', 'mcp__acme-issues__save_issue']))
    // Codex turns them off on the server by its own name.
    expect(p.server('tracker')).toEqual({ on: true, except: expect.arrayContaining(['save_issue', 'save_comment']) })
    expect(p.server('acme-issues')).toEqual({ on: true, except: expect.arrayContaining(['save_issue']) })
    expect(p.server('sentry')).toEqual({ on: true })
    // A teammate with the same aliases keeps them.
    expect(toolPolicy(['mcp__linear'], { aliases })!.allows('mcp__tracker__save_issue')).toBe(true)
  })

  it('lets an agent use the MCP servers its project allows it, unless disallowedTools takes them (KERNEL-537)', () => {
    const p = toolPolicy(['Read', 'mcp__linear'], { allow: ['figma'] })!
    expect(p.allows('mcp__figma__get_file')).toBe(true)
    expect(p.server('figma')).toEqual({ on: true })
    expect(p.allows('mcp__sentry__issues')).toBe(false)
    expect(toolPolicy(['Read'], { allow: ['figma'], disallowed: ['mcp__figma'] })!.allows('mcp__figma__get_file')).toBe(false)
    // An alias names the server it stands for too.
    expect(toolPolicy(['Read'], { allow: ['linear'], aliases: { linear: 'claude_ai_Linear' } })!.allows('mcp__claude_ai_Linear__get_issue')).toBe(true)
  })
})

describe("Build here's gate on file changes and publishing (KERNEL-992)", () => {
  const cwd = '/tmp/ws'
  const plans = '/tmp/plans'
  const deny = { behavior: 'deny', message: BUILD_CLOSED }

  it('denies Edit, Write, MultiEdit and NotebookEdit until the gate opens, and leaves reads, plan files and shared files alone', () => {
    let open = false
    const gate = (tool: string, input: unknown) => buildWrite({ tool, input, cwd }, () => open, plans)
    for (const tool of ['Edit', 'Write', 'MultiEdit']) expect(gate(tool, { file_path: 'src/a.ts' }), tool).toEqual(deny)
    expect(gate('NotebookEdit', { notebook_path: 'n.ipynb' })).toEqual(deny)
    expect(gate('Edit', {})).toEqual(deny)
    expect(gate('Read', { file_path: 'src/a.ts' })).toBeUndefined()
    expect(gate('Write', { file_path: '/tmp/plans/plan.md' })).toBeUndefined()
    expect(gate('Write', { file_path: '/tmp/plans/sub/plan.md' })).toEqual(deny)
    expect(gate('Write', { file_path: '.kernel/shared/mock.html' })).toBeUndefined()
    expect(gate('Write', { file_path: '/tmp/ws/.kernel/shared/a/b.png' })).toBeUndefined()
    expect(gate('Write', { file_path: '.kernel/shared/../../src/a.ts' })).toEqual(deny)
    open = true
    expect(gate('Edit', { file_path: 'src/a.ts' })).toBeUndefined()
  })

  const rules = (mode: Rules['mode'], open: () => boolean): Rules => ({ permissions: { mode, alwaysAsk: [], neverAllow: [], protectedBranches: ['main'], approvalTimeoutSec: 300 } as unknown as Rules['permissions'], mode, projectAllow: () => [], projectTools: () => [], lead: true, buildClosed: () => !open() })

  it('denies git commit, git push and gh pr create while closed, in chains, under bash -c and with env prefixes, in Bypass permissions too, and runs the rest', () => {
    let open = false
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      const r = rules(mode, () => open)
      for (const c of ['git commit -m x', 'pnpm test && git push -u origin feat/x', 'bash -c "git add -A && git commit -m x"', 'GIT_AUTHOR_NAME=x git commit -m y', 'gh pr create --fill']) expect(guardVerdict(c, r), `${mode}: ${c}`).toEqual(deny)
      for (const c of ['git status', 'git diff', 'pnpm test', 'pnpm shots Landing']) expect(guardVerdict(c, r)?.behavior, `${mode}: ${c}`).not.toBe('deny')
    }
    open = true
    expect(guardVerdict('git commit -m x', rules('acceptEdits', () => open))?.behavior).not.toBe('deny')
  })

  it("doesn't gate a step that isn't a Build here Lead's", () => {
    expect(guardVerdict('git commit -m x', { ...rules('acceptEdits', () => false), buildClosed: undefined })?.behavior).not.toBe('deny')
  })
})
