import type { AgentDef, Chat, Workspace } from '@shared/types'
import { kernelServer } from '../services/kernelServer'
import { kernelTools, LEAD_INSTRUCTIONS } from '../services/kernelMcp'
import { reviewMcpServer, reviewTools } from '../services/reviewMcp'
import { teammateMcpServer, teammateTools } from '../services/teammateMcp'
import { sharedTools } from '../services/sharedMcp'
import { LEAD_SHARING_RULE, TEAMMATE_RULE } from '../services/handoff'
import { Feature } from './feature'

/** Each agent's `kernel` server, and the rule added to its prompt (KERNEL-329). */
export class Tools extends Feature {
  /** Whether agents get share_file. `experimental.sharing` in settings.json, on by default and with no page in Settings (KERNEL-308). */
  private get sharing() { return this.settings?.experimental.sharing === true }

  /** With sharing on, every agent's server adds share_file (KERNEL-302). Off, each gets exactly the server it had before. */
  mcpFor(ws: Workspace, agent: AgentDef | undefined, chat: Chat) {
    return this.sharing ? { kernel: kernelServer(this.toolsFor(ws, agent, chat), agent?.lead ? LEAD_INSTRUCTIONS : undefined) }
      : agent?.lead ? { kernel: this.k.lead.leadTools(ws.roomId, agent, chat) }
      : ws.reviewOf ? { kernel: reviewMcpServer({ submit: (review) => this.k.submitReview(ws.id, review) }) }
      : { kernel: teammateMcpServer(this.k.waits.teammateToolDeps(ws.id)) }
  }

  /** The Lead's rule is LEAD_RULE, which agentPrompt adds itself. Sharing adds a line after it, only while on (KERNEL-302). */
  rulesFor(ws: Workspace, agent: AgentDef | undefined) {
    return agent?.lead ? (this.sharing ? LEAD_SHARING_RULE : undefined) : ws.reviewOf ? this.k['reviewRuleFor'](ws) : TEAMMATE_RULE
  }

  /**
   * The tools in an agent's `kernel` server: the Lead's, a reviewer's or a teammate's own, and share_file for all three
   * while sharing is on.
   */
  toolsFor(ws: Workspace, agent: AgentDef | undefined, chat: Chat) {
    const own = agent?.lead ? kernelTools(this.k.lead.leadToolDeps(ws.roomId, agent, chat))
      : ws.reviewOf ? reviewTools({ submit: (review) => this.k.submitReview(ws.id, review) })
      : teammateTools(this.k.waits.teammateToolDeps(ws.id))
    return this.sharing ? [...own, ...sharedTools({ share: (o) => this.k.sharing.shareFile(ws.id, chat.id, o) })] : own
  }
}
