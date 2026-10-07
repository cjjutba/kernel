import { describe, expect, it } from 'vitest'
import type { AgentDef } from '../src/shared/types'
import { SEATS, defaultSelected, dayLabel, limitBanner, modelLabel, needsCount, seating } from '../src/renderer/src/floor/layout'

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

  it('shows the agent that needs CJ before the lead, and a click beats both', () => {
    const team = [a('rowan', true), a('ivy')]
    expect(defaultSelected(team, { ivy: 'blocked' })?.id).toBe('ivy')
    expect(defaultSelected(team, { ivy: 'idle' })?.id).toBe('rowan')
    expect(defaultSelected(team, { ivy: 'blocked' }, 'rowan')?.id).toBe('rowan')
  })

  it('counts an agent once when it needs you and has an approval', () => {
    expect(needsCount([a('kai'), a('ivy')], { kai: 'needs' }, [{ agentId: 'kai' }, { agentId: 'ivy' }])).toBe(2)
  })

  it('names models from aliases and ids', () => {
    expect(modelLabel('opus')).toBe('Opus 5.5')
    expect(modelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(modelLabel(undefined)).toBe('')
  })

  it('words the limit banner from the rejected limit and its reset', () => {
    const now = new Date(2026, 9, 7, 11, 0).getTime()
    const monday = new Date(2026, 9, 12, 9, 0).getTime()
    expect(limitBanner([{ type: 'seven_day', status: 'rejected', resetsAt: monday }], now).text).toBe('Weekly limit reached. Every agent waits until Monday, 9:00 AM.')
    expect(limitBanner([{ type: 'five_hour', status: 'rejected', resetsAt: now + 2 * 3600_000 }], now).text).toBe('5-hour limit reached. Every agent waits until 1:00 PM.')
  })

  it('groups log days', () => {
    const now = new Date(2026, 9, 7, 12, 0).getTime()
    expect(dayLabel(now - 3600_000, now)).toBe('Today')
    expect(dayLabel(now - 24 * 3600_000, now)).toBe('Yesterday')
  })
})
