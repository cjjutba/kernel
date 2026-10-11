import { describe, expect, it } from 'vitest'
import type { Decision } from '@shared/types'
import type { AppSettings } from '../src/main/services/settings'
import { ALWAYS_ASK, decide, guardVerdict, NETWORK_OFF, neverAllowed, rulesOf, saveAlwaysAllow, type Rules, type Step } from '../src/main/services/permissions'

type Mode = AppSettings['permissions']['mode']

function rules(o: { mode?: Mode; network?: boolean; roomAllow?: string[]; worktree?: boolean } = {}): Rules & { reads: number } {
  const permissions = { mode: o.mode ?? 'acceptEdits', network: o.network ?? true, alwaysAsk: ['drizzle-kit push'], neverAllow: ['rm -rf /'], protectedBranches: ['main'], approvalTimeoutSec: 300 }
  const r = { permissions, mode: permissions.mode, worktree: o.worktree ?? true, reads: 0, roomAllow: () => { r.reads++; return o.roomAllow ?? [] } }
  return r
}

describe('guardVerdict', () => {
  it('denies Never allow and protected-branch pushes, allows a room rule and asks for Always ask', () => {
    const r = rules({ roomAllow: ['pnpm test'] })
    expect(guardVerdict('rm -rf /', r)).toEqual({ behavior: 'deny', message: 'Kernel blocks "rm -rf /" in every room.' })
    expect(guardVerdict('git push origin main', r)).toEqual({ behavior: 'deny', message: neverAllowed('git push origin main') })
    expect(guardVerdict('pnpm test', r)).toEqual({ behavior: 'allow' })
    expect(guardVerdict('pnpm drizzle-kit push', r)).toEqual({ behavior: 'ask', reason: ALWAYS_ASK })
    expect(guardVerdict('ls', r)).toBeUndefined()
  })

  it('folds Network off into a Never allow denial, as the Claude hook has always said it', () => {
    expect(guardVerdict('curl https://example.com', rules({ network: false }))).toEqual({ behavior: 'deny', message: neverAllowed('curl https://example.com') })
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
    const bypass = rules({ mode: 'bypassPermissions', roomAllow: ['pnpm test'] })
    expect(decide({ tool: 'Bash', command: 'rm -rf /' }, bypass)).toEqual({ behavior: 'deny', message: neverAllowed('rm -rf /') })
    expect(decide({ tool: 'Bash', command: 'pnpm drizzle-kit push' }, bypass)).toEqual({ behavior: 'ask', reason: ALWAYS_ASK })
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

  it('on Claude, lets Bypass in worktrees through in a worktree only, and never a question or a plan', () => {
    const step = { tool: 'Bash', command: 'ls' }
    expect(decide(step, rules({ mode: 'bypassPermissions' }))).toEqual({ behavior: 'allow' })
    expect(decide(step, rules({ mode: 'bypassPermissions', worktree: false }))).toBeUndefined()
    expect(decide(step, rules({ mode: 'acceptEdits' }))).toBeUndefined()
    expect(decide(step, rules({ mode: 'default' }))).toBeUndefined()
    expect(decide({ tool: 'AskUserQuestion' }, rules({ mode: 'bypassPermissions' }))).toBeUndefined()
    expect(decide({ tool: 'ExitPlanMode' }, rules({ mode: 'bypassPermissions' }))).toBeUndefined()
  })

  it("on Codex, accepts inside the sandbox in every mode but Ask, and leaves a step outside it to the user in every mode", () => {
    const inside = { tool: 'Bash', command: 'y', sandbox: 'inside' as const }
    const outside = { tool: 'Bash', command: 'pnpm test', sandbox: 'outside' as const }
    for (const mode of ['acceptEdits', 'bypassPermissions'] as const) {
      expect(decide(inside, rules({ mode, worktree: false }))).toEqual({ behavior: 'allow' })
      expect(decide(outside, rules({ mode }))).toBeUndefined()
    }
    expect(decide(inside, rules({ mode: 'default' }))).toBeUndefined()
    expect(decide(outside, rules({ mode: 'default' }))).toBeUndefined()
    expect(decide({ tool: 'Edit', sandbox: 'inside' }, rules())).toEqual({ behavior: 'allow' })
    expect(decide({ tool: 'Edit', sandbox: 'outside' }, rules())).toBeUndefined()
  })
})

describe('rulesOf', () => {
  it("reads the mode and network from Settings, Permissions, and the worktree from the workspace", () => {
    const permissions = { mode: 'bypassPermissions', bypassOnlyInWorktrees: true, network: false, alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }
    let reads = 0
    const r = rulesOf({ settings: () => ({ permissions }) as unknown as AppSettings, roomAllow: () => { reads++; return ['ls'] }, workspace: { mode: 'worktree' } as never })
    expect(r).toMatchObject({ permissions, mode: 'bypassPermissions', worktree: true })
    expect(reads).toBe(0)
    expect(r.roomAllow()).toEqual(['ls'])
  })
})

describe('saveAlwaysAllow', () => {
  const save = (step: Step, decision: Decision | undefined, o?: Parameters<typeof saveAlwaysAllow>[3]) => {
    const saved: string[] = []
    saveAlwaysAllow({ allowInRoom: (rule) => { saved.push(rule) } }, step, decision, o)
    return saved
  }

  it("saves the command, or Claude Code's single Bash suggestion when it may be saved", () => {
    const one = [{ type: 'addRules' as const, behavior: 'allow' as const, destination: 'localSettings' as const, rules: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }] }]
    expect(save({ tool: 'Bash', command: ' pnpm test ' }, { behavior: 'allow', always: true })).toEqual(['pnpm test'])
    expect(save({ tool: 'Bash', command: 'npm run build -- --watch' }, { behavior: 'allow', always: true }, { suggestions: one })).toEqual(['npm run build:*'])
    expect(save({ tool: 'Bash', command: 'npm run build -- --watch' }, { behavior: 'allow', always: true }, { suggestions: one, suppressAlwaysAllowRule: true })).toEqual(['npm run build -- --watch'])
  })

  it('saves nothing without Always allow, without a command, or with no decision', () => {
    expect(save({ tool: 'Bash', command: 'pnpm test' }, { behavior: 'allow' })).toEqual([])
    expect(save({ tool: 'Bash', command: 'pnpm test' }, { behavior: 'deny' })).toEqual([])
    expect(save({ tool: 'Bash', command: 'pnpm test' }, undefined)).toEqual([])
    expect(save({ tool: 'WebFetch' }, { behavior: 'allow', always: true })).toEqual([])
  })
})
