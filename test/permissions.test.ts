import { describe, expect, it } from 'vitest'
import type { Decision, PermissionMode } from '@shared/types'
import type { AppSettings } from '../src/main/services/settings'
import { ALWAYS_ASK, decide, effectiveMode, guardVerdict, hookVerdict, matchesToolRule, NETWORK_OFF, neverAllowed, pushOwnBranch, rulesOf, saveAlwaysAllow, stricter, toolRule, type ChatAvailability, type Rules, type RunMode, type Step } from '../src/main/services/permissions'

function rules(o: { mode?: RunMode; network?: boolean; roomAllow?: string[]; roomTools?: string[]; branches?: string[] } = {}): Rules & { reads: number; toolReads: number } {
  const permissions = { mode: 'acceptEdits' as const, bypassOnlyInWorktrees: true, network: o.network ?? true, alwaysAsk: ['drizzle-kit push'], neverAllow: ['rm -rf /'], protectedBranches: o.branches ?? ['main'], approvalTimeoutSec: 300 }
  const r = { permissions, mode: o.mode ?? 'acceptEdits', branch: 'feat/invoice-schema', reads: 0, toolReads: 0, roomAllow: () => { r.reads++; return o.roomAllow ?? [] }, roomTools: () => { r.toolReads++; return o.roomTools ?? [] } }
  return r
}

/** A push to the protected branch, built so this file's text never holds the command itself. */
const toMain = ['git', 'push', 'origin', 'main'].join(' ')

describe('guardVerdict', () => {
  it('denies Never allow and protected-branch pushes, allows a room rule and asks for Always ask', () => {
    const r = rules({ roomAllow: ['pnpm test'] })
    expect(guardVerdict('rm -rf /', r)).toEqual({ behavior: 'deny', message: 'Kernel blocks "rm -rf /" in every room.' })
    expect(guardVerdict(toMain, r)).toEqual({ behavior: 'deny', message: neverAllowed(toMain) })
    expect(guardVerdict('pnpm test', r)).toEqual({ behavior: 'allow' })
    expect(guardVerdict('pnpm drizzle-kit push', r)).toEqual({ behavior: 'ask', reason: ALWAYS_ASK })
    expect(guardVerdict('ls', r)).toBeUndefined()
  })

  it('folds Network off into a Never allow denial, as the Claude hook has always said it', () => {
    expect(guardVerdict('curl https://example.com', rules({ network: false }))).toEqual({ behavior: 'deny', message: neverAllowed('curl https://example.com') })
  })

  it('in Bypass permissions keeps only the denials, with no opinion on Always ask or a room rule (KERNEL-447)', () => {
    const bypass = rules({ mode: 'bypassPermissions', roomAllow: ['pnpm test'] })
    expect(guardVerdict('rm -rf /', bypass)).toEqual({ behavior: 'deny', message: neverAllowed('rm -rf /') })
    expect(guardVerdict('curl https://example.com', rules({ mode: 'bypassPermissions', network: false }))).toEqual({ behavior: 'deny', message: neverAllowed('curl https://example.com') })
    expect(guardVerdict('pnpm drizzle-kit push', bypass)).toBeUndefined()
    expect(guardVerdict('pnpm test', bypass)).toBeUndefined()
    expect(guardVerdict('ls', bypass)).toBeUndefined()
  })

  it('in Bypass permissions denies a push that might reach a protected branch, and tells the agent to push its own (KERNEL-447)', () => {
    const bypass = rules({ mode: 'bypassPermissions', roomAllow: ['git push:*'] })
    const own = { behavior: 'deny', message: pushOwnBranch(['main'], 'feat/invoice-schema') }
    for (const push of [toMain, 'git push', 'git push origin', 'git push -u origin HEAD', 'git push origin "$BRANCH"', 'git push origin "feat/*"']) expect(guardVerdict(push, bypass), push).toEqual(own)
    expect(guardVerdict('git push -u origin feat/invoice-schema', bypass)).toBeUndefined()
    expect(guardVerdict('git push origin HEAD:feat/invoice-schema', bypass)).toBeUndefined()
    // No protected branch, nothing to keep a push from.
    expect(guardVerdict('git push', rules({ mode: 'bypassPermissions', branches: [] }))).toBeUndefined()
    // Every other mode leaves a bare push to the user's own settings, and asks about a ref it can't read, as before.
    expect(guardVerdict('git push', rules())).toBeUndefined()
    expect(guardVerdict('git push origin "$BRANCH"', rules())).toEqual({ behavior: 'ask', reason: ALWAYS_ASK })
  })

  it("keeps Bypass permissions' push denials on top of a stricter mode's asks while Claude Code may still run in bypass", () => {
    const leaving = { ...rules({ roomAllow: ['git push:*'] }), mayBypass: true }
    const own = { behavior: 'deny', message: pushOwnBranch(['main'], 'feat/invoice-schema') }
    for (const push of ['git push', 'git push -u origin HEAD', 'git push origin "$BRANCH"', toMain]) expect(guardVerdict(push, leaving), push).toEqual(own)
    // The stricter mode's asks and denials still hold.
    expect(guardVerdict('pnpm drizzle-kit push', leaving)).toEqual({ behavior: 'ask', reason: ALWAYS_ASK })
    expect(guardVerdict('rm -rf /', leaving)).toEqual({ behavior: 'deny', message: neverAllowed('rm -rf /') })
    expect(guardVerdict('git push -u origin feat/invoice-schema', leaving)).toEqual({ behavior: 'allow' })
    expect(guardVerdict('ls', leaving)).toBeUndefined()
  })

  it('names the protected branches, and the push that works when the workspace has its own branch', () => {
    expect(pushOwnBranch(['main'], 'feat/x')).toBe('Kernel blocks pushes that might reach main in Bypass permissions. Push your own branch by name: git push origin feat/x.')
    expect(pushOwnBranch(['main', 'dev', 'release'], 'feat/x')).toContain('might reach main, dev or release')
    expect(pushOwnBranch(['main'], 'main')).toBe('Kernel blocks pushes that might reach main in Bypass permissions. Push your own branch by name.')
  })
})

