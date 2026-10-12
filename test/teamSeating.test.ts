import { describe, expect, it } from 'vitest'
import type { AgentDef } from '../src/shared/types'
import { LOOKS, lookFor, overflowShirt, seating } from '../src/renderer/src/screens/team/looks'
import { shirtOf } from '../src/renderer/src/screens/team/model'

const a = (id: string, lead = false): AgentDef => ({ id, name: id, role: 'Dev', description: '', lead, prompt: '', file: `${id}.md` })

describe('Team shirts follow file order (KERNEL-102)', () => {
  const team = [a('rowan', true), a('kai'), a('noor'), a('ivy')]

  it('wears the look of the agent\'s place in the file', () => {
    // The room's order runs backwards from the file, so a place in it would hand every agent the wrong look.
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

describe('Team puts six agents in a room\'s order and the rest in the overflow', () => {
  it('puts the lead first and sends agents past the sixth to the overflow, in the overflow shirts', () => {
    const team = [a('kai'), a('rowan', true), ...['b', 'c', 'd', 'e', 'f', 'g'].map((x) => a(x))]
    const { seated, overflow } = seating(team)
    expect(seated.map((x) => x.id)).toEqual(['rowan', 'kai', 'b', 'c', 'd', 'e'])
    expect(overflow.map((x) => x.id)).toEqual(['f', 'g'])
    expect(shirtOf(team[6], team)).toBe(overflowShirt(0))
    expect(shirtOf(team[7], team)).toBe(overflowShirt(1))
  })

  it('follows room.desks when it is set', () => {
    const team = [a('rowan', true), a('kai'), a('sol')]
    const { seated, overflow } = seating(team, { desks: ['rowan', 'kai'] })
    expect(seated.map((x) => x.id)).toEqual(['rowan', 'kai'])
    expect(overflow.map((x) => x.id)).toEqual(['sol'])
  })

  it('leaves retired agents out', () => {
    const { seated, overflow } = seating([a('rowan', true), { ...a('old'), retired: true }])
    expect(seated.map((x) => x.id)).toEqual(['rowan'])
    expect(overflow).toEqual([])
  })
})
