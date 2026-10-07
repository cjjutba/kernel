import { describe, expect, it } from 'vitest'
import type { ActivityEvent, AgentDef, Approval, Workspace } from '../src/shared/types'
import { fixtures } from '../fixtures'
import { sequence, reviewCard, type SequenceInput } from '../src/renderer/src/screens/floor/sequence'
import { EDGES } from '../src/renderer/src/screens/floor/motion/waypoints'
import { plan, route, settle, start, step, track, type Track } from '../src/renderer/src/screens/floor/motion/walks'

const agent = (id: string, role = 'Dev', lead = false): AgentDef => ({ id, name: id[0].toUpperCase() + id.slice(1), role, description: '', lead, prompt: '', file: `${id}.md` } as AgentDef)
const team = [agent('rowan', 'Lead', true), agent('kai', 'Frontend'), agent('noor', 'Backend'), agent('ivy', 'QA'), agent('theo', 'Reviewer')]
const ev = (id: string, ts: number, e: Partial<ActivityEvent>): ActivityEvent => ({ id, ts, roomId: 'r', kind: 'note', text: '', ...e })
const ws = (id: string, agentId: string, extra: Partial<Workspace> = {}): Workspace => ({
  id, roomId: 'r', name: id, branch: id, baseRef: 'main', path: `/tmp/${id}`, mode: 'worktree', agentId, port: 4000, status: 'ready', prState: 'none', createdAt: 0, ...extra
})
const planApproval = (status: Approval['status'], createdAt: number): Approval => ({ id: 'p', kind: 'plan', source: 'sdk', roomId: 'r', agentId: 'rowan', title: 'T-15', status, createdAt })
const brief = ev('brief', 100, { kind: 'brief', actor: 'you', agentId: 'rowan', workspaceId: 'lead', quote: 'Add PDF export' })
const handoff = (id: string, ts: number, assignee: string) => ev(id, ts, { kind: 'workspace.created', agentId: 'rowan', data: { assignee } })

const input = (patch: Partial<SequenceInput>): SequenceInput => ({
  room: { id: 'r' }, agents: team, status: {}, approvals: [], activity: [], workspaces: [ws('lead', 'rowan', { mode: 'current' })], ...patch
})