describe('effectiveMode (KERNEL-447)', () => {
  const settings = (mode: PermissionMode, bypassOnlyInWorktrees?: boolean) => ({ permissions: { mode, ...(bypassOnlyInWorktrees === undefined ? {} : { bypassOnlyInWorktrees }) } }) as unknown as AppSettings
  const all: ChatAvailability = { auto: true, bypass: true }
  const worktree = { mode: 'worktree' as const }
  const current = { mode: 'current' as const }
  const chat = (o: { plan?: boolean; mode?: PermissionMode } = {}) => ({ plan: o.plan ?? false, mode: o.mode })

  it('takes plan first, then the chat, then the room, then the app', () => {
    expect(effectiveMode(chat({ plan: true, mode: 'bypassPermissions' }), worktree, { permissionMode: 'auto' }, settings('default'), all)).toBe('plan')
    expect(effectiveMode(chat({ mode: 'bypassPermissions' }), worktree, { permissionMode: 'auto' }, settings('default'), all)).toBe('bypassPermissions')
    expect(effectiveMode(chat(), worktree, { permissionMode: 'auto' }, settings('default'), all)).toBe('auto')
    expect(effectiveMode(chat(), worktree, {}, settings('default'), all)).toBe('default')
    expect(effectiveMode(chat(), worktree, undefined, settings('acceptEdits'), all)).toBe('acceptEdits')
  })

  it("lets an agent file's mode only tighten, with its plan and dontAsk as Manual", () => {
    expect(effectiveMode(chat({ mode: 'bypassPermissions' }), worktree, undefined, settings('default'), all, { permissionMode: 'acceptEdits' })).toBe('acceptEdits')
    expect(effectiveMode(chat({ mode: 'default' }), worktree, undefined, settings('default'), all, { permissionMode: 'bypassPermissions' })).toBe('default')
    expect(effectiveMode(chat({ mode: 'auto' }), worktree, undefined, settings('default'), all, { permissionMode: 'acceptEdits' })).toBe('acceptEdits')
    expect(effectiveMode(chat({ mode: 'bypassPermissions' }), worktree, undefined, settings('default'), all, { permissionMode: 'plan' })).toBe('default')
    expect(effectiveMode(chat({ mode: 'acceptEdits' }), worktree, undefined, settings('default'), all, { permissionMode: 'dontAsk' })).toBe('default')
  })

  it('runs Auto as Accept edits where the chat cannot run it', () => {
    expect(effectiveMode(chat({ mode: 'auto' }), worktree, undefined, settings('default'), { auto: false, bypass: true })).toBe('acceptEdits')
  })

  it('runs Bypass permissions as Accept edits where policy turns it off, and on a current-branch workspace with Only in worktrees on', () => {
    expect(effectiveMode(chat({ mode: 'bypassPermissions' }), worktree, undefined, settings('default'), { auto: true, bypass: false })).toBe('acceptEdits')
    expect(effectiveMode(chat({ mode: 'bypassPermissions' }), current, undefined, settings('default', true), all)).toBe('acceptEdits')
    // Unset counts as on.
    expect(effectiveMode(chat({ mode: 'bypassPermissions' }), current, undefined, settings('default'), all)).toBe('acceptEdits')
    expect(effectiveMode(chat({ mode: 'bypassPermissions' }), current, undefined, settings('default', false), all)).toBe('bypassPermissions')
  })

  it('reads a mode it does not know as Manual, wherever it comes from', () => {
    expect(effectiveMode({ plan: false, mode: 'bypassInWorktrees' as never }, worktree, undefined, settings('acceptEdits'), all)).toBe('acceptEdits')
    expect(effectiveMode(chat(), worktree, undefined, settings('ask' as never), all)).toBe('default')
  })

  it('orders the modes from plan, the strictest, to Bypass permissions', () => {
    expect(stricter<RunMode>('plan', 'default')).toBe('plan')
    expect(stricter<RunMode>('bypassPermissions', 'acceptEdits')).toBe('acceptEdits')
    expect(stricter<RunMode>('auto', 'acceptEdits')).toBe('acceptEdits')
    expect(stricter<RunMode>('auto', 'bypassPermissions')).toBe('auto')
  })
})

