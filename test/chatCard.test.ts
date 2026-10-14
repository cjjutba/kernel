import { describe, expect, it } from 'vitest'
import { chatLine, chatSince, waitLine } from '../src/renderer/src/components/sidebar/chatCard'
import { chatWaits } from '../src/renderer/src/components/sidebar/chatWaits'
import type { AgentDef, Approval, Chat, Workspace } from '../src/shared/types'

const tab = (id: string, title: string): Chat => ({ id, workspaceId: 'lead', title, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1 })
const ws = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, roomId: 'r1', name: id, branch: id, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 0, status: 'ready', prState: 'none', createdAt: 1, ...over }) as Workspace
const ask = (id: string, over: Partial<Approval>): Approval => ({ id, kind: 'question', source: 'sdk', title: '', status: 'pending', createdAt: 100, ...over })
const agent = (id: string, name: string, lead = false): AgentDef => ({ id, name, role: lead ? 'Lead' : 'Dev', description: '', model: 'opus', lead, prompt: '', file: `.claude/agents/${id}.md` })
const agents = [agent('kernel', 'Kernel', true), agent('noor', 'Noor')]
const tabs = [tab('c1', 'Client portal login'), tab('c2', 'Fix the login redirect')]
const owned = [ws('invoice-table', { title: 'Invoice table', agentId: 'noor' })]

describe('chat hover card (KERNEL-339)', () => {
  it('names the agent who is waiting, not the Lead, through the lookup the card uses', () => {
    // The approval of a workspace's agent may carry no agent of its own, so the workspace's agent is used.
    const bare = ask('b', { kind: 'tool', toolName: 'Bash', workspaceId: 'invoice-table' })
    expect(chatLine(chatWaits({ tabs, owned, approvals: [bare] }), agents)).toBe('Invoice table: Noor wants to run a command')
    expect(chatLine(chatWaits({ tabs, owned, approvals: [{ ...bare, agentId: 'kernel' }] }), agents)).toBe('Invoice table: Kernel wants to run a command')
    // A permission in one of the Lead's own tabs is the Lead's.
    expect(chatLine(chatWaits({ tabs, owned, approvals: [ask('t', { kind: 'tool', toolName: 'Bash', chatId: 'c1', agentId: 'kernel' })] }), agents)).toBe('Client portal login: Kernel wants to run a command')
    // An agent the room doesn't list, or no agents loaded yet, reads as the Lead.
    expect(chatLine(chatWaits({ tabs, owned, approvals: [{ ...bare, agentId: 'gone' }] }), agents)).toBe('Invoice table: Kernel wants to run a command')
    expect(chatLine(chatWaits({ tabs, owned, approvals: [bare] }), undefined)).toBe('Invoice table: The Lead wants to run a command')
    expect(chatLine([], agents)).toBe('Nothing is waiting on you.')
  })

  it('names the tab that asks and what it asks', () => {
    const waits = chatWaits({ tabs, owned, approvals: [ask('a1', { chatId: 'c2', title: 'Should we keep Google sign in?' })] })
    expect(waitLine(waits[0], 'Kernel')).toBe('Fix the login redirect asks whether to keep Google sign in.')
    expect(waitLine({ ...waits[0], approval: ask('a2', { title: 'Which tests cover the fonts?' }) }, 'Kernel')).toBe('Fix the login redirect asks which tests cover the fonts.')
  })

  it('uses the line the app already shows for a plan and a permission, with the tab or workspace name in front', () => {
    const [plan] = chatWaits({ tabs, owned, approvals: [ask('p', { kind: 'plan', chatId: 'c1', title: 'Plan for T-15' })] })
    expect(waitLine(plan, 'Kernel')).toBe('Client portal login: Plan for T-15 is ready')
    const [bash] = chatWaits({ tabs, owned, approvals: [ask('b', { kind: 'tool', toolName: 'Bash', workspaceId: 'invoice-table' })] })
    expect(waitLine(bash, 'Noor')).toBe('Invoice table: Noor wants to run a command')
  })

  it('counts a workspace the chat started, and shows the one that has waited longest', () => {
    const approvals = [
      ask('late', { chatId: 'c1', title: 'Late?', createdAt: 300 }), ask('early', { kind: 'tool', toolName: 'Bash', workspaceId: 'invoice-table', createdAt: 200 }),
      ask('other', { chatId: 'elsewhere', createdAt: 50 }), ask('done', { chatId: 'c1', status: 'answered', createdAt: 10 })
    ]
    const waits = chatWaits({ tabs, owned, approvals })
    expect(waits.map((w) => w.approval.id)).toEqual(['early', 'late'])
    expect(new Set(waits.map((w) => w.key)).size).toBe(2)
    expect(chatSince(waits, 999, 1)).toBe(200)
  })

  it('dates the card from the longest wait, else the last activity, else the start', () => {
    expect(chatSince([], 500, 1)).toBe(500)
    expect(chatSince([], 0, 7)).toBe(7)
  })
})
