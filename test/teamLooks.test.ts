import { describe, expect, it } from 'vitest'
import type { AgentDef } from '../src/shared/types'
import { LOOKS, lookFor, overflowShirt, shirtOrder } from '../src/renderer/src/screens/agent/looks'
import { shirtOf } from '../src/renderer/src/screens/agent/model'

const a = (id: string, lead = false): AgentDef => ({ id, name: id, role: 'Dev', description: '', lead, prompt: '', file: `${id}.md` })

describe('Team shirts follow file order (KERNEL-102)', () => {
  const team = [a('kernel', true), a('kai'), a('noor'), a('ivy')]

  it('wears the look of the agent\'s place in the file', () => {
    // The project's order runs backwards from the file, so a place in it would hand every agent the wrong look.
    const project = { desks: ['ivy', 'noor', 'kai', 'kernel'] }
    team.forEach((x, i) => expect(shirtOf(x, team, project)).toBe(LOOKS[i].shirt))
  })

  it('keeps the shirt when project.desks puts an agent somewhere else', () => {
    const project = { desks: ['kernel', 'ivy', 'kai', 'noor'] }
    // ivy is second in the project's order but fourth in the file.
    expect(shirtOrder(team, project).first[1].id).toBe('ivy')
    expect(shirtOf(team[3], team, project)).toBe(lookFor(team[3], 3).shirt)
    expect(shirtOf(team[3], team, project)).not.toBe(lookFor(team[3], 1).shirt)
  })

  it('counts file order among live agents only', () => {
    const withRetired = [a('kernel', true), { ...a('old'), retired: true }, a('kai')]
    // kai is first in the project's order, and second among the live agents.
    expect(shirtOf(withRetired[2], withRetired, { desks: ['kai', 'kernel'] })).toBe(LOOKS[1].shirt)
  })

  it('uses the agent\'s own look when the file has one', () => {
    const own = { shirt: '#123456', skin: '#abcdef', hair: '#000000' }
    const withLook = [a('kernel', true), { ...a('kai'), look: own }]
    expect(shirtOf(withLook[1], withLook)).toBe(own.shirt)
  })
})

describe('Team gives six agents a look in a project\'s order and the rest an overflow shirt', () => {
  it('puts the lead first and sends agents past the sixth to the overflow, in the overflow shirts', () => {
    const team = [a('kai'), a('kernel', true), ...['b', 'c', 'd', 'e', 'f', 'g'].map((x) => a(x))]
    const { first, overflow } = shirtOrder(team)
    expect(first.map((x) => x.id)).toEqual(['kernel', 'kai', 'b', 'c', 'd', 'e'])
    expect(overflow.map((x) => x.id)).toEqual(['f', 'g'])
    expect(shirtOf(team[6], team)).toBe(overflowShirt(0))
    expect(shirtOf(team[7], team)).toBe(overflowShirt(1))
  })

  it('follows project.desks when it is set', () => {
    const team = [a('kernel', true), a('kai'), a('sol')]
    const { first, overflow } = shirtOrder(team, { desks: ['kernel', 'kai'] })
    expect(first.map((x) => x.id)).toEqual(['kernel', 'kai'])
    expect(overflow.map((x) => x.id)).toEqual(['sol'])
  })

  it('leaves retired agents out', () => {
    const { first, overflow } = shirtOrder([a('kernel', true), { ...a('old'), retired: true }])
    expect(first.map((x) => x.id)).toEqual(['kernel'])
    expect(overflow).toEqual([])
  })
})
