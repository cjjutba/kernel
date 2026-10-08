import { describe, expect, it } from 'vitest'
import type { AgentDef } from '../src/shared/types'
import { LOOKS, lookFor, seating } from '../src/renderer/src/floor/layout'
import { roomSeating } from '../src/renderer/src/floor/useSeating'
import { shirtOf } from '../src/renderer/src/screens/team/model'

const a = (id: string, lead = false): AgentDef => ({ id, name: id, role: 'Dev', description: '', lead, prompt: '', file: `${id}.md` })

describe('Team shirts follow file order (KERNEL-102)', () => {
  const team = [a('rowan', true), a('kai'), a('noor'), a('ivy')]

  it('wears the look of the agent\'s place in the file, as the floor does', () => {
    // Desks run backwards from the file, so a seat index would hand every agent the wrong look.
    const room = { desks: ['ivy', 'noor', 'kai', 'rowan'] }
    team.forEach((x, i) => expect(shirtOf(x, team, room)).toBe(LOOKS[i].shirt))
  })

  it('keeps the shirt when room.desks seats an agent somewhere else', () => {
    const room = { desks: ['rowan', 'ivy', 'kai', 'noor'] }
    // ivy sits second but is fourth in the file.
    expect(seating(team, room).seated[1].id).toBe('ivy')
    expect(shirtOf(team[3], team, room)).toBe(lookFor(team[3], 3).shirt)
    expect(shirtOf(team[3], team, room)).not.toBe(lookFor(team[3], 1).shirt)
  })

  it('counts file order among live agents only', () => {
    const withRetired = [a('rowan', true), { ...a('old'), retired: true }, a('kai')]
    // kai sits first, and is second among the live agents.
    expect(shirtOf(withRetired[2], withRetired, { desks: ['kai', 'rowan'] })).toBe(LOOKS[1].shirt)
  })

  it('uses the agent\'s own look when the file has one', () => {
    const own = { shirt: '#123456', skin: '#abcdef', hair: '#000000' }
    const withLook = [a('rowan', true), { ...a('kai'), look: own }]
    expect(shirtOf(withLook[1], withLook)).toBe(own.shirt)
  })
})

describe('New agent and the floor agree on desks (KERNEL-102)', () => {
  // Nine agents so three have no desk, and the context decides which three.
  const ids = ['rowan', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const team = ids.map((id) => a(id, id === 'rowan'))
  const deskOf = (seats: ReturnType<typeof roomSeating>, id: string) => seats.seated.some((x) => x.id === id)

  it('takes the same workspaces, status and activity, so the answers match for a late joiner', () => {
    const ctx = {
      workspaces: [{ agentId: 'h', status: 'ready' as const }],
      status: { g: 'working' as const },
      activity: [{ agentId: 'f', ts: 50 }, { agentId: 'e', ts: 40 }]
    }
    const floor = roomSeating(team, undefined, ctx)
    // Without the context h and g would have no desk. With it they do, and the floor and New agent say so alike.
    expect(deskOf(roomSeating(team, undefined, {}), 'h')).toBe(false)
    expect(deskOf(floor, 'h')).toBe(true)
    expect(deskOf(floor, 'g')).toBe(true)
    expect(floor).toEqual(seating(team, { desks: undefined }, ctx))
  })

  it('follows room.desks the same way', () => {
    const room = { desks: ['rowan', 'h'] }
    const seats = roomSeating(team, room, { status: { g: 'working' } })
    expect(seats.seated.map((x) => x.id)).toEqual(['rowan', 'h'])
    expect(deskOf(seats, 'g')).toBe(false)
  })

  it('leaves retired agents out of the desks', () => {
    const seats = roomSeating([a('rowan', true), { ...a('old'), retired: true }], undefined, {})
    expect(seats.seated.map((x) => x.id)).toEqual(['rowan'])
  })
})
