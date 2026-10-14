import { describe, expect, it, vi } from 'vitest'
import type { AgentDef, ChatPart, Workspace } from '@shared/types'
import { LEAD_RULE } from '../src/main/services/handoff'
import { mentionNote, mentionReminder, Mentions } from '../src/main/services/mentions'
import { kernelTools, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { toUserMessage } from '../src/main/services/providers/claude'
import { toCodexInput } from '../src/main/services/providers/codex/runner'

const kernel = { id: 'kernel', name: 'Kernel', role: 'Lead', lead: true } as AgentDef
const noor = { id: 'noor', name: 'Noor', role: 'Engine', lead: false } as AgentDef
const kai = { id: 'kai', name: 'Kai', role: 'Frontend', lead: false } as AgentDef
const mira = { id: 'mira', name: 'Mira', role: 'Docs helper', lead: false, member: false } as AgentDef
const team = [kernel, noor, kai, mira]
const at = (a: AgentDef): ChatPart => ({ type: 'agent', name: a.name, agentId: a.id })

describe('the text the Lead reads for a message with mentions (KERNEL-745)', () => {
  it('names the one teammate the user addressed', () => {
    expect(mentionNote([at(noor), { type: 'text', text: 'the Stop hook drops reminders' }], team)).toBe('The user addressed this to Noor.')
  })

  it('names both teammates once each, and leaves the Lead itself out', () => {
    expect(mentionNote([at(noor), { type: 'text', text: 'and' }, at(kai), at(noor), at(kernel)], team)).toBe('The user addressed this to Noor and Kai.')
  })

  it("adds a line for a teammate who doesn't take tasks, and for one no longer on the team", () => {
    expect(mentionNote([at(mira), at({ ...noor, id: 'ivo', name: 'Ivo' })], team)).toBe([
      'The user addressed this to Mira and Ivo.',
      "Mira doesn't take tasks in this room, so tell the user or ask with mcp__kernel__ask_user who should take it.",
      "Ivo isn't on this room's team now, so tell the user or ask with mcp__kernel__ask_user who should take it."
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
    const parts: ChatPart[] = [at(noor), { type: 'text', text: 'take the hook' }]
    expect((toUserMessage(parts).message.content as { text: string }[]).map((c) => c.text)).toEqual(['@Noor', 'take the hook'])
    expect(toCodexInput(parts)).toEqual([{ type: 'text', text: '@Noor take the hook', text_elements: [] }])
  })
})

describe('open mentions per Lead chat (KERNEL-745)', () => {
  it('reminds once per open mention, and the Stop after lets the turn end', () => {
    const m = new Mentions()
    expect(m.reminder('chat')).toBeUndefined()
    m.opened('chat', [{ agentId: 'noor', name: 'Noor' }, { agentId: 'kai', name: 'Kai' }])
    expect(m.reminder('chat')).toBe(mentionReminder(['Noor', 'Kai']))
    expect(m.reminder('chat')).toBeUndefined()
    expect(m.open('chat')).toEqual([])
    expect(mentionReminder(['Noor'])).toContain("you haven't acted for that teammate yet")
  })

  it('closes one mention when the Lead acts for that teammate, and every one on ask_user', () => {
    const m = new Mentions()
    m.opened('chat', [{ agentId: 'noor', name: 'Noor' }, { agentId: 'kai', name: 'Kai' }])
    m.acted('chat', 'noor')
    m.acted('chat', 'mira')
    expect(m.reminder('chat')).toBe(mentionReminder(['Kai']))
    m.opened('chat', [{ agentId: 'noor', name: 'Noor' }])
    m.acted('chat')
    expect(m.reminder('chat')).toBeUndefined()
  })

  it('closes every mention when the user stops or redirects, and keeps chats apart', () => {
    const m = new Mentions()
    m.opened('chat', [{ agentId: 'noor', name: 'Noor' }])
    m.opened('other', [{ agentId: 'kai', name: 'Kai' }])
    m.done('chat')
    expect(m.reminder('chat')).toBeUndefined()
    expect(m.reminder('other')).toBe(mentionReminder(['Kai']))
  })
})

describe("the Lead's tools close mentions (KERNEL-745)", () => {
  function tools() {
    const acted = vi.fn()
    const ws = { id: 'ws-kai', name: 'kai-ws', branch: 'feat/x', agentId: 'kai', status: 'ready', prState: 'none' } as Workspace
    const deps = {
      roomId: 'room', lead: kernel, agents: async () => team, workspaces: () => [ws],
      createWorkspace: async () => ({ id: 'ws-noor', branch: 'feat/y', agentId: 'noor' }) as Workspace,
      messageWorkspace: async (id: string) => (id === ws.id ? { ok: true, sent: true, note: 'Sent.' } : { ok: false, sent: false, note: 'Not sent.' }),
      askUser: async () => ({ behavior: 'answer', text: 'Give it to Noor' }), hireAgent: async () => '', archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false,
      planMode: () => true, acted
    } as unknown as KernelToolDeps
    const byName = Object.fromEntries(kernelTools(deps).map((t) => [t.name, t]))
    const run = (name: string, args: object) => byName[name].handler(args as never, {})
    return { acted, run }
  }

  it('create_workspace closes the agent it hands to, message_agent the agent whose workspace it reaches, ask_user them all', async () => {
    const t = tools()
    await t.run('create_workspace', { agent: 'noor', title: 'Stop hook', brief: 'Goal, files, acceptance criteria' })
    expect(t.acted).toHaveBeenLastCalledWith('noor')
    await t.run('message_agent', { workspace_id: 'ws-kai', text: 'Also the composer' })
    expect(t.acted).toHaveBeenLastCalledWith('kai')
    await t.run('ask_user', { question: 'Who takes the docs?' })
    expect(t.acted).toHaveBeenLastCalledWith()
    expect(t.acted).toHaveBeenCalledTimes(3)
  })

  it('leaves mentions open when message_agent sends nothing', async () => {
    const t = tools()
    await t.run('message_agent', { workspace_id: 'ws-gone', text: 'Hello' })
    expect(t.acted).not.toHaveBeenCalled()
  })
})
