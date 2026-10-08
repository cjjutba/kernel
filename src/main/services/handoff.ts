/**
 * "Approve and hand off" (KERNEL-67). A repo's own Lead file may say nothing about handing work out,
 * or even "you only plan", so Kernel adds its rule to every Lead and holds the Lead to it after an approval.
 */

/** Appended to every Lead's system prompt, whatever its agent file says. */
export const LEAD_RULE = [
  'You are the Lead of this room in Kernel. Your teammates each work in their own workspace, and you give them work with the mcp__kernel__ tools.',
  'When the user approves your plan, in plan mode or through request_plan_approval, the approval means "hand it off now". In the same turn, call mcp__kernel__create_workspace once per task, each for one agent from mcp__kernel__list_agents, with a complete brief: goal, files, acceptance criteria.',
  "Don't end the turn with only the plan, and don't ask whether to hand it off. Handing off is not writing code, so it fits a plan-only role. If no task needs a workspace, say why in one line.",
  "When the repo names branches after its issues (for example Linear's gitBranchName), pass that name as branch to create_workspace, so the teammate doesn't have to switch branches."
].join('\n')

/** Sent with the approval itself: after ExitPlanMode as context, and in request_plan_approval's result. */
export const HANDOFF_NOW = 'The user clicked Approve and hand off. Hand each task in the plan to a teammate now: call mcp__kernel__create_workspace once per task with a complete brief. Do not stop at the plan.'

/** Sent once when the Lead tries to end the turn after an approval without creating a workspace. */
export const HANDOFF_REMINDER = 'The user approved your plan for hand-off, and no workspace exists for it yet. Call mcp__kernel__create_workspace once per task now. If no task needs a workspace, say why in one line.'

/**
 * Lead chats whose plan was approved and that have not handed anything off yet. `approved` starts one;
 * `done` ends it when the Lead creates a workspace, or when the user stops or redirects the turn.
 */
export class Handoffs {
  private state = new Map<string, 'due' | 'reminded'>()

  approved(chatId: string) { this.state.set(chatId, 'due') }

  done(chatId: string) { this.state.delete(chatId) }

  /** Approved and nothing handed off yet. */
  due(chatId: string) { return this.state.get(chatId) === 'due' }

  /** The Stop hook's reminder, once per approval. The Stop after it lets the turn end. */
  reminder(chatId: string): string | undefined {
    if (this.state.get(chatId) === 'due') { this.state.set(chatId, 'reminded'); return HANDOFF_REMINDER }
    this.state.delete(chatId)
    return undefined
  }
}