describe('briefing sequence', () => {
  it('is sent as soon as the Lead takes a brief, and planning once it acts on it in plan mode', () => {
    const sent = sequence(input({ status: { rowan: 'planning' }, activity: [ev('say', 101, { kind: 'agent.say', agentId: 'rowan', text: 'Got it.' }), brief] }))
    expect(sent.stage).toBe('sent')
    expect(sent.say?.text).toBe('Got it.')
    expect(sent.legs).toEqual([{ key: 'seat', to: 'seat' }])

    const planning = sequence(input({ status: { rowan: 'planning' }, activity: [ev('read', 102, { kind: 'tool.end', workspaceId: 'lead' }), brief] }))
    expect(planning.stage).toBe('planning')
    expect(planning.legs).toEqual([{ key: 'wall:brief', to: 'wall' }])
  })

  it('ignores a message to one agent and a brief the Lead is not running on', () => {
    const toKai = ev('m', 100, { kind: 'brief', actor: 'you', agentId: 'kai' })
    expect(sequence(input({ status: { rowan: 'planning' }, activity: [toKai] })).stage).toBe('working')
    expect(sequence(input({ status: { rowan: 'idle' }, activity: [brief] })).stage).toBe('idle')
  })

  it('shows the plan while its approval is pending, with the Lead back at the desk', () => {
    const s = sequence(input({ status: { rowan: 'needs' }, approvals: [planApproval('pending', 200)], activity: [brief] }))
    expect(s.stage).toBe('plan')
    expect(s.legs).toEqual([{ key: 'seat', to: 'seat' }])
    expect(s.say).toBeUndefined()
  })

  it('goes back to planning at the wall when CJ requests changes on the plan', () => {
    const denied = planApproval('denied', 200)
    const waiting = sequence(input({ status: { rowan: 'planning' }, approvals: [denied], activity: [brief] }))
    expect(waiting.stage).toBe('sent')
    const revising = sequence(input({
      status: { rowan: 'planning' }, approvals: [denied],
      activity: [ev('say', 260, { kind: 'agent.say', agentId: 'rowan', text: 'Revising the plan.' }), ev('read', 250, { kind: 'tool.end', workspaceId: 'lead' }), brief]
    }))
    expect(revising.stage).toBe('planning')
    expect(revising.legs).toEqual([{ key: 'wall:plan:p', to: 'wall' }])
    expect(revising.say?.text).toBe('Revising the plan.')
    // The first round's wall walk is a different leg, so the Lead walks to the wall again after sitting down for the plan.
    expect(sequence(input({ status: { rowan: 'planning' }, activity: [ev('read', 102, { kind: 'tool.end', workspaceId: 'lead' }), brief] })).legs[0].key).not.toBe(revising.legs[0].key)
  })

  it('walks the Lead to each assignee in the order create_workspace ran, and follows the newest one', () => {
    const activity = [ev('say', 320, { kind: 'agent.say', agentId: 'rowan', text: 'Kai, T-15b is yours.' }), handoff('h2', 310, 'kai'), handoff('h1', 300, 'noor'), brief]
    const s = sequence(input({ status: { rowan: 'working', noor: 'working', kai: 'planning' }, approvals: [planApproval('allowed', 200)], activity }))
    expect(s.stage).toBe('handoff')
    expect(s.legs).toEqual([{ key: 'h1', to: 'noor' }, { key: 'h2', to: 'kai' }])
    expect(s.focus).toBe('kai')
    expect(s.say?.text).toBe('Kai, T-15b is yours.')
  })

  it('sends the Lead back to the desk once the hand-off turn ends, and the card follows the first assignee', () => {
    const activity = [handoff('h2', 310, 'kai'), handoff('h1', 300, 'noor')]
    const s = sequence(input({ status: { rowan: 'idle', noor: 'working', kai: 'working' }, approvals: [planApproval('allowed', 200)], activity }))
    expect(s.stage).toBe('working')
    expect(s.legs).toEqual([{ key: 'seat', to: 'seat' }])
    expect(s.focus).toBe('noor')
  })

  it('needs you on any pending approval, and review when PRs are ready', () => {
    const perm: Approval = { id: 'a', kind: 'tool', source: 'sdk', roomId: 'r', agentId: 'noor', title: 'Run', status: 'pending', createdAt: 400 }
    expect(sequence(input({ status: { noor: 'needs' }, approvals: [perm] })).stage).toBe('needs')
    const ready = sequence(input({ status: { theo: 'working' }, workspaces: [ws('a', 'noor', { prState: 'ready', prNumber: 43 })] }))
    expect(ready.stage).toBe('review')
    expect(ready.review).toEqual({ title: 'PR #43 is ready to merge', sub: 'The PR has green checks and no changes requested.' })
  })

  it('lets a fixture force the stage', () => {
    expect(sequence(input({ forced: 'planning' })).legs).toEqual([{ key: 'wall:stage', to: 'wall' }])
    expect(sequence(input({ forced: 'nonsense' })).stage).toBe('idle')
  })

  it('words the review card from the split task and the reviewer the plan named', () => {
    const ready = ['a', 'b', 'c', 'd'].map((x, i) => ws(x, team[i + 1].id, { prState: 'ready' }))
    const tasks = ready.map((w, i) => ({ id: `T-15${w.id}`, roomId: 'r', title: '', column: 'review' as const, state: 'idle' as const, agentId: team[i + 1].id, workspaceId: w.id, parentId: 'T-15', steps: [], createdAt: 0, updatedAt: 0 }))
    expect(reviewCard(ready, tasks, team)).toEqual({ title: 'T-15 is ready to merge', sub: 'Four PRs passed Theo’s review and every check is green.' })
    expect(reviewCard(ready.slice(0, 2), [], team)).toEqual({ title: '2 PRs are ready to merge', sub: 'Two PRs have green checks and no changes requested.' })
  })

  // The seven briefing PNGs: each fixture forces its canvas stage, and its own events derive the same stage without the force.
  it.each([
    ['FloorSent', 'sent'], ['FloorPlanning', 'planning'], ['FloorPlan', 'plan'], ['FloorHandoff', 'handoff'],
    ['FloorWorking', 'working'], ['FloorNeeds', 'needs'], ['FloorReview', 'review']
  ])('%s is stage %s, forced and derived', (name, stage) => {
    const f = fixtures[name]
    expect(f.ui.stage).toBe(stage)
    const tasks = f.push.flatMap((e) => (e.type === 'task' ? [e.task] : []))
    const from = (forced?: string) => sequence({ room: f.rooms[0], agents: f.agents['room-a'], status: f.status['room-a'], approvals: f.approvals, activity: f.activity, workspaces: f.workspaces, tasks, forced })
    expect(from().stage).toBe(stage)
    expect(from(stage)).toEqual(from())
  })

  it('puts Rowan at the task wall while planning and at Kai’s desk mid hand-off', () => {
    const last = (name: string) => {
      const f = fixtures[name]
      const legs = sequence({ room: f.rooms[0], agents: f.agents['room-a'], status: f.status['room-a'], approvals: f.approvals, activity: f.activity, workspaces: f.workspaces, forced: f.ui.stage }).legs
      return legs[legs.length - 1].to
    }
    expect(last('FloorPlanning')).toBe('wall')
    expect(last('FloorHandoff')).toBe('kai')
    expect(last('FloorPlan')).toBe('seat')
  })
})

