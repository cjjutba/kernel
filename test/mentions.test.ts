import { describe, expect, it, vi } from 'vitest'
import type { AgentDef, ChatPart, Workspace } from '@shared/types'
import { LEAD_RULE } from '../src/main/services/handoff'
import { mentionNote } from '../src/main/services/mentions'
import { kernelTools, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { toUserMessage } from '../src/main/services/providers/claude'
import { toCodexInput } from '../src/main/services/providers/codex/runner'

const kernel = { id: 'kernel', name: 'Kernel', role: 'Lead', lead: true } as AgentDef
const sean = { id: 'sean', name: 'Sean', role: 'Engine', lead: false } as AgentDef
const christian = { id: 'christian', name: 'Christian', role: 'Frontend', lead: false } as AgentDef
const mira = { id: 'mira', name: 'Mira', role: 'Docs helper', lead: false, member: false } as AgentDef
const team = [kernel, sean, christian, mira]
const at = (a: AgentDef): ChatPart => ({ type: 'agent', name: a.name, agentId: a.id })

describe('the text the Lead reads for a message with mentions (KERNEL-745)', () => {
  it('names the one teammate the user addressed', () => {
    expect(mentionNote([at(sean), { type: 'text', text: 'the Stop hook drops reminders' }], team)).toBe('The user addressed this to Sean.')
  })

  it('names both teammates once each, and leaves the Lead itself out', () => {
    expect(mentionNote([at(sean), { type: 'text', text: 'and' }, at(christian), at(sean), at(kernel)], team)).toBe('The user addressed this to Sean and Christian.')
  })

  it("adds a line for a teammate who doesn't take tasks, and for one no longer on the team", () => {
    expect(mentionNote([at(mira), at({ ...sean, id: 'ivo', name: 'Ivo' })], team)).toBe([
      'The user addressed this to Mira and Ivo.',
      "Mira doesn't take tasks in this project, so tell the user or ask with mcp__kernel__ask_user who should take it.",
      "Ivo isn't on this project's team now, so tell the user or ask with mcp__kernel__ask_user who should take it."
    ].join('\n'))
  })

  it('has LEAD_RULE tell the Lead to act for each teammate the user addressed', () => {
    expect(LEAD_RULE).toContain('For each teammate the user addressed, call create_workspace, message_agent to their workspace, or ask_user')
  })

  it('says nothing for a message without mentions, and counts everyone as taking tasks before the team is read', () => {
    expect(mentionNote([{ type: 'text', text: 'hi' }], team)).toBeUndefined()
    expect(mentionNote([at(kernel)], team)).toBeUndefined()
    expect(mentionNote([at(mira)])).toBe('The user addressed this to Mira.')
  })

  it('shows each mention as @name where it sat, on Claude and Codex', () => {
    const parts: ChatPart[] = [at(sean), { type: 'text', text: 'take the hook' }]
    expect((toUserMessage(parts).message.content as { text: string }[]).map((c) => c.text)).toEqual(['@Sean', 'take the hook'])
    expect(toCodexInput(parts)).toEqual([{ type: 'text', text: '@Sean take the hook', text_elements: [] }])
  })
})

describe("the Lead's tools close mentions (KERNEL-745)", () => {
  function tools() {
    const acted = vi.fn()
    const ws = { id: 'ws-christian', name: 'christian-ws', branch: 'feat/x', agentId: 'christian', status: 'ready', prState: 'none' } as Workspace
    const deps = {
      projectId: 'project', lead: kernel, agents: async () => team, workspaces: () => [ws],
      createWorkspace: async () => ({ id: 'ws-sean', branch: 'feat/y', agentId: 'sean' }) as Workspace,
      messageWorkspace: async (id: string) => (id === ws.id ? { ok: true, sent: true, note: 'Sent.' } : { ok: false, sent: false, note: 'Not sent.' }),
      askUser: async () => ({ behavior: 'answer', text: 'Give it to Sean' }), hireAgent: async () => '', archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false,
      planMode: () => true, acted
    } as unknown as KernelToolDeps
    const byName = Object.fromEntries(kernelTools(deps).map((t) => [t.name, t]))
    const run = (name: string, args: object) => byName[name].handler(args as never, {})
    return { acted, run }
  }

  it('create_workspace reports the agent it hands to, message_agent the workspace it reaches, ask_user what it is about (KERNEL-749)', async () => {
    const t = tools()
    await t.run('create_workspace', { agent: 'sean', title: 'Stop hook', brief: 'Goal, files, acceptance criteria' })
    expect(t.acted).toHaveBeenLastCalledWith({ created: 'sean' })
    await t.run('message_agent', { workspace_id: 'ws-christian', text: 'Also the composer' })
    expect(t.acted).toHaveBeenLastCalledWith({ messaged: expect.objectContaining({ id: 'ws-christian', agentId: 'christian' }) })
    await t.run('ask_user', { question: 'Who takes the docs?' })
    expect(t.acted).toHaveBeenLastCalledWith({ asked: [] })
    await t.run('ask_user', { question: 'Per tab?', about: ['ws-christian'] })
    expect(t.acted).toHaveBeenLastCalledWith({ asked: ['ws-christian'] })
    expect(t.acted).toHaveBeenCalledTimes(4)
  })

  it('leaves mentions open when message_agent sends nothing', async () => {
    const t = tools()
    await t.run('message_agent', { workspace_id: 'ws-gone', text: 'Hello' })
    expect(t.acted).not.toHaveBeenCalled()
  })
})
