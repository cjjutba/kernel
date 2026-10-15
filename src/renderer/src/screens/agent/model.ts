import type { AgentDef, AgentStatus, AgentWarning, Project } from '@shared/types'
import { MODELS } from '@shared/types'
import { lookFor, overflowShirt, shirtOrder } from './looks'

/** The word for an agent's status in the sidebar. Statuses are words, never dots (DESIGN.md). */
export const STATUS_WORD: Record<AgentStatus, string> = {
  working: 'Working', planning: 'Planning', walking: 'Walking', needs: 'Needs you', idle: 'Idle', blocked: 'Blocked', offline: 'Offline', paused: 'Paused'
}

/** The shirt color of the agent's avatar. The look follows file order, not the place in the project's order, so it stays when an agent moves. */
export function shirtOf(agent: AgentDef, team: AgentDef[], project?: Pick<Project, 'desks'>): string {
  const { first, overflow } = shirtOrder(team, project)
  if (first.some((a) => a.id === agent.id)) return lookFor(agent, Math.max(0, team.filter((a) => !a.retired).findIndex((a) => a.id === agent.id))).shirt
  return agent.look?.shirt ?? overflowShirt(Math.max(0, overflow.findIndex((a) => a.id === agent.id)))
}

/** Short path under the repo: ".claude/agents/kai.md". */
export const shortFile = (file: string) => {
  const at = file.lastIndexOf('.claude/')
  return at >= 0 ? file.slice(at) : file
}

/** "sonnet" from "claude-sonnet-5-5", the form agent files use. */
export const modelAlias = (id: string) => id.split('-')[1] ?? id
/** Whether the agent's `model` (an alias or a full id) is this catalog entry. */
export const sameModel = (model: string | undefined, id: string) => !!model && (model === id || model.toLowerCase() === modelAlias(id) || id.includes(`-${model.toLowerCase()}-`))
export const modelName = (model?: string) => (model ? MODELS.find((m) => sameModel(model, m.id))?.label ?? model : 'Default model')

/** Tools the editor always offers. An agent's own extra tools, such as `Bash(pnpm test:*)`, are added after these. */
export const STANDARD_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch']

/** What a chip row shows: the standard choices, then anything else the agent already has. */
export const withExtras = (options: string[], chosen: string[] = []) => [...options, ...chosen.filter((c) => !options.includes(c))]

/** What Settings, Agents and the agent editor say about something Kernel noticed in an agent file (KERNEL-397). */
export function warningText(w: AgentWarning): string {
  switch (w.kind) {
    case 'no-description': return 'It has no description, so the Lead can\u2019t tell what to hand it.'
    case 'cant-open-pr': return 'Its tools can\u2019t edit files and run git, so it doesn\u2019t take tasks.'
    case 'second-lead': return `It\u2019s marked Lead too. ${w.detail ?? 'Another agent'} leads this project.`
    case 'setting-missing': return `${w.detail ?? 'A setting'} in settings.toml names nobody on this team.`
    case 'reserved-id': return `${w.detail ?? 'A file'} uses a name Kernel keeps for its own agents, so Kernel skips that file.`
    case 'duplicate-id': return `${w.detail ?? 'Another file'} has the same name, so Kernel skips that file.`
    case 'looks-like-lead': return 'Its description says it leads. Add lead: true to its file to make it the Lead.'
    // Nothing raises these yet (KERNEL-432). The words are plain stand-ins until Team's design for them lands.
    case 'unreadable-file': return `Kernel couldn’t read its file${w.detail ? `: ${w.detail}` : ''}.`
    case 'mcp-missing': return `${w.detail ?? 'A server'} in its file isn’t set up on this Mac.`
    case 'mcp-failed': return `${w.detail ?? 'A server'} in its file didn’t start.`
    case 'mcp-needs-auth': return `${w.detail ?? 'A server'} in its file needs you to sign in.`
    case 'mcp-off': return `${w.detail ?? 'A server'} in its file is switched off in this project.`
    // ProjectSetupRoster.png's words (KERNEL-465).
    case 'looks-like-subagent': return 'Written as a subagent with no pull request workflow, so it starts as a helper.'
    case 'model-unavailable': return 'Pins a model you’re not signed in for.'
    case 'model-unknown': return 'Pins a model Kernel doesn’t recognize.'
    case 'kernel-name': return 'Its name is Kernel, the Lead\u2019s, so it shows as Kernel (agent).'
  }
}
