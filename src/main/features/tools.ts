import type { AgentDef, Chat, Workspace } from '@shared/types'
import { reviewMcpServer, reviewTools } from '../services/reviewMcp'
import { teammateMcpServer, teammateTools } from '../services/teammateMcp'
import { kernelServer } from '../services/kernelServer'
import { sharedTools } from '../services/sharedMcp'
import { LEAD_REVIEW_RULE, LEAD_SHARING_RULE, TEAMMATE_RULE } from '../services/handoff'
import { kernelTools, LEAD_INSTRUCTIONS } from '../services/kernelMcp'
import { Feature } from './feature'

/** The tools in each agent's `kernel` server, and the rule added to its prompt (KERNEL-329). */
export class Tools extends Feature {
  /** Whether agents get share_file. `experimental.sharing` in settings.json, on by default and with no page in Settings (KERNEL-308). */
  private get sharing() { return this.settings?.experimental.sharing === true }

  /**
   * The tools in an agent's `kernel` server: the Lead's, a reviewer's or a teammate's own, and share_file for all three
   * while sharing is on.
   */
  toolsFor(ws: Workspace, agent: AgentDef | undefined, chat: Chat) {
    const own = agent?.lead ? kernelTools(this.k.lead.leadToolDeps(ws.roomId, agent, chat))
      : ws.reviewOf ? reviewTools({ submit: (review) => this.k.reviews.submitReview(ws.id, review) })
      : teammateTools(this.k.waits.teammateToolDeps(ws.id))
    return this.sharing ? [...own, ...sharedTools({ share: (o) => this.k.sharing.shareFile(ws.id, chat.id, o) })] : own
  }

  /** The `kernel` server for a session. With sharing on, every agent's server adds share_file (KERNEL-302). Off, each gets exactly the server it had before. */
  mcpFor(ws: Workspace, agent: AgentDef | undefined, chat: Chat) {
    return this.sharing ? { kernel: kernelServer(this.toolsFor(ws, agent, chat), agent?.lead ? LEAD_INSTRUCTIONS : undefined) }
      : agent?.lead ? { kernel: this.k.lead.leadTools(ws.roomId, agent, chat) }
      : ws.reviewOf ? { kernel: reviewMcpServer({ submit: (review) => this.k.reviews.submitReview(ws.id, review) }) }
      : { kernel: teammateMcpServer(this.k.waits.teammateToolDeps(ws.id)) }
  }

  /**
   * The rule added to an agent's prompt. The Lead's is LEAD_RULE, which agentPrompt adds itself. Auto review and sharing
   * each add a line after it, only while on (KERNEL-115, KERNEL-302).
   */
  rulesFor(ws: Workspace, agent: AgentDef | undefined) {
    if (agent?.lead) return [this.settings?.pr.autoReview !== false && LEAD_REVIEW_RULE, this.sharing && LEAD_SHARING_RULE].filter(Boolean).join('\n') || undefined
    return ws.reviewOf ? this.k.reviews.reviewRuleFor(ws) : TEAMMATE_RULE
  }
}
