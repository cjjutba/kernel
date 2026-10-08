import type { ActivityEvent, AgentDef, AgentStatus, Approval, Overlap } from '@shared/types'
import { seating } from '../../../floor/layout'
import { DESK_SPOTS } from '../motion/waypoints'
import type { Leg, Spot } from '../motion/walks'

// The floor moments (KERNEL-24): an agent's question, agents talking, two agents in the same file, a new hire.
// Everything is read from the store, like the briefing sequence: approvals, activity events, overlaps and agent statuses.

/** A line said out loud over someone's head, with an optional link under it (FloorTalk.png). */
export interface Say { agentId: string; text: string; link?: { label: string; workspaceId: string } }

/** One agent talking to another: Rowan's `message_agent`, or a subagent delegation. */
export interface Talk {
  id: string
  from: string
  to: string
  line: string
  /** The listener is still working on it. The speaker stays at their desk until it ends. */
  live: boolean
}

export interface MomentInput {
  /** Agents in the room, retired ones left out. */
  agents: AgentDef[]
  status: Record<string, AgentStatus>
  approvals: Approval[]
  activity: ActivityEvent[]
  overlaps: Overlap[]
  /** The briefing stage from `sequence`, so a chat is not confused with a brief the Lead is planning. */
  stage: string
  /** `ui.stage`: a fixture forcing one moment. */
  forced?: string
  room?: { desks?: string[] }
  now: number
}

export interface Moments {
  /** The newest question waiting on the user. The floor card and the raised hand both read it. */
  question?: Approval
  /** Overlaps still on the floor, newest first. */
  overlaps: Overlap[]
  talks: Talk[]
  say?: Say
  /** Who the user is chatting with in a workspace right now. */
  chatting?: string
  /** A new agent walking in. `fresh` is true while the arrival is happening now, so the walk starts at the door. */
  hire?: { agentId: string; eventId: string; fresh: boolean }
  /** Who the agent card follows when nobody was clicked and nobody needs the user. */
  focus?: string
}

/** A hire walks in when the engine logs it (the agent file appeared) and for this long after. Older ones are already at their desks. */
export const HIRE_FRESH_MS = 20_000
export const HIRE_KEEP_MS = 120_000
const BUSY: AgentStatus[] = ['working', 'planning']
const BRIEFING = ['sent', 'planning', 'plan', 'handoff']

