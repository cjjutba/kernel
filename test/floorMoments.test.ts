import { describe, expect, it } from 'vitest'
import type { ActivityEvent, AgentDef, Approval, Overlap } from '../src/shared/types'
import { moments, talkLegs, type MomentInput } from '../src/renderer/src/screens/floor/moments/moments'

const agent = (id: string, role = 'Dev', lead = false): AgentDef => ({ id, name: id[0].toUpperCase() + id.slice(1), role, description: '', lead, prompt: '', file: `${id}.md` } as AgentDef)
const team = [agent('rowan', 'Lead', true), agent('kai', 'Frontend'), agent('noor', 'Backend')]
const ev = (id: string, ts: number, e: Partial<ActivityEvent>): ActivityEvent => ({ id, ts, roomId: 'r', kind: 'note', text: '', ...e })
const input = (p: Partial<MomentInput> = {}): MomentInput => ({ agents: team, status: {}, approvals: [], activity: [], overlaps: [], stage: 'working', now: 1_000_000, ...p })
const question: Approval = { id: 'q', kind: 'question', source: 'sdk', roomId: 'r', agentId: 'rowan', title: 'Invoices only?', options: ['Yes'], status: 'pending', createdAt: 500 }
const overlap: Overlap = { id: 'o', roomId: 'r', path: 'src/invoices.ts', ts: 1, parties: [{ agentId: 'kai', workspaceId: 'a', lines: 'lines 1-2' }, { agentId: 'noor', workspaceId: 'b', lines: 'line 4' }] }

describe('floor moments', () => {
  it('shows a pending question with the agent\'s own line, and drops it once answered', () => {
    const m = moments(input({ approvals: [question], activity: [ev('s', 490, { kind: 'agent.say', agentId: 'rowan', text: 'Quick question.' })] }))
    expect(m.question?.id).toBe('q')
    expect(m.say).toEqual({ agentId: 'rowan', text: 'Quick question.' })
    expect(moments(input({ approvals: [{ ...question, status: 'allowed' }] })).question).toBeUndefined()
  })

  it('flags an overlap through the Lead and leaves handed-over ones off the floor', () => {
    expect(moments(input({ overlaps: [overlap] })).say).toEqual({ agentId: 'rowan', text: 'Kai and Noor are both in invoices.ts.' })
    expect(moments(input({ overlaps: [{ ...overlap, resolved: true }] })).overlaps).toEqual([])
  })

  it('has the speaker stand at the listener while the talk is live, then go home', () => {
    const talk = ev('t', 900, { kind: 'agent.talk', agentId: 'rowan', data: { from: 'rowan', to: 'kai', line: 'Kai, T-15b is yours.' } })
    const live = moments(input({ activity: [talk], status: { kai: 'working' } }))
    expect(live.say).toEqual({ agentId: 'rowan', text: 'Kai, T-15b is yours.' })
    const spot = (id: string) => (id === 'kai' ? ('kai' as const) : undefined)
    expect(talkLegs(live.talks, 'rowan', spot, 'seat')).toEqual([{ key: 'talk:t', to: 'kai' }])
    const done = moments(input({ activity: [talk, ev('d', 950, { kind: 'turn.done', agentId: 'kai' })], status: { kai: 'idle' } }))
    expect(done.say).toBeUndefined()
    expect(talkLegs(done.talks, 'rowan', spot, 'seat')).toEqual([{ key: 'talk:t', to: 'kai' }, { key: 'talk:t:end', to: 'seat' }])
  })

  it('shows a chat with CJ unless the Lead is on a brief', () => {
    const chat = ev('c', 900, { kind: 'prompt', actor: 'you', agentId: 'rowan', workspaceId: 'w', object: 'plan' })
    const m = moments(input({ activity: [chat], status: { rowan: 'working' } }))
    expect(m.chatting).toBe('rowan')
    expect(m.say?.link).toEqual({ label: 'Open chat', workspaceId: 'w' })
    expect(moments(input({ activity: [chat], status: { rowan: 'working' }, stage: 'planning' })).chatting).toBeUndefined()
    expect(moments(input({ activity: [chat], status: { rowan: 'idle' } })).chatting).toBeUndefined()
  })

  it('walks a new hire in from the door only while the arrival is fresh', () => {
    const joined = ev('j', 995_000, { kind: 'agent.joined', agentId: 'kai' })
    expect(moments(input({ activity: [joined] })).hire).toEqual({ agentId: 'kai', eventId: 'j', fresh: true })
    expect(moments(input({ activity: [joined], now: 1_030_000 })).hire?.fresh).toBe(false)
    expect(moments(input({ activity: [joined], now: 5_000_000 })).hire).toBeUndefined()
  })
})