describe('decide', () => {
  it("allows Kernel's own tools before any rule, Network off included", () => {
    expect(decide({ tool: 'mcp__kernel__create_workspace' }, rules({ mode: 'default', network: false }))).toEqual({ behavior: 'allow' })
  })

  it('denies with the network message for web tools, networked commands and steps that ask for the network', () => {
    const off = rules({ network: false })
    const denied = { behavior: 'deny', message: NETWORK_OFF }
    expect(decide({ tool: 'WebFetch' }, off)).toEqual(denied)
    expect(decide({ tool: 'WebSearch' }, off)).toEqual(denied)
    expect(decide({ tool: 'Bash', command: 'curl https://example.com' }, off)).toEqual(denied)
    expect(decide({ tool: 'Bash', command: 'ls', network: true, sandbox: 'outside' }, off)).toEqual(denied)
    expect(decide({ tool: 'WebFetch' }, rules())).toBeUndefined()
  })

  it('lets the lists decide a command before the mode', () => {
    const edits = rules({ roomAllow: ['pnpm test'] })
    expect(decide({ tool: 'Bash', command: 'rm -rf /', sandbox: 'inside' }, edits)).toEqual({ behavior: 'deny', message: neverAllowed('rm -rf /') })
    expect(decide({ tool: 'Bash', command: 'pnpm drizzle-kit push', sandbox: 'inside' }, edits)).toEqual({ behavior: 'ask', reason: ALWAYS_ASK })
    expect(decide({ tool: 'Bash', command: 'pnpm test', sandbox: 'outside' }, rules({ mode: 'default', roomAllow: ['pnpm test'] }))).toEqual({ behavior: 'allow' })
  })

  it('reads the room rules only for a command', () => {
    const r = rules()
    decide({ tool: 'Edit' }, r)
    decide({ tool: 'Bash', command: '' }, r)
    expect(r.reads).toBe(0)
    decide({ tool: 'Bash', command: 'ls' }, r)
    expect(r.reads).toBe(1)
  })

  it('on Claude, gives no opinion by mode, so in Bypass permissions whatever Claude Code still asks about goes to the user (KERNEL-447)', () => {
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      expect(decide({ tool: 'Bash', command: 'rm -rf node_modules' }, rules({ mode })), mode).toBeUndefined()
      expect(decide({ tool: 'Edit' }, rules({ mode })), mode).toBeUndefined()
    }
    expect(decide({ tool: 'AskUserQuestion' }, rules({ mode: 'bypassPermissions' }))).toBeUndefined()
    expect(decide({ tool: 'ExitPlanMode' }, rules({ mode: 'bypassPermissions' }))).toBeUndefined()
    // The denials still hold.
    expect(decide({ tool: 'Bash', command: 'rm -rf /' }, rules({ mode: 'bypassPermissions' }))).toEqual({ behavior: 'deny', message: neverAllowed('rm -rf /') })
    expect(decide({ tool: 'WebFetch' }, rules({ mode: 'bypassPermissions', network: false }))).toEqual({ behavior: 'deny', message: NETWORK_OFF })
  })

  it('on Codex, accepts inside the sandbox in every mode that takes edits, and leaves a step outside it to the user but in Bypass permissions', () => {
    const inside = { tool: 'Bash', command: 'y', sandbox: 'inside' as const }
    const outside = { tool: 'Bash', command: 'pnpm test', sandbox: 'outside' as const }
    for (const mode of ['acceptEdits', 'auto'] as const) {
      expect(decide(inside, rules({ mode }))).toEqual({ behavior: 'allow' })
      expect(decide(outside, rules({ mode }))).toBeUndefined()
    }
    for (const mode of ['default', 'plan'] as const) {
      expect(decide(inside, rules({ mode }))).toBeUndefined()
      expect(decide(outside, rules({ mode }))).toBeUndefined()
    }
    expect(decide({ tool: 'Edit', sandbox: 'inside' }, rules())).toEqual({ behavior: 'allow' })
    expect(decide({ tool: 'Edit', sandbox: 'outside' }, rules())).toBeUndefined()
  })

  it('on Codex in Bypass permissions, accepts what the denials let through, outside the sandbox and Always ask included (KERNEL-447)', () => {
    const bypass = rules({ mode: 'bypassPermissions' })
    expect(decide({ tool: 'Bash', command: 'pnpm build', sandbox: 'outside' }, bypass)).toEqual({ behavior: 'allow' })
    expect(decide({ tool: 'Bash', command: 'pnpm drizzle-kit push', sandbox: 'outside' }, bypass)).toEqual({ behavior: 'allow' })
    expect(decide({ tool: 'Write', sandbox: 'outside' }, bypass)).toEqual({ behavior: 'allow' })
    expect(decide({ tool: 'Permissions', network: true, sandbox: 'outside' }, bypass)).toEqual({ behavior: 'allow' })
    expect(decide({ tool: 'Bash', command: 'rm -rf /', sandbox: 'outside' }, bypass)).toEqual({ behavior: 'deny', message: neverAllowed('rm -rf /') })
    expect(decide({ tool: 'Bash', command: 'git push', sandbox: 'outside' }, bypass)).toEqual({ behavior: 'deny', message: pushOwnBranch(['main'], 'feat/invoice-schema') })
    const off = rules({ mode: 'bypassPermissions', network: false })
    expect(decide({ tool: 'Bash', command: 'curl https://example.com', sandbox: 'outside' }, off)).toEqual({ behavior: 'deny', message: NETWORK_OFF })
    expect(decide({ tool: 'Permissions', network: true, sandbox: 'outside' }, off)).toEqual({ behavior: 'deny', message: NETWORK_OFF })
  })
})