describe('walking', () => {
  it('routes along the canvas waypoints, standing up beside the desk and sitting down at the end', () => {
    expect(route('seat', 'wall', 'stand')).toEqual(['stand', 'back', 'wall'])
    expect(route('wall', 'seat', 'stand')).toEqual(['back', 'stand', 'seat'])
    expect(route('seat', 'noor', 'stand')).toEqual(['stand', 'top', 'r1', 'noor'])
    expect(route('noor', 'kai', 'stand')).toEqual(['kai'])
    expect(route('seat', 'seat', 'stand')).toEqual([])
  })

  it('queues legs that arrive together, so every step moves to a neighbouring waypoint', () => {
    let t: Track = track('seat', ['seat'])
    t = plan(t, [{ key: 'h1', to: 'noor' }], 'stand')
    t = plan(t, [{ key: 'h1', to: 'noor' }, { key: 'h2', to: 'kai' }, { key: 'h3', to: 'theo' }], 'stand')
    t = plan(t, [{ key: 'seat', to: 'seat' }], 'stand')
    expect(t.dest).toBe('seat')
    const visited: string[] = [t.at]
    while (t.queue.length) { t = step(t); visited.push(t.at) }
    expect(visited.slice(0, 5)).toEqual(['seat', 'stand', 'top', 'r1', 'noor'])
    expect(visited).toContain('kai')
    expect(visited.indexOf('kai')).toBeLessThan(visited.indexOf('theo'))
    expect(visited[visited.length - 1]).toBe('seat')
    // No teleporting: between waypoints, each step is one edge.
    const walked = visited.slice(1, -1)
    const edge = (a: string, b: string) => EDGES.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
    for (let i = 1; i < walked.length; i++) expect(edge(walked[i - 1], walked[i]), `${walked[i - 1]} to ${walked[i]}`).toBe(true)
  })

  it('never walks the same event twice', () => {
    const once = plan(track('seat'), [{ key: 'h1', to: 'noor' }], 'stand')
    const twice = plan(settle(once), [{ key: 'h1', to: 'noor' }], 'stand')
    expect(twice.queue).toEqual([])
    expect(twice.at).toBe('noor')
  })

  it('starts where the legs end, and settles straight to the end of the queue', () => {
    expect(start([{ key: 'w', to: 'wall' }]).at).toBe('wall')
    expect(start([]).at).toBe('seat')
    const t = plan(track('seat'), [{ key: 'w', to: 'wall' }], 'stand')
    expect(settle(t)).toMatchObject({ at: 'wall', queue: [] })
  })
})
