import type { AppSettings, LeadMode, ProjectSettings, Workspace } from './types'
import { isLeadChatWorkspace } from './leadWorkspace'

// Hand off and Build here, the two ways a chat with Kernel works (KERNEL-770).

export const LEAD_MODES: LeadMode[] = ['handoff', 'build']

/** A chat's mode. Unset is Hand off, as every chat with Kernel was before KERNEL-770. */
export const leadModeOf = (ws: Pick<Workspace, 'leadMode'> | undefined): LeadMode => ws?.leadMode ?? 'handoff'

/**
 * A chat with Kernel in Build here, whose own PRs take a teammate's path: review, Team updates, auto-merge (KERNEL-778). It
 * follows the mode, so switching back to Hand off takes the chat's PR off that path.
 */
export const buildsHere = (ws: Workspace | undefined): boolean => !!ws && isLeadChatWorkspace(ws) && leadModeOf(ws) === 'build'

/**
 * The mode a new chat with Kernel starts in: the project's `[agents] lead_mode`, else Settings, Agents, else Hand off. The most
 * specific wins. Only a new chat reads it, so changing a default leaves open chats as they are.
 */
export function newChatLeadMode(app: { team?: Partial<AppSettings['team']> } | undefined, project: Pick<ProjectSettings, 'agents'> | undefined): LeadMode {
  const valid = (m: unknown): m is LeadMode => LEAD_MODES.includes(m as LeadMode)
  const own = project?.agents?.leadMode
  const all = app?.team?.leadMode
  return valid(own) ? own : valid(all) ? all : 'handoff'
}

/** The mode's name as the app shows it. */
export const leadModeName = (mode: LeadMode) => (mode === 'build' ? 'Build here' : 'Hand off')

/** What the divider a switch leaves in the chat says (KERNEL-770). */
export const leadModeSwitched = (mode: LeadMode) => mode === 'build'
  ? "Switched to Build here. Kernel can edit files in this chat's worktree."
  : 'Switched to Hand off. Kernel plans and hands tasks to teammates, and doesn\'t edit files.'
