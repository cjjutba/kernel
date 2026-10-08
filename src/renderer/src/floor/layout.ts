import type { ActivityEvent, AgentDef, AgentLook, AgentStatus, Approval, RateLimit, Room, Workspace } from '@shared/types'
import { MODELS } from '@shared/types'

// Layout data for the floor art (floor.svg, 800x600). Numbers come from roster() in design/canvas/project/Main.dc.html.

/** Seat anchors in the art's viewBox, lead desk first. */
export const SEATS: [number, number][] = [[443.8, 293.6], [245.6, 298.0], [332.2, 348.0], [162.5, 346.0], [249.1, 396.0], [453.5, 458.0]]

/** How people look when an agent file has no `look`. Taken in file order, so a person keeps their look when they change desks. */
export const LOOKS: AgentLook[] = [
  { shirt: '#3f4652', skin: '#d8b896', hair: '#2b2420' }, { shirt: '#5b6b5e', skin: '#c99b74', hair: '#1f1a17' },
  { shirt: '#6b5d73', skin: '#8d6346', hair: '#141212' }, { shirt: '#7a6a55', skin: '#e0c2a2', hair: '#5a4636' },
  { shirt: '#4b5560', skin: '#b07f5c', hair: '#2a2422' }, { shirt: '#5f6f7a', skin: '#c9a27e', hair: '#3a2c22' }
]

/** Art colors for the seat drawing: desk faces, the person's shade, a walker's legs, and the letter on a shirt-colored dot. Fixed, so a light theme leaves the office as it is. */
export const ART = { shade: '#000000', deskLeft: '#d8d5ce', deskRight: '#c6c3bb', deskTop: '#eeece7', onShirt: '#f7f8f8', legLeft: '#2a2b30', legRight: '#24252a' } as const

/** Shirts for agents past the last desk (the overflow strip). */
const OVERFLOW_SHIRTS = ['#5a6370', '#6d6a5c', '#4f6068', '#645a6e']

