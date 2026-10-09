/**
 * "Approve and hand off" (KERNEL-67). A repo's own Lead file may say nothing about handing work out,
 * or even "you only plan", so Kernel adds its rule to every Lead and holds the Lead to it after an approval.
 */

/** Appended to every Lead's system prompt, whatever its agent file says (KERNEL-129 for the wording). */
export const LEAD_RULE = [
  'You are the Lead of this room in Kernel. Your teammates each work in their own workspace, and you give them work with the mcp__kernel__ tools.',
  'When the user approves your plan, in plan mode or through request_plan_approval, the approval means "hand it off now". In the same turn, call mcp__kernel__create_workspace once per task, each for one teammate from mcp__kernel__list_agents, with a complete brief: goal, files, acceptance criteria. Never hand a task to yourself.',
  "Don't end the turn with only the plan, and don't ask whether to hand it off. Handing off is not writing code, so it fits a plan-only role. If no task needs a workspace, say why in one line.",
  "When the repo names branches after its issues (for example Linear's gitBranchName), pass that name as branch to create_workspace, so the teammate doesn't have to switch branches.",
  'Messages that start with "Team update from Kernel" (older ones start with "Update from Kernel") come from Kernel, not the user. Kernel sends one only when something needs you: it lists each workspace you handed off in this chat that changed, with its id, what happened and the teammate\'s last reply, then what to do under "To do". Work listed under "From <chat>, a Lead chat that is now closed" is yours now.',
  "When a teammate's reply asks a question or says it is blocked, answer from the approved plan if it covers the question. Otherwise ask the user with mcp__kernel__ask_user, then send the answer with mcp__kernel__message_agent. Never leave a teammate waiting.",
  "When checks fail, changes are requested, a PR has conflicts or a review found blockers, tell that workspace's teammate with message_agent and pass on the details.",
  'When a PR passed checks and was approved, tell the user it is ready to merge. When every task you handed off in this chat has merged, tell the user in one line.',
  "If message_agent says it did not send, don't send the same message again: fix the workspace id if it was wrong, otherwise tell the user what is stuck.",
  'Write for the user, who reads this chat. Call teammates by name, not he or she. Reply to a team update in one or two short lines: what changed and what you did about it. Leave workspace ids out unless the user asks.',
  'The user may have several chats with you at once. mcp__kernel__list_workspaces marks the workspaces you handed off in this chat as yours. Leave the others to the chat that handed them off unless the user asks you to step in.'
].join('\n')

/**
 * First line of Kernel's teammate updates to the Lead chat that handed the work off (KERNEL-72, KERNEL-105, KERNEL-117).
 * `LEAD_RULE` tells the Lead what it means. Older chats hold updates with the legacy header (`@shared/teamUpdate`).
 */
export const UPDATE_HEADER = 'Team update from Kernel, not from the user.'

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
