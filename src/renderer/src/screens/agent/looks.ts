import type { AgentDef, AgentLook, Room } from '@shared/types'

/** How people look when an agent file has no `look`. Taken in file order, so a person keeps their look when the room's order changes. */
export const LOOKS: AgentLook[] = [
  { shirt: '#3f4652', skin: '#d8b896', hair: '#2b2420' }, { shirt: '#5b6b5e', skin: '#c99b74', hair: '#1f1a17' },
  { shirt: '#6b5d73', skin: '#8d6346', hair: '#141212' }, { shirt: '#7a6a55', skin: '#e0c2a2', hair: '#5a4636' },
  { shirt: '#4b5560', skin: '#b07f5c', hair: '#2a2422' }, { shirt: '#5f6f7a', skin: '#c9a27e', hair: '#3a2c22' }
]

/** Shirts for agents past the sixth in a room's order. */
const OVERFLOW_SHIRTS = ['#5a6370', '#6d6a5c', '#4f6068', '#645a6e']

/** How many agents, in a room's order, wear a look. The rest wear an overflow shirt. */
const WITH_LOOK = 6

export interface ShirtOrder {
  /** The first six in the room's order, lead first. */
  first: AgentDef[]
  /** Everyone after them, or not listed in `room.desks`. */
  overflow: AgentDef[]
}

/**
 * The room's order of live agents. `room.desks` lists agent ids in order and anyone not listed comes after the sixth. Without it the order
 * is the file's. The lead always goes first.
 */
export function shirtOrder(agents: AgentDef[], room?: Pick<Room, 'desks'>): ShirtOrder {
  const live = agents.filter((a) => !a.retired)
  const lead = live.find((a) => a.lead)
  const ordered = room?.desks ? room.desks.map((id) => live.find((a) => a.id === id)).filter((a): a is AgentDef => !!a) : live
  const queue = lead && ordered.includes(lead) ? [lead, ...ordered.filter((a) => a !== lead)] : ordered
  const first = queue.slice(0, WITH_LOOK)
  return { first, overflow: live.filter((a) => !first.includes(a)) }
}

/** How an agent looks: their file's `look`, else one by their place in the file (`order`), so a person keeps their look when the room's order changes. */
export const lookFor = (agent: AgentDef, order: number): AgentLook => agent.look ?? LOOKS[order % LOOKS.length]
export const overflowShirt = (i: number) => OVERFLOW_SHIRTS[i % OVERFLOW_SHIRTS.length]
