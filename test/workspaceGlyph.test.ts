import { describe, expect, it } from 'vitest'
import { chatGlyph, leadGlyph } from '../src/renderer/src/components/sidebar/workspaceGlyph'
import type { Approval } from '../src/shared/types'

const approval = (kind: Approval['kind'], extra: Partial<Approval> = {}): Approval =>
  ({ id: `a-${kind}`, kind, source: 'sdk', title: kind, status: 'pending', createdAt: 0, ...extra })
const plan = approval('plan')
const hookPlan = approval('tool', { id: 'a-hook-plan', toolName: 'ExitPlanMode' })
const bash = approval('tool', { id: 'a-bash', toolName: 'Bash' })
const question = approval('question')

describe('glyphs for pending approvals', () => {
  it('shows the clipboard when only plans wait, whether they arrive as a plan or as ExitPlanMode', () => {
    expect(chatGlyph({ waiting: [plan], running: false })).toEqual({ icon: 'plan', tone: 'ink', label: 'Plan to review' })
    expect(chatGlyph({ waiting: [plan, hookPlan], running: true })).toMatchObject({ icon: 'plan', label: 'Plan to review' })
  })

  it('shows the question mark when a tool or question waits, even next to a plan', () => {
    expect(chatGlyph({ waiting: [plan, bash], running: false })).toEqual({ icon: 'question', tone: 'ink', label: 'Needs you' })
    expect(chatGlyph({ waiting: [question, plan], running: false })).toMatchObject({ icon: 'question', label: 'Needs you' })
  })

  it('shows the clipboard on the Lead row while its status is working, since a team plan never sets needs', () => {
    expect(leadGlyph('working', [plan])).toMatchObject({ icon: 'plan', label: 'Plan to review' })
    expect(leadGlyph('idle', [plan])).toMatchObject({ icon: 'plan' })
    expect(leadGlyph('working', [])).toMatchObject({ icon: 'spin' })
    expect(leadGlyph('needs', [])).toMatchObject({ icon: 'question' })
  })
})
