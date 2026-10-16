import { providerOf } from './providers'
import { isReviewer } from './team'
import { MODELS, type AgentDef, type Role, type RoleModel } from './types'

/** A model id that is Codex's (gpt-6-astra, o4-mini, codex-mini), for an agent file without `provider:` (KERNEL-406). */
const CODEX_MODEL = /^(gpt-|o\d|codex-)/i

/**
 * The provider, model and effort an agent's chats start on, given its role's default from Settings, Models and effort (KERNEL-406).
 * The agent file's `model:` pins the agent, on its `provider:` or the one the model id belongs to, with the file's `effort:` or the
 * role's. Otherwise it is the role's default, with the file's `effort:` when it has one. The main process and the New chat boxes
 * read it, so a box opens on what the Lead's own chats start on (KERNEL-544).
 */
export function rolePick(agent: Pick<AgentDef, 'model' | 'provider' | 'effort'>, role: RoleModel): RoleModel {
  const pinned = agent.model?.trim()
  const alias = pinned && MODELS.find((x) => x.id === pinned || x.id.split('-')[1] === pinned.toLowerCase())?.id
  // `inherit`, or a model Kernel can't place, follows the role, as it always did.
  const provider = agent.provider ?? (alias || pinned?.startsWith('claude-') ? 'claude' : pinned && CODEX_MODEL.test(pinned) ? providerOf(pinned) : undefined)
  if (!pinned || !provider) return { ...role, effort: agent.effort ?? role.effort }
  return { provider, model: provider === 'claude' ? alias || pinned : pinned, effort: agent.effort ?? role.effort }
}

/** The role Settings, Models and effort reads for this agent. A frontend engineer has a row of its own, every other one reads Backend's (KERNEL-974). */
export function roleOf(agent: AgentDef): Role {
  if (agent.lead) return 'lead'
  if (isReviewer(agent)) return 'reviewer'
  if (/qa/i.test(agent.role)) return 'qa'
  if (/frontend/i.test(agent.role)) return 'frontend'
  return 'engineers'
}
