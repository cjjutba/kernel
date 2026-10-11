import { describe, expect, it } from 'vitest'
import { chatGlyph, leadGlyph, workspaceGlyph } from '../src/renderer/src/components/sidebar/workspaceGlyph'
import { chatLine, chatTrusts, chatWaits } from '../src/renderer/src/components/sidebar/chatCard'
import { leadWaiting } from '../src/renderer/src/lead'
import type { Approval, Chat, Workspace } from '../src/shared/types'

const approval = (kind: Approval['kind'], extra: Partial<Approval> = {}): Approval =>
  ({ id: `a-${kind}`, kind, source: 'sdk', title: kind, status: 'pending', createdAt: 0, ...extra })
const plan = approval('plan')
const hookPlan = approval('tool', { id: 'a-hook-plan', toolName: 'ExitPlanMode' })
const bash = approval('tool', { id: 'a-bash', toolName: 'Bash' })
const question = approval('question')

describe('glyphs for pending approvals', () => {
  it('shows the clipboard when only plans wait, whether they arrive as a plan or as ExitPlanMode', () => {
    expect(chatGlyph({ waiting: [plan], running: false })).toEqual({ icon: 'plan', tone: 'needs', label: 'Plan to review' })
    expect(chatGlyph({ waiting: [plan, hookPlan], running: true })).toMatchObject({ icon: 'plan', label: 'Plan to review' })
  })

  it('shows the question mark when a tool or question waits, even next to a plan', () => {
    expect(chatGlyph({ waiting: [plan, bash], running: false })).toEqual({ icon: 'question', tone: 'needs', label: 'Needs you' })
    expect(chatGlyph({ waiting: [question, plan], running: false })).toMatchObject({ icon: 'question', label: 'Needs you' })
  })

  it('shows the clipboard on the Lead row while its status is working, since a team plan never sets needs', () => {
    expect(leadGlyph('working', [plan])).toMatchObject({ icon: 'plan', label: 'Plan to review' })
    expect(leadGlyph('idle', [plan])).toMatchObject({ icon: 'plan' })
    expect(leadGlyph('working', [])).toMatchObject({ icon: 'spin' })
    expect(leadGlyph('needs', [])).toMatchObject({ icon: 'question' })
  })

  it('finds the Lead\'s pending approvals on its workspace, and none without one', () => {
    const other = approval('question', { id: 'a-other', workspaceId: 'ws-other' })
    const mine = approval('plan', { id: 'a-mine', workspaceId: 'ws-lead' })
    const done = approval('plan', { id: 'a-done', workspaceId: 'ws-lead', status: 'allowed' })
    const loose = approval('question', { id: 'a-loose' })
    expect(leadWaiting([other, mine, done, loose], 'ws-lead')).toEqual([mine])
    expect(leadWaiting([other, mine, done, loose], undefined)).toEqual([])
  })
})

describe('glyphs for a workspace held for script trust (KERNEL-342)', () => {
  const held = (status: Workspace['status']): Workspace =>
    ({ id: 'w', roomId: 'r', name: 'w', branch: 'feat/w', baseRef: 'main', path: '/w', mode: 'worktree', agentId: 'kai', port: 1, status, prState: 'none', createdAt: 1 })
  const idle = { waiting: [], running: false }

  it('reads as waiting on you, like an approval', () => {
    expect(workspaceGlyph(held('trust'), idle)).toEqual({ icon: 'question', tone: 'needs', label: 'Trust scripts' })
  })

  it('clears when the status moves on, to setup, then ready', () => {
    expect(workspaceGlyph(held('setup'), idle)).toMatchObject({ icon: 'spin', label: 'Setting up' })
    expect(workspaceGlyph(held('ready'), idle)).toMatchObject({ icon: 'branch', tone: 'muted' })
  })

  it('lets a pending approval name the wait when both are there', () => {
    expect(workspaceGlyph(held('trust'), { waiting: [plan], running: false })).toMatchObject({ icon: 'plan', label: 'Plan to review' })
  })

  it('shows on a folded chat row only while a workspace it hides is held', () => {
    expect(chatGlyph({ ...idle, trust: true })).toEqual({ icon: 'question', tone: 'needs', label: 'Trust scripts' })
    expect(chatGlyph({ ...idle, trust: false })).toMatchObject({ icon: 'chat', tone: 'muted' })
    expect(chatGlyph({ waiting: [bash], running: true, trust: true })).toMatchObject({ label: 'Needs you' })
  })

  it('counts on the chat card as one wait, with a line naming the workspace', () => {
    const tabs = [{ id: 'c1', workspaceId: 'home', title: 'Org invites', kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1 }] as Chat[]
    const owned = [held('trust'), { ...held('ready'), id: 'w2', name: 'w2' }]
    expect(chatTrusts(owned).map((w) => w.id)).toEqual(['w'])
    expect(chatLine(chatWaits({ tabs, owned, approvals: [] }), undefined, chatTrusts(owned))).toBe('w: waiting for you to trust the scripts.')
    expect(chatLine([], undefined, chatTrusts([held('ready')]))).toBe('Nothing is waiting on you.')
  })
})