export const WORD: Record<AgentStatus, string> = {
  working: 'working', planning: 'planning', walking: 'walking', needs: 'needs you', idle: 'idle', blocked: 'blocked', offline: 'offline', paused: 'paused'
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** A position in the art as a CSS percentage of the 800x600 box. */
export const pct = (x: number, y: number) => ({ left: `${(x / 800) * 100}%`, top: `${(y / 600) * 100}%` })

export interface Seating {
  /** Agents at desks, lead first. Index is the seat. */
  seated: AgentDef[]
  /** Agents with no desk. */
  overflow: AgentDef[]
}

/** What `seating` reads besides the agents. Pass the room's own lists: the workspaces, the store's status and the room's activity. */
export interface SeatingContext {
  workspaces?: Pick<Workspace, 'agentId' | 'status'>[]
  status?: Record<string, AgentStatus>
  activity?: Pick<ActivityEvent, 'agentId' | 'ts'>[]
}

/**
 * Who sits where. `room.desks` lists agent ids in desk order and anyone not listed has no desk. Without it the lead sits first,
 * then agents with an open workspace or a status other than idle (in file order), then everyone else by their newest activity
 * in the room (file order breaks ties). The lead always takes the lead desk.
 */
export function seating(agents: AgentDef[], room?: Pick<Room, 'desks'>, ctx: SeatingContext = {}): Seating {
  const live = agents.filter((a) => !a.retired)
  const lead = live.find((a) => a.lead)
  let ordered: AgentDef[]
  if (room?.desks) ordered = room.desks.map((id) => live.find((a) => a.id === id)).filter((a): a is AgentDef => !!a)
  else {
    const open = new Set((ctx.workspaces ?? []).filter((w) => w.status !== 'archived').map((w) => w.agentId))
    const newest = new Map<string, number>()
    for (const e of ctx.activity ?? []) if (e.agentId) newest.set(e.agentId, Math.max(newest.get(e.agentId) ?? 0, e.ts))
    const tier = (a: AgentDef) => (a === lead ? 0 : open.has(a.id) || (ctx.status?.[a.id] ?? 'idle') !== 'idle' ? 1 : 2)
    ordered = live
      .map((a, i) => ({ a, i, t: tier(a) }))
      .sort((x, y) => x.t - y.t || (x.t === 2 ? (newest.get(y.a.id) ?? 0) - (newest.get(x.a.id) ?? 0) : 0) || x.i - y.i)
      .map((x) => x.a)
  }
  const queue = lead && ordered.includes(lead) ? [lead, ...ordered.filter((a) => a !== lead)] : ordered
  const seated = queue.slice(0, SEATS.length)
  return { seated, overflow: live.filter((a) => !seated.includes(a)) }
}

/** The agents the no-desk card lists: those without a desk who are doing something. */
export const deskless = (overflow: AgentDef[], status: Record<string, AgentStatus>) => overflow.filter((a) => (status[a.id] ?? 'idle') !== 'idle')

/** How an agent looks: their file's `look`, else one by their place in the file (`order`), so a person keeps their look when they change desks. */
export const lookFor = (agent: AgentDef, order: number): AgentLook => agent.look ?? LOOKS[order % LOOKS.length]
export const overflowShirt = (i: number) => OVERFLOW_SHIRTS[i % OVERFLOW_SHIRTS.length]

/** "Opus 5.5" from an agent's `model`, which is an alias ("opus") or a full model id. */
export function modelLabel(model?: string): string {
  if (!model) return ''
  const m = MODELS.find((x) => x.id === model || x.id.includes(`-${model.toLowerCase()}-`) || x.label.toLowerCase().startsWith(model.toLowerCase()))
  return m?.label ?? model
}

/**
 * The agent the popover opens on: the one the user clicked while they are still in the room, else the first that needs the user
 * (needs you, blocked, offline), else nobody.
 */
export function defaultSelected(agents: AgentDef[], status: Record<string, AgentStatus>, clicked?: string | null): AgentDef | undefined {
  const picked = clicked ? agents.find((a) => a.id === clicked) : undefined
  return picked ?? agents.find((a) => ['needs', 'blocked', 'offline'].includes(status[a.id] ?? 'idle'))
}

/** Agents the user has to act on: status needs you, or a pending approval of theirs. Each agent counts once, and an approval with no agent counts on its own. */
export function needsCount(agents: AgentDef[], status: Record<string, AgentStatus>, approvals: Pick<Approval, 'agentId'>[]): number {
  const ids = new Set(agents.filter((a) => status[a.id] === 'needs').map((a) => a.id))
  let loose = 0
  for (const a of approvals) { if (a.agentId) ids.add(a.agentId); else loose++ }
  return ids.size + loose
}

/** The newest event for this agent that explains why it is blocked or offline. Its `data.detail` and `data.output` fill the floor card. */
export function latestWarn(events: ActivityEvent[], agentId: string, kinds: ActivityEvent['kind'][]): ActivityEvent | undefined {
  return events.filter((e) => e.agentId === agentId && kinds.includes(e.kind)).sort((a, b) => b.ts - a.ts)[0]
}

const LIMIT_NAME: Record<RateLimit['type'], string> = {
  five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus limit', seven_day_sonnet: 'Weekly Sonnet limit',
  seven_day_overage_included: 'Weekly Fable limit', overage: 'Extra usage limit'
}

/** "Monday, 9:00 AM", or just "1:00 PM" when the reset is within a day. */
export function resetWhen(at: number, now = Date.now()): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return at - now < 24 * 3600_000 ? time : `${d.toLocaleDateString('en-US', { weekday: 'long' })}, ${time}`
}

/**
 * The banner for a room paused by a limit: of the limits that pause rooms (5-hour and weekly), the rejected one that
 * resets last decides the wording. `resetsAt` is epoch seconds.
 */
export function limitBanner(usage: RateLimit[], now = Date.now()): { type: RateLimit['type']; text: string } {
  const hit = usage.filter((l) => (l.type === 'five_hour' || l.type === 'seven_day') && l.status === 'rejected').sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0]
  if (!hit) return { type: 'five_hour', text: 'Usage limit reached. Every agent waits until it resets.' }
  const until = hit.resetsAt ? `until ${resetWhen(hit.resetsAt * 1000, now)}` : 'until it resets'
  return { type: hit.type, text: `${LIMIT_NAME[hit.type]} reached. Every agent waits ${until}.` }
}

/** The day heading above a group of log lines. */
export function dayLabel(ts: number, now = Date.now()): string {
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
  const diff = Math.round((day(now) - day(ts)) / 86_400_000)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
