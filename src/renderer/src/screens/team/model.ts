import type { AgentDef, AgentStatus, Room, Task, TaskColumn, Workspace } from '@shared/types'
import { MODELS } from '@shared/types'
import { lookFor, overflowShirt, seating } from '../../floor/layout'

/** The word on the Team list and the profile. Statuses are words, never dots (DESIGN.md). */
export const STATUS_WORD: Record<AgentStatus, string> = {
  working: 'Working', planning: 'Planning', walking: 'Walking', needs: 'Needs you', idle: 'Idle', blocked: 'Blocked', offline: 'Offline', paused: 'Paused'
}

/** Statuses that read in full ink. The rest are quiet. */
export const LOUD: AgentStatus[] = ['working', 'planning', 'walking', 'needs', 'blocked', 'offline']

export type FilterId = 'all' | 'working' | 'needs' | 'idle'

export const FILTERS: { id: FilterId; label: string; states: AgentStatus[] | null }[] = [
  { id: 'all', label: 'All', states: null },
  { id: 'working', label: 'Working', states: ['working', 'planning', 'walking'] },
  { id: 'needs', label: 'Needs you', states: ['needs', 'blocked', 'offline'] },
  { id: 'idle', label: 'Idle', states: ['idle', 'paused'] }
]

/** The shirt color the agent wears on the floor, so the avatar here matches their desk. */
export function shirtOf(agent: AgentDef, team: AgentDef[], room?: Pick<Room, 'desks'>): string {
  const { seated, overflow } = seating(team, room)
  const seat = seated.findIndex((a) => a.id === agent.id)
  if (seat >= 0) return lookFor(agent, seat).shirt
  return agent.look?.shirt ?? overflowShirt(Math.max(0, overflow.findIndex((a) => a.id === agent.id)))
}

/** Where the agent is working now: their newest open workspace, or the main checkout for the Lead. */
export function currentWorkspace(agentId: string, roomId: string, workspaces: Workspace[]): Workspace | undefined {
  const open = workspaces.filter((w) => w.roomId === roomId && w.agentId === agentId && w.status !== 'archived')
  const own = open.filter((w) => w.mode !== 'current').sort((a, b) => b.createdAt - a.createdAt)[0]
  return own ?? open.find((w) => w.mode === 'current')
}

export const workspaceLabel = (w?: Workspace) => (!w ? 'none' : w.mode === 'current' ? 'main checkout' : w.name)

/** Short path under the repo: ".claude/agents/kai.md". */
export const shortFile = (file: string) => {
  const at = file.lastIndexOf('.claude/')
  return at >= 0 ? file.slice(at) : file
}

const DAY = 24 * 60 * 60 * 1000
/** "New" tag for an agent whose file appeared in the last day. */
export const isNew = (a: AgentDef, now = Date.now()) => !!a.joinedAt && now - a.joinedAt < DAY

/** "sonnet" from "claude-sonnet-5-5", the form agent files use. */
export const modelAlias = (id: string) => id.split('-')[1] ?? id
/** Whether the agent's `model` (an alias or a full id) is this catalog entry. */
export const sameModel = (model: string | undefined, id: string) => !!model && (model === id || model.toLowerCase() === modelAlias(id) || id.includes(`-${model.toLowerCase()}-`))
export const modelName = (model?: string) => (model ? MODELS.find((m) => sameModel(model, m.id))?.label ?? model : 'Default model')

/** Tools the editor always offers. An agent's own extra tools, such as `Bash(pnpm test:*)`, are added after these. */
export const STANDARD_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch']

const COLUMN_WORD: Record<TaskColumn, string> = { spec: 'Spec', plan: 'Planned', build: 'In progress', qa: 'In QA', review: 'In review', done: 'Done' }

export interface RecentItem { id: string; title: string; meta: string; workspaceId?: string }

/** The agent's last tasks, newest first: "T-14 Invoice table", "Merged · PR #42". */
export function recentWork(agentId: string, tasks: Task[], workspaces: Workspace[], limit = 4): RecentItem[] {
  const wsOf = (id?: string) => (id ? workspaces.find((w) => w.id === id) : undefined)
  const fromTasks = tasks.filter((t) => t.agentId === agentId).sort((a, b) => b.updatedAt - a.updatedAt).map((t): RecentItem => {
    const ws = wsOf(t.workspaceId)
    const meta = t.column === 'done'
      ? ws?.prNumber ? `${ws.prState === 'merged' ? 'Merged' : 'Done'} · PR #${ws.prNumber}` : 'Done'
      : `${COLUMN_WORD[t.column]}${ws ? ` · ${ws.name}` : ''}`
    return { id: t.id, title: `${t.id} ${t.title}`, meta, workspaceId: ws?.id }
  })
  const linked = new Set(fromTasks.map((r) => r.workspaceId))
  const fromWorkspaces = workspaces.filter((w) => w.agentId === agentId && w.name !== 'lead' && !linked.has(w.id)).sort((a, b) => b.createdAt - a.createdAt).map((w): RecentItem => ({
    id: w.id, title: w.title ?? w.name, meta: w.prNumber ? `${w.prState === 'merged' ? 'Merged' : 'PR'} · #${w.prNumber}` : w.status === 'archived' ? 'Archived' : w.name, workspaceId: w.id
  }))
  return [...fromTasks, ...fromWorkspaces].slice(0, limit)
}

/** What a chip row shows: the standard choices, then anything else the agent already has. */
export const withExtras = (options: string[], chosen: string[] = []) => [...options, ...chosen.filter((c) => !options.includes(c))]