describe('rulesOf', () => {
  it('reads the lists from Settings, Permissions, the mode from the chat unless the runner names one, and the branch from the workspace', () => {
    const permissions = { mode: 'acceptEdits', bypassOnlyInWorktrees: true, network: false, alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }
    let reads = 0
    const host = { settings: () => ({ permissions }) as unknown as AppSettings, mode: () => 'bypassPermissions' as const, roomAllow: () => { reads++; return ['ls'] }, roomTools: () => { reads++; return ['WebSearch'] }, workspace: { mode: 'worktree', branch: 'feat/x' } as never }
    expect(rulesOf(host)).toMatchObject({ permissions, mode: 'bypassPermissions', branch: 'feat/x' })
    expect(rulesOf(host, 'default').mode).toBe('default')
    expect(reads).toBe(0)
    expect(rulesOf(host).roomAllow()).toEqual(['ls'])
    expect(rulesOf(host).roomTools()).toEqual(['WebSearch'])
  })
})

describe("a room's tool rules (KERNEL-454)", () => {
  it('match an MCP tool by its name or its server, and a fetch by its host', () => {
    expect(matchesToolRule('mcp__linear__get_issue', {}, ['mcp__linear__get_issue'])).toBe(true)
    expect(matchesToolRule('mcp__linear__get_issue', {}, ['mcp__linear'])).toBe(true)
    expect(matchesToolRule('mcp__linear__get_issue', {}, ['mcp__linear__*'])).toBe(true)
    expect(matchesToolRule('mcp__claude_ai_Linear__get_issue', {}, ['mcp__claude_ai_Linear'])).toBe(true)
    expect(matchesToolRule('mcp__linear__save_issue', {}, ['mcp__linear__get_issue'])).toBe(false)
    expect(matchesToolRule('mcp__linear_admin__drop', {}, ['mcp__linear'])).toBe(false)
    expect(matchesToolRule('WebFetch', { url: 'https://Docs.Example.com/a' }, ['WebFetch(domain:docs.example.com)'])).toBe(true)
    expect(matchesToolRule('WebFetch', { url: 'https://evil.dev/?q=docs.example.com' }, ['WebFetch(domain:docs.example.com)'])).toBe(false)
    expect(matchesToolRule('WebFetch', { url: 'https://example.com' }, ['WebFetch(domain:docs.example.com)'])).toBe(false)
    expect(matchesToolRule('WebSearch', { query: 'zod' }, ['WebSearch'])).toBe(true)
  })

  it('never cover a file tool or Bash, whatever a rule names', () => {
    for (const tool of ['Edit', 'Write', 'Read', 'Bash', 'NotebookEdit', 'AskUserQuestion', 'ExitPlanMode']) expect(matchesToolRule(tool, {}, [tool]), tool).toBe(false)
  })

  it('are saved as Claude Code writes them, and only for MCP and web tools', () => {
    expect(toolRule('mcp__linear__get_issue', { id: 'KERNEL-1' })).toBe('mcp__linear__get_issue')
    expect(toolRule('WebFetch', { url: 'https://docs.example.com/guide', prompt: 'x' })).toBe('WebFetch(domain:docs.example.com)')
    expect(toolRule('WebFetch', { url: 'not a url' })).toBeUndefined()
    expect(toolRule('WebSearch', { query: 'zod' })).toBe('WebSearch')
    expect(toolRule('Edit', { file_path: '/etc/hosts' })).toBeUndefined()
  })

  it("let canUseTool allow a covered tool before it asks, in every mode but Bypass permissions, and after Network off", () => {
    const linear = { tool: 'mcp__linear__get_issue', input: {} }
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto'] as const) expect(decide(linear, rules({ mode, roomTools: ['mcp__linear'] })), mode).toEqual({ behavior: 'allow' })
    expect(decide(linear, rules({ mode: 'bypassPermissions', roomTools: ['mcp__linear'] }))).toBeUndefined()
    expect(decide(linear, rules({ roomTools: ['mcp__github'] }))).toBeUndefined()
    const fetch = { tool: 'WebFetch', input: { url: 'https://docs.example.com' } }
    expect(decide(fetch, rules({ roomTools: ['WebFetch(domain:docs.example.com)'] }))).toEqual({ behavior: 'allow' })
    expect(decide(fetch, rules({ network: false, roomTools: ['WebFetch(domain:docs.example.com)'] }))).toEqual({ behavior: 'deny', message: NETWORK_OFF })
  })

  it('are read only for a step they could cover', () => {
    const r = rules()
    decide({ tool: 'Edit' }, r)
    decide({ tool: 'Bash', command: 'ls' }, r)
    decide({ tool: 'mcp__kernel__create_workspace' }, r)
    expect(r.toolReads).toBe(0)
    decide({ tool: 'mcp__linear__get_issue' }, r)
    expect(r.toolReads).toBe(1)
  })
})

