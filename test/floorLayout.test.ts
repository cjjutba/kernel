import { describe, expect, it } from 'vitest'
import type { AgentDef } from '../src/shared/types'
import { LOOKS, SEATS, defaultSelected, dayLabel, deskless, limitBanner, lookFor, modelLabel, needsCount, seating } from '../src/renderer/src/floor/layout'

const a = (id: string, lead = false): AgentDef => ({ id, name: id, role: 'Dev', description: '', lead, prompt: '', file: `${id}.md` })

describe('floor layout', () => {
  it('seats the lead first and sends agents past the last desk to the overflow', () => {
    const team = [a('kai'), a('rowan', true), ...['b', 'c', 'd', 'e', 'f'].map((x) => a(x))]
    const { seated, overflow } = seating(team)
    expect(seated[0].id).toBe('rowan')
    expect(seated).toHaveLength(SEATS.length)
    expect(overflow.map((x) => x.id)).toEqual(['f'])
  })

  it('follows room.desks when it is set', () => {
    const team = [a('rowan', true), a('kai'), a('sol')]
    const { seated, overflow } = seating(team, { desks: ['rowan', 'kai'] })
    expect(seated.map((x) => x.id)).toEqual(['rowan', 'kai'])
    expect(overflow.map((x) => x.id)).toEqual(['sol'])
  })

  it('seats the lead first, then agents with a workspace or a status, then the rest by newest activity', () => {
    const team = [a('rowan', true), a('worker'), a('worker-opus'), a('kai'), a('ivy'), a('noor'), a('theo')]
    const workspaces = [{ agentId: 'ivy', status: 'ready' as const }, { agentId: 'kai', status: 'archived' as const }]
    const status = { theo: 'working' as const, noor: 'idle' as const }
    const lastActivity = { noor: 30, worker: 10, kai: 20 }
    const { seated, overflow } = seating(team, {}, { workspaces, status, lastActivity })
    // ivy has an open workspace and theo is working, both in file order. kai's workspace is archived, so he joins the idle agents.
    expect(seated.map((x) => x.id)).toEqual(['rowan', 'ivy', 'theo', 'noor', 'kai', 'worker'])
    expect(overflow.map((x) => x.id)).toEqual(['worker-opus'])
  })

  it('seats Noor and Theo ahead of the Issue Workers when everyone is idle', () => {
    const team = [a('issue-worker'), a('issue-worker-opus'), a('ivy'), a('kai'), a('lumi'), a('noor'), a('rowan', true), a('theo')]
    const lastActivity = { theo: 50, noor: 40, rowan: 60, kai: 30, ivy: 20, 'issue-worker': 1 }
    const { seated, overflow } = seating(team, {}, { lastActivity })
    expect(seated.map((x) => x.id)).toEqual(['rowan', 'theo', 'noor', 'kai', 'ivy', 'issue-worker'])
    expect(overflow.map((x) => x.id)).toEqual(['issue-worker-opus', 'lumi'])
  })

  it('keeps file order for agents with no activity, and for any room that sends none', () => {
    const team = [a('kai'), a('rowan', true), a('noor')]
    expect(seating(team).seated.map((x) => x.id)).toEqual(['rowan', 'kai', 'noor'])
    expect(seating(team, {}, { lastActivity: { noor: 5 } }).seated.map((x) => x.id)).toEqual(['rowan', 'noor', 'kai'])
  })

  it('lets room.desks win over workspaces, status and activity', () => {
    const team = [a('rowan', true), a('kai'), a('noor')]
    const ctx = { workspaces: [{ agentId: 'noor', status: 'ready' as const }], status: { noor: 'working' as const }, lastActivity: { noor: 9 } }
    expect(seating(team, { desks: ['rowan', 'kai', 'noor'] }, ctx).seated.map((x) => x.id)).toEqual(['rowan', 'kai', 'noor'])
  })

  it('gives an agent the same look whichever desk they sit at', () => {
    const team = [a('rowan', true), a('kai'), a('noor')]
    const look = (id: string, seated: AgentDef[]) => lookFor(seated.find((x) => x.id === id)!, team.findIndex((x) => x.id === id))
    const before = seating(team).seated
    const after = seating(team, {}, { status: { noor: 'working' } }).seated
    expect(before.map((x) => x.id)).not.toEqual(after.map((x) => x.id))
    expect(look('noor', after)).toEqual(look('noor', before))
    expect(lookFor(team[2], 2)).toBe(LOOKS[2])
  })

  it('lists only agents who are not idle under No desk yet', () => {
    const team = [a('kai'), a('noor'), a('theo')]
    expect(deskless(team, { kai: 'working', noor: 'idle' }).map((x) => x.id)).toEqual(['kai'])
    expect(deskless(team, { kai: 'needs', noor: 'offline', theo: 'blocked' })).toHaveLength(3)
    expect(deskless(team, {})).toEqual([])
  })

  it('selects nobody by default, the first agent that needs the user, and the clicked agent over both', () => {
    const team = [a('rowan', true), a('ivy'), a('kai')]
    expect(defaultSelected(team, {})).toBeUndefined()
    expect(defaultSelected(team, { ivy: 'idle', kai: 'working', rowan: 'working' })).toBeUndefined()
    expect(defaultSelected(team, { ivy: 'blocked', kai: 'offline' })?.id).toBe('ivy')
    expect(defaultSelected(team, { kai: 'needs' })?.id).toBe('kai')
    expect(defaultSelected(team, { ivy: 'blocked' }, 'rowan')?.id).toBe('rowan')
    // A click on someone who has left the room is ignored.
    expect(defaultSelected(team, {}, 'gone')).toBeUndefined()
  })

  it('counts an agent once when it needs you and has an approval', () => {
    expect(needsCount([a('kai'), a('ivy')], { kai: 'needs' }, [{ agentId: 'kai' }, { agentId: 'ivy' }])).toBe(2)
  })

  it('counts each approval with no agent on its own', () => {
    expect(needsCount([], {}, [{}, {}])).toBe(2)
  })

  it('names models from aliases and ids', () => {
    expect(modelLabel('opus')).toBe('Opus 5.5')
    expect(modelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(modelLabel(undefined)).toBe('')
  })

  it('words the limit banner from the rejected limit and its reset', () => {
    const now = new Date(2026, 9, 7, 11, 0).getTime()
    const monday = new Date(2026, 9, 12, 9, 0).getTime()
    // resetsAt is epoch seconds, as rate_limit_event sends it.
    const S = (ms: number) => ms / 1000
    expect(limitBanner([{ type: 'seven_day', status: 'rejected', resetsAt: S(monday) }], now).text).toBe('Weekly limit reached. Every agent waits until Monday, 9:00 AM.')
    expect(limitBanner([{ type: 'five_hour', status: 'rejected', resetsAt: S(now + 2 * 3600_000) }], now).text).toBe('5-hour limit reached. Every agent waits until 1:00 PM.')
    // Fable's own weekly limit does not pause rooms, so it never words the banner.
    expect(limitBanner([{ type: 'five_hour', status: 'rejected', resetsAt: S(now + 2 * 3600_000) }, { type: 'seven_day_overage_included', status: 'rejected', resetsAt: S(monday) }], now).text).toBe('5-hour limit reached. Every agent waits until 1:00 PM.')
  })

  it('groups log days', () => {
    const now = new Date(2026, 9, 7, 12, 0).getTime()
    expect(dayLabel(now - 3600_000, now)).toBe('Today')
    expect(dayLabel(now - 24 * 3600_000, now)).toBe('Yesterday')
  })
})
