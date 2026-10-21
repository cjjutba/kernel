import type { AgentDef, Chat, Workspace } from '@shared/types'
import { reviewTools } from '../services/reviewMcp'
import { teammateTools } from '../services/teammateMcp'
import { kernelServer, LEAD_ALWAYS_LOADED } from '../services/kernelServer'
import { sharedTools } from '../services/sharedMcp'
import { issueTools } from '../services/issueMcp'
import { LEAD_SHARING_RULE, SHARE_RULE, TEAMMATE_RULE } from '../services/handoff'
import { kernelTools, LEAD_INSTRUCTIONS } from '../services/kernelMcp'
import { withReceipts } from '../services/toolReceipts'
import { Feature } from './feature'

/** The tools in each agent's `kernel` server, and the rule added to its prompt (KERNEL-329). */
export class Tools extends Feature {
  /** Whether agents get share_file. `experimental.sharing` in settings.json, on by default and with no page in Settings (KERNEL-308). */
  private get sharing() { return this.settings?.experimental.sharing === true }

  /**
   * The tools in an agent's `kernel` server: the Lead's, a reviewer's or a teammate's own, get_issue for all three
   * (KERNEL-473), and share_file while sharing is on.
   */
  toolsFor(ws: Workspace, agent: AgentDef | undefined, chat: Chat) {
    const own = agent?.lead ? kernelTools(this.k.lead.leadToolDeps(ws.projectId, agent, chat))
      : ws.reviewOf ? reviewTools({ submit: (review) => this.k.reviews.submitReview(ws.id, review, chat.id) })
      : teammateTools(this.k.waits.teammateToolDeps(ws.id))
    const issue = issueTools({ issueKey: () => this.issueKey(ws.id), tracker: (key) => this.k.integrations.trackerOf(ws.projectId, { id: key }) })
    // A repeat of a call, by the provider's id for it, answers from the first result and does nothing twice (durable-tool-calls).
    return withReceipts([...own, ...issue, ...(this.sharing ? sharedTools({ share: (o) => this.k.sharing.shareFile(ws.id, chat.id, o) }) : [])], { chatId: chat.id, store: this.store })
  }

  /** The issue a workspace builds, as saved now. A review reads the issue of the work it reviews. */
  private issueKey(id: string): string | undefined {
    const ws = this.store.workspace(id)
    const of = (w: Workspace | undefined) => (w?.source?.kind === 'issue' ? w.source.id : undefined)
    return of(ws) ?? (ws?.reviewOf ? of(this.store.workspace(ws.reviewOf)) : undefined)
  }

  /** The `kernel` server for a session, with the tools `toolsFor` gives the agent. The Lead's carries its instructions, and only its most used tools in the prompt (lean-lead-prompt). */
  mcpFor(ws: Workspace, agent: AgentDef | undefined, chat: Chat) {
    return { kernel: kernelServer(this.toolsFor(ws, agent, chat), agent?.lead ? LEAD_INSTRUCTIONS : undefined, agent?.lead ? { loaded: LEAD_ALWAYS_LOADED } : {}) }
  }

  /**
   * What a Codex chat gets of Kernel's (KERNEL-406): the same tools as the `kernel` server, as dynamic tools, and the Lead's
   * server instructions, which go into the thread's developer instructions.
   */
  codexTools(ws: Workspace, agent: AgentDef | undefined, chat: Chat) {
    return { tools: this.toolsFor(ws, agent, chat), instructions: agent?.lead ? LEAD_INSTRUCTIONS : undefined }
  }

  /**
   * The rule added to an agent's prompt. The Lead's is LEAD_RULE, which agentPrompt adds itself, and sharing adds a line after
   * it while on (KERNEL-302). Kernel starts reviews itself, so the Lead has no review line of its own (KERNEL-549). A review
   * chat gets the review rule for its kind, and every other agent TEAMMATE_RULE, then SHARE_RULE while sharing is on (KERNEL-397).
   */
  rulesFor(ws: Workspace, agent: AgentDef | undefined, chat?: Chat) {
    if (agent?.lead) return this.sharing ? LEAD_SHARING_RULE : undefined
    const own = ws.reviewOf ? this.k.reviews.reviewRuleFor(ws, chat) : TEAMMATE_RULE
    return this.sharing ? [own, SHARE_RULE].filter(Boolean).join('\n') : own
  }
}
