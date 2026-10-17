import type { AgentDef, ChatPart } from '@shared/types'
import { takesTasks } from '@shared/team'

/**
 * @agent in a Lead chat (KERNEL-745). The user addresses a message to teammates and the Lead reads who they are. Each one
 * opens an item the Lead owes until it acts for that teammate (`features/openItems.ts`, KERNEL-749).
 */

type Mentioned = Extract<ChatPart, { type: 'agent' }>

/** "Sean", "Sean and Christian", "Sean, Christian and Mira". */
export const namesText = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/** The agents a message mentions, once each, without the Lead itself. `team` is the project's, when Kernel has read it. */
export function mentionsOf(parts: ChatPart[], team?: AgentDef[]): Mentioned[] {
  const seen = new Set<string>()
  return parts.filter((p): p is Mentioned => {
    if (p.type !== 'agent' || seen.has(p.agentId) || team?.find((a) => a.id === p.agentId)?.lead) return false
    seen.add(p.agentId)
    return true
  })
}

/**
 * The lines the Lead reads after a message with mentions: who the user addressed, and a line for each one who can't be handed
 * a task. Undefined when the message mentions nobody. `team` unread counts everyone as taking tasks.
 */
export function mentionNote(parts: ChatPart[], team?: AgentDef[]): string | undefined {
  const mentioned = mentionsOf(parts, team)
  if (!mentioned.length) return undefined
  const lines = [`The user addressed this to ${namesText(mentioned.map((m) => m.name))}.`]
  for (const m of mentioned) {
    const agent = team?.find((a) => a.id === m.agentId)
    if (team && !agent) lines.push(`${m.name} isn't on this project's team now, so tell the user or ask with mcp__kernel__ask_user who should take it.`)
    else if (agent && !takesTasks(agent)) lines.push(`${m.name} doesn't take tasks in this project, so tell the user or ask with mcp__kernel__ask_user who should take it.`)
  }
  return lines.join('\n')
}