describe('hookVerdict (KERNEL-454)', () => {
  it("allows a room rule from the hook in Manual, Accept edits and Auto, so Auto mode's classifier can't refuse it", () => {
    for (const mode of ['default', 'acceptEdits', 'auto'] as const) {
      expect(hookVerdict({ tool: 'Bash', command: 'cd web && pnpm test' }, rules({ mode, roomAllow: ['pnpm test'] })), mode).toEqual({ behavior: 'allow' })
      expect(hookVerdict({ tool: 'mcp__linear__get_issue' }, rules({ mode, roomTools: ['mcp__linear__get_issue'] })), mode).toEqual({ behavior: 'allow' })
    }
  })

  it('leaves a room rule to canUseTool in plan mode, and reads none in Bypass permissions', () => {
    for (const mode of ['plan', 'bypassPermissions'] as const) {
      expect(hookVerdict({ tool: 'Bash', command: 'pnpm test' }, rules({ mode, roomAllow: ['pnpm test'] })), mode).toBeUndefined()
      expect(hookVerdict({ tool: 'mcp__linear__get_issue' }, rules({ mode, roomTools: ['mcp__linear__get_issue'] })), mode).toBeUndefined()
    }
  })

  it('still denies Never allow, protected pushes and Network off over any room rule, and asks for Always ask', () => {
    const r = rules({ mode: 'auto', roomAllow: ['rm:*', 'git push:*', 'curl:*'], roomTools: ['WebSearch'] })
    expect(hookVerdict({ tool: 'Bash', command: 'cd / && rm -rf /' }, r)).toEqual({ behavior: 'deny', message: neverAllowed('cd / && rm -rf /') })
    expect(hookVerdict({ tool: 'Bash', command: toMain }, r)).toEqual({ behavior: 'deny', message: neverAllowed(toMain) })
    expect(hookVerdict({ tool: 'Bash', command: 'pnpm drizzle-kit push' }, r)).toEqual({ behavior: 'ask', reason: ALWAYS_ASK })
    const off = rules({ mode: 'auto', network: false, roomAllow: ['curl:*'], roomTools: ['WebSearch'] })
    expect(hookVerdict({ tool: 'Bash', command: 'curl https://example.com' }, off)).toEqual({ behavior: 'deny', message: neverAllowed('curl https://example.com') })
    expect(hookVerdict({ tool: 'WebSearch', input: { query: 'zod' } }, off)).toEqual({ behavior: 'deny', message: NETWORK_OFF })
  })
})