export const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** "Kai", "Kai and Noor", "Kai, Noor and Ivy". */
export const names = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`)
export const fileName = (path: string) => path.split('/').pop() ?? path

/** The newest `agent.joined` for someone on the floor. The hire timer in Floor and `moments` both read the hire from here. */
export function newestJoin(activity: ActivityEvent[], agents: AgentDef[]): ActivityEvent | undefined {
  const onFloor = (v: unknown) => typeof v === 'string' && agents.some((a) => a.id === v || a.name.toLowerCase() === v.toLowerCase())
  return activity.filter((e) => e.kind === 'agent.joined' && onFloor(e.agentId)).sort((a, b) => b.ts - a.ts)[0]
}

export function moments(i: MomentInput): Moments {
  const events = [...i.activity].sort((a, b) => b.ts - a.ts)
  const find = (v: unknown) => (typeof v === 'string' ? i.agents.find((a) => a.id === v || a.name.toLowerCase() === v.toLowerCase()) : undefined)
  const lead = i.agents.find((a) => a.lead)
  const out: Moments = { overlaps: i.overlaps.filter((o) => !o.resolved).sort((a, b) => b.ts - a.ts), talks: [] }

  out.question = i.approvals.filter((a) => a.status === 'pending' && a.kind === 'question').sort((a, b) => b.createdAt - a.createdAt)[0]

  for (const e of events) {
    if (e.kind !== 'agent.talk') continue
    const from = find(e.data?.from ?? e.agentId)
    const to = find(e.data?.to)
    if (!from || !to || from.id === to.id) continue
    // A delegation runs inside the speaker's own session, so it lasts until that tool call returns (or the speaker's turn ends).
    // A message to another workspace lasts while the listener works on it.
    const toolUseId = e.data?.toolUseId
    const live = typeof toolUseId === 'string'
      ? !events.some((x) => x.ts >= e.ts && ((x.kind === 'tool.end' && x.data?.toolUseId === toolUseId) || (x.kind === 'turn.done' && x.agentId === from.id)))
      : BUSY.includes(i.status[to.id] ?? 'idle') && !events.some((x) => x.kind === 'turn.done' && x.agentId === to.id && x.ts > e.ts)
    out.talks.push({ id: e.id, from: from.id, to: to.id, line: typeof e.data?.line === 'string' ? e.data.line : '', live })
  }

  // A new hire: the newest `agent.joined` for someone on the floor.
  const joined = newestJoin(events, i.agents)
  if (joined && (i.forced === 'hired' || i.now - joined.ts < HIRE_KEEP_MS)) {
    out.hire = { agentId: find(joined.agentId)!.id, eventId: joined.id, fresh: i.now - joined.ts < HIRE_FRESH_MS }
  }

  // The user chatting with an agent in a workspace: their newest message to someone who is working on it and was not briefed since.
  if (!BRIEFING.includes(i.stage)) {
    const chat = events.find((e) => {
      if (e.kind !== 'prompt' || e.actor !== 'you' || !e.agentId || !e.workspaceId) return false
      if (!BUSY.includes(i.status[e.agentId] ?? 'idle')) return false
      return !events.some((b) => b.kind === 'brief' && b.ts > e.ts && (!b.agentId || b.agentId === e.agentId))
    })
    if (chat?.agentId) {
      out.chatting = chat.agentId
      out.say = { agentId: chat.agentId, text: `In a chat with you in ${chat.object ?? 'a workspace'}.`, link: { label: 'Open chat', workspaceId: chat.workspaceId! } }
    }
  }

  // One line over one head. A question beats everything, then the overlap, then agents talking, a chat, and a new hire's hello.
  const talk = out.talks.find((t) => t.live)
  const hire = out.hire && i.agents.find((a) => a.id === out.hire!.agentId)
  if (hire && (i.forced === 'hired' || out.hire!.fresh)) {
    out.say = { agentId: hire.id, text: `Hi, I’m ${hire.name}, the ${hire.role.toLowerCase()}.` }
    out.focus = hire.id
  }
  if (talk) {
    const to = i.agents.find((a) => a.id === talk.to)
    out.say = { agentId: talk.from, text: talk.line || `${to?.name ?? 'Someone'}, a note for you.` }
  }
  if (out.overlaps[0] && lead) {
    const who = out.overlaps[0].parties.map((p) => i.agents.find((a) => a.id === p.agentId)?.name ?? p.agentId)
    out.say = { agentId: lead.id, text: `${names(who)} are both in ${fileName(out.overlaps[0].path)}.` }
  }
  if (out.question?.agentId) {
    const q = out.question
    const said = events.find((e) => e.kind === 'agent.say' && e.agentId === q.agentId && e.ts >= q.createdAt - 60_000)
    out.say = { agentId: q.agentId!, text: said?.text ?? 'I have a question for you.' }
  }
  return out
}

/** Where a person stands next to someone's desk. */
export function deskSpot(agents: AgentDef[], room: { desks?: string[] } | undefined, id: string): Spot | undefined {
  const seat = seating(agents, room).seated.findIndex((a) => a.id === id)
  return seat >= 0 ? DESK_SPOTS[seat] : undefined
}

/**
 * The legs that walk `agentId` to each listener they talked to, oldest first. While a talk is live the speaker stays at the
 * listener's desk; once it ends a second leg sends them `home` (their desk, or wherever the briefing sequence leaves them).
 * Keys come from the event, so one event never sends them twice and a reload starts everyone where their legs end.
 */
export function talkLegs(talks: Talk[], agentId: string, spotOf: (id: string) => Spot | undefined, home: Spot): Leg[] {
  const legs: Leg[] = []
  for (const t of talks.filter((x) => x.from === agentId).slice(0, 5).reverse()) {
    const to = spotOf(t.to)
    if (!to) continue
    legs.push({ key: `talk:${t.id}`, to })
    if (!t.live) legs.push({ key: `talk:${t.id}:end`, to: home })
  }
  return legs
}

/**
 * Which way a walker looks while they talk: toward the other one, so two talking agents face each other. 1 looks right, -1 left,
 * and nothing when they are not in a live talk or stand level with the other.
 */
export function facingOf(talks: Talk[], agentId: string, here: readonly [number, number], where: (id: string) => readonly [number, number] | undefined): 1 | -1 | undefined {
  const talk = talks.find((t) => t.live && (t.from === agentId || t.to === agentId))
  const other = talk && where(talk.from === agentId ? talk.to : talk.from)
  if (!other || Math.abs(other[0] - here[0]) < 1) return undefined
  return other[0] > here[0] ? 1 : -1
}
