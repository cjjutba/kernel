import type { AgentWarningKind } from './types'

// Usage data, opt-in (KERNEL-397). Every event and every property is listed here, and a property can only be one of a fixed
// set of values, yes or no, or a short code checked by a pattern. Nothing else gets through `checkEvent`, so no path, name,
// prompt or line of code can reach an event by accident.

/** What a property may hold: one of a fixed list, yes or no, or a short code such as an error's class, checked by a pattern. */
type Prop = { enum: readonly string[] } | { bool: true } | { id: RegExp }

/** Agent counts go out as ranges, not exact numbers. */
export const COUNT = ['0', '1-5', '6-20', '21+'] as const
export const countRange = (n: number): (typeof COUNT)[number] => (n <= 0 ? '0' : n <= 5 ? '1-5' : n <= 20 ? '6-20' : '21+')

/** Built-in tools an agent file can leave out. Any other name goes out as `mcp` or `other`. */
export const TOOL_KINDS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent', 'mcp', 'other'] as const

const WARNING_KINDS = [
  'no-description', 'cant-open-pr', 'second-lead', 'setting-missing', 'reserved-id', 'duplicate-id', 'looks-like-lead',
  'unreadable-file', 'mcp-missing', 'mcp-failed', 'mcp-needs-auth', 'mcp-off', 'looks-like-subagent', 'model-unavailable',
  'model-unknown', 'kernel-name'
] as const satisfies readonly AgentWarningKind[]
// A warning kind added to AgentWarningKind and not here fails to compile.
export const EVERY_WARNING: [Exclude<AgentWarningKind, (typeof WARNING_KINDS)[number]>] extends [never] ? true : never = true

export const EVENTS = {
  /** Kernel started. */
  'app.started': {},
  /** Kernel's main process threw and nothing caught it. `frame` is the first stack line in Kernel's own bundle, file name and line only. */
  'app.error': {
    kind: { enum: ['exception', 'rejection'] },
    errorClass: { id: /^[A-Za-z][A-Za-z0-9]{0,39}$/ },
    frame: { id: /^(unknown|[A-Za-z0-9_.-]{1,40}:\d{1,7}(:\d{1,5})?)$/ }
  },
  /** The window's process went away, with Electron's reason. */
  'app.renderer_gone': { reason: { enum: ['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'] } },
  /** A project was added. The event keeps its name from before rooms were renamed projects (KERNEL-880), so its counts carry on. */
  'room.created': { source: { enum: ['repo', 'folder', 'scratch'] } },
  'workspace.created': { by: { enum: ['lead', 'user'] }, review: { bool: true } },
  'pr.merged': {},
  /** The Lead tried to end its turn after an approved plan without handing anything off. */
  'handoff.reminder': {},
  /** A teammate's workspace was archived with no pull request and no commit of its own. */
  'handoff.no_commit': {},
  /** create_workspace refused the agent the Lead named, or a hand-off with no go-ahead from the user (KERNEL-678). */
  'handoff.refused': { reason: { enum: ['unknown', 'ambiguous', 'self', 'no-teammates', 'helper', 'go-ahead'] } },
  /** start_build refused in Build here: the quote isn't in the user's latest message, or the chat is in Hand off (KERNEL-992). */
  'build.refused': { reason: { enum: ['go-ahead', 'handoff'] } },
  /** An agent called a tool its file doesn't list. */
  'tool.blocked_by_agent_file': { tool: { enum: TOOL_KINDS } },
  /** A PR passed checks and nobody was there to review it. */
  'pr.ready_unreviewed': { hasReviewer: { bool: true } },
  /** One kind of warning a project's agent files have, sent with `team.resolved`. */
  'agent.warning': { kind: { enum: WARNING_KINDS } },
  /** A project's team changed shape: where its Lead and reviewer come from, and how many agents it has. */
  'team.resolved': {
    leadFrom: { enum: ['file', 'setting', 'builtin', 'none'] },
    reviewerFrom: { enum: ['file', 'setting', 'builtin', 'none'] },
    agents: { enum: COUNT },
    helpers: { enum: COUNT },
    warnings: { enum: COUNT }
  },
  /** What the user did with the team Project setup showed them. */
  'setup.team_review': { choice: { enum: ['kept', 'changed'] } },
  /** The user copied Kernel's Lead or reviewer into the repo to edit it. */
  'builtin.customized': { which: { enum: ['lead', 'reviewer'] } }
} as const satisfies Record<string, Record<string, Prop>>

export type TelemetryName = keyof typeof EVENTS

type Value<P> = P extends { enum: readonly (infer V)[] } ? V : P extends { bool: true } ? boolean : P extends { id: RegExp } ? string : never

/** One event: its name and its properties, typed from `EVENTS`. */
export type TelemetryEvent = { [N in TelemetryName]: { name: N } & { [K in keyof (typeof EVENTS)[N]]: Value<(typeof EVENTS)[N][K]> } }[TelemetryName]

/** An event as Kernel keeps it for Settings, Privacy and Copy diagnostics: when it happened, and whether it went out. */
export interface TelemetryRecord {
  event: TelemetryEvent
  at: number
  sent: boolean
}

/** Why `e` can't be sent, or nothing when it can: an unknown name, a missing or extra property, or a value outside its rule. */
export function checkEvent(e: { name: string } & Record<string, unknown>): string | undefined {
  const schema = (EVENTS as Record<string, Record<string, Prop>>)[e.name]
  if (!schema) return `unknown event ${JSON.stringify(e.name).slice(0, 40)}`
  for (const key of Object.keys(e)) if (key !== 'name' && !(key in schema)) return `${e.name} has no property ${key.slice(0, 40)}`
  for (const [key, rule] of Object.entries(schema)) {
    const v = e[key]
    const ok = 'enum' in rule ? typeof v === 'string' && rule.enum.includes(v)
      : 'bool' in rule ? typeof v === 'boolean'
      : typeof v === 'string' && rule.id.test(v)
    if (!ok) return `${e.name}.${key} is not allowed`
  }
  return undefined
}