describe('saveAlwaysAllow', () => {
  const save = (step: Step, decision: Decision | undefined, o?: Parameters<typeof saveAlwaysAllow>[3]) => {
    const saved: string[] = []
    saveAlwaysAllow({ allowInRoom: (rule) => { saved.push(rule) }, allowToolInRoom: (rule) => { saved.push(`tool:${rule}`) } }, step, decision, o)
    return saved
  }

  it("saves the command, or Claude Code's single Bash suggestion when it may be saved", () => {
    const one = [{ type: 'addRules' as const, behavior: 'allow' as const, destination: 'localSettings' as const, rules: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }] }]
    expect(save({ tool: 'Bash', command: ' pnpm test ' }, { behavior: 'allow', always: true })).toEqual(['pnpm test'])
    expect(save({ tool: 'Bash', command: 'npm run build -- --watch' }, { behavior: 'allow', always: true }, { suggestions: one })).toEqual(['npm run build:*'])
    expect(save({ tool: 'Bash', command: 'npm run build -- --watch' }, { behavior: 'allow', always: true }, { suggestions: one, suppressAlwaysAllowRule: true })).toEqual(['npm run build -- --watch'])
  })

  it('saves nothing without Always allow, or with no decision', () => {
    expect(save({ tool: 'Bash', command: 'pnpm test' }, { behavior: 'allow' })).toEqual([])
    expect(save({ tool: 'Bash', command: 'pnpm test' }, { behavior: 'deny' })).toEqual([])
    expect(save({ tool: 'Bash', command: 'pnpm test' }, undefined)).toEqual([])
    expect(save({ tool: 'mcp__linear__get_issue' }, { behavior: 'allow' })).toEqual([])
  })

  it('saves a tool rule on the room for an MCP or web tool, unless Claude Code says the ask may not offer one (KERNEL-454)', () => {
    expect(save({ tool: 'mcp__linear__get_issue', input: { id: 'KERNEL-1' } }, { behavior: 'allow', always: true })).toEqual(['tool:mcp__linear__get_issue'])
    expect(save({ tool: 'WebFetch', input: { url: 'https://docs.example.com/a' } }, { behavior: 'allow', always: true })).toEqual(['tool:WebFetch(domain:docs.example.com)'])
    expect(save({ tool: 'mcp__linear__get_issue', input: {} }, { behavior: 'allow', always: true }, { suppressAlwaysAllowRule: true })).toEqual([])
    expect(save({ tool: 'WebFetch' }, { behavior: 'allow', always: true })).toEqual([])
    expect(save({ tool: 'Edit', input: { file_path: '/etc/hosts' } }, { behavior: 'allow', always: true })).toEqual([])
  })
})
