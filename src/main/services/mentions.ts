import type { AgentDef, ChatPart } from '@shared/types'
import { takesTasks } from '@shared/team'

/**
 * @agent in a Lead chat (KERNEL-745). The user addresses a message to teammates, the Lead reads who they are, and Kernel holds
 * the Lead to acting for each one, the way `Handoffs` holds it to an approved plan. KERNEL-749 moves this record into the
 * open-items one, so it stays small.
 */

type Mentioned = Extract<ChatPart, { type: 'agent' }>

/** "Noor", "Noor and Kai", "Noor, Kai and Mira". */
export const namesText = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/** The agents a message mentions, once each, without the Lead itself. `team` is the room's, when Kernel has read it. */
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
    if (team && !agent) lines.push(`${m.name} isn't on this room's team now, so tell the user or ask with mcp__kernel__ask_user who should take it.`)
    else if (agent && !takesTasks(agent)) lines.push(`${m.name} doesn't take tasks in this room, so tell the user or ask with mcp__kernel__ask_user who should take it.`)
  }
  return lines.join('\n')
}

/** The Stop hook's reminder for the mentions the Lead hasn't acted for. */
export const mentionReminder = (names: string[]) =>
  `The user addressed their message to ${namesText(names)}, and you haven't acted for ${names.length === 1 ? 'that teammate' : 'each of them'} yet. Call mcp__kernel__create_workspace, mcp__kernel__message_agent for their workspace, or mcp__kernel__ask_user now. If none fits, say why in one line.`

/**
 * Open mentions per Lead chat. `opened` starts them with the user's message; `acted` closes one when create_workspace,
 * message_agent or ask_user targets that agent (ask_user, no agent, closes them all); `done` closes them all when the user
 * stops or redirects the turn.
 */
export class Mentions {
  private state = new Map<string, Map<string, { name: string; reminded: boolean }>>()

  opened(chatId: string, mentioned: { agentId: string; name: string }[]) {
    if (!mentioned.length) return
    const open = this.state.get(chatId) ?? new Map()
    for (const m of mentioned) open.set(m.agentId, { name: m.name, reminded: false })
    this.state.set(chatId, open)
  }

  acted(chatId: string, agentId?: string) {
    const open = this.state.get(chatId)
    if (!open) return
    if (agentId === undefined) open.clear()
    else open.delete(agentId)
    if (!open.size) this.state.delete(chatId)
  }

  done(chatId: string) { this.state.delete(chatId) }

  /** The mentions still open in the chat, by name. */
  open(chatId: string): string[] { return [...(this.state.get(chatId)?.values() ?? [])].map((m) => m.name) }

  /** The Stop hook's reminder, once per open mention. The Stop after it lets the turn end and drops those mentions. */
  reminder(chatId: string): string | undefined {
    const open = this.state.get(chatId)
    if (!open) return undefined
    const due: string[] = []
    for (const [id, m] of open) {
      if (m.reminded) open.delete(id)
      else { m.reminded = true; due.push(m.name) }
    }
    if (!open.size) this.state.delete(chatId)
    return due.length ? mentionReminder(due) : undefined
  }
}
