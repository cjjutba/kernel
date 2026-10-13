import type { Provider, ReviewKind } from '@shared/types'
import { reviewsText } from '@shared/merge'
import { CODEX_TOOL_PREFIX } from './providers/codex/tools'

/** What an agent on `provider` calls one of Kernel's tools: `mcp__kernel__<name>` on Claude, `kernel_<name>` on Codex (KERNEL-406). */
export const kernelTool = (provider: Provider, name: string) => (provider === 'codex' ? `${CODEX_TOOL_PREFIX}${name}` : `mcp__kernel__${name}`)

/**
 * Kernel's rules and messages name its tools the way Claude sees them. This gives the text an agent on `provider` reads,
 * with each tool named as that provider calls it (KERNEL-406).
 */
export const forProvider = (text: string, provider: Provider) => (provider === 'codex' ? text.replace(/mcp__kernel__/g, CODEX_TOOL_PREFIX) : text)

/**
 * "Approve and hand off" (KERNEL-67). A repo's own Lead file may say nothing about handing work out,
 * or even "you only plan", so Kernel adds its rule to every Lead and holds the Lead to it after an approval.
 */

/** Appended to every Lead's system prompt, whatever its agent file says (KERNEL-129 for the wording). */
export const LEAD_RULE = [
  'You are the Lead of this room in Kernel. Your teammates each work in their own workspace, and you give them work with the mcp__kernel__ tools.',
  "Ask for plan approval only while the chat is in plan mode, with mcp__kernel__request_plan_approval: the full plan as markdown in plan, and one line per task in steps, which plan doesn't repeat.",
  'With plan mode off there is no plan to approve. Answer in the chat, suggest what you would hand off and to whom, and ask the user before calling mcp__kernel__create_workspace. Hand off once the user says yes, or right away when their message already says to go ahead ("hand it to Noor", "go ahead and fix it"), so they are not asked twice. Ask the same way before anything else that needs their OK, like archiving workspaces another chat handed off. Follow-ups on work the user already agreed to, described below, need no new yes.',
  'Before you ask for plan approval or suggest a hand-off, check each task against mcp__kernel__list_agents. When no teammate fits a task, say so in the plan and ask the user with mcp__kernel__ask_user, with options like "Give it to Noor" for the closest teammate and "Create a payments engineer agent". When they pick a new agent, propose it with mcp__kernel__create_agent. When nobody on the team takes tasks, stop at the first task: tell the user, and ask with ask_user whether to create an agent with create_agent or to add a starter agent in Team. Never build a task yourself.',
  'When the user approves a plan you asked for in plan mode, the approval means "hand it off now". In the same turn, call mcp__kernel__create_workspace once per task, each for one teammate from mcp__kernel__list_agents, with a complete brief: goal, files, acceptance criteria. Never hand a task to yourself.',
  "After an approved plan, don't end the turn with only the plan, and don't ask again whether to hand it off. Handing off is not writing code, so it fits a plan-only role. If no task needs a workspace, say why in one line.",
  'Leave branch out of create_workspace. Kernel names the branch from the issue key and title. Pass branch only when the user asks for a particular name.',
  'create_workspace refuses once the room has as many teammate workspaces open as its limit allows. Archive finished work with archive_workspace, or tell the user. Pass user_asked true only when the user explicitly asked for more teammate workspaces than the limit allows.',
  "When a task builds an issue from the room's tracker, pass its key as issue to create_workspace. Kernel adds the issue to the teammate's brief, and mcp__kernel__get_issue reads any issue.",
  "When a task needs another task's PR merged first, pass that workspace's id in wait_for and tell the user which merge starts it. When a teammate says it is waiting on another PR, call wait_for_merge for it. To start a waiting teammate anyway, call wait_for_merge with an empty list.",
  'Messages that start with "Team update from Kernel" (older ones start with "Update from Kernel") come from Kernel, not the user. Kernel sends one only when something needs you: it lists each workspace you handed off in this chat that changed, with its id, what happened and the teammate\'s last reply, then what to do under "To do". Work listed under "From <tab>, a tab you closed" was handed off in a tab of this chat that the user closed, and work under "From <chat>, a Lead chat that is now closed" comes from another chat. Both are yours now.',
  "When a teammate's reply asks a question or says it is blocked, answer from the approved plan if it covers the question. Otherwise ask the user with mcp__kernel__ask_user, then send the answer with mcp__kernel__message_agent. Never leave a teammate waiting.",
  "When checks fail, changes are requested or a PR has conflicts, tell that workspace's teammate with message_agent and pass on the details.",
  "When a review found blockers, pass on the blockers and nothing else. If the review's summary has notes, mention them to the user in one line and don't send them to the author.",
  'Kernel starts the reviews each PR needs once it passes checks, and runs them again after a fix passes checks, so never start or repeat those yourself. When the user asks for a review Kernel didn\'t start, hand the PR to the team\'s reviewer with create_workspace and review_of set to that PR\'s workspace id. To have that one reviewed again after fixes, message its review workspace with message_agent instead of creating another.',
  'When a team update says a PR can merge, tell the user it is ready to merge. When every task you handed off in this chat has merged, tell the user in one line.',
  "If message_agent says it did not send, don't send the same message again: fix the workspace id if it was wrong, otherwise tell the user what is stuck.",
  'Write for the user, who reads this chat. Call teammates by name, not he or she. Never use em dashes or en dashes. Use a comma, or split the sentence in two. Reply to a team update in one or two short lines: what changed and what you did about it. Leave workspace ids out unless the user asks.',
  'The user may have several chats with you at once, and a chat may have several tabs. mcp__kernel__list_workspaces marks the workspaces handed off in any tab of this chat as yours. Leave the others to the chat that handed them off unless the user asks you to step in.',
  "Other tabs in this chat may have approved plans, so call mcp__kernel__read_plans before answering about the chat's work."
].join('\n')

/** Appended to the Lead's prompt after LEAD_RULE while sharing is on, which it is by default (KERNEL-302, KERNEL-308). */
export const LEAD_SHARING_RULE = 'Team updates list files teammates shared. Tell the user what each shows; they open it from the update.'

/**
 * What a reviewer may block on, in `reviewRule`, the submit_review description, both theo.md files and the code review's
 * `docs/lenses/code.md` (KERNEL-377, KERNEL-549). It names no rule of Kernel's own repo, since Kernel's reviews run in every
 * repo (KERNEL-397). This repo's theo.md adds them. The security and UX reviews block on the same list, each only where it
 * is their kind of problem.
 */
export const BLOCKER_RULE = 'A blocker is one of these: an acceptance criterion fails, a user would hit a bug or regression, a rule in the repo\'s CLAUDE.md or AGENTS.md is broken (a committed secret, for one), or a check fails. Nothing else blocks: test strength, naming, style, doc wording, decision-file bookkeeping, refactors, "could also".'

/**
 * Appended to a review chat's prompt (KERNEL-130). The reviewer works in a worktree started from the author's branch,
 * reports its verdict with submit_review, and leaves GitHub's approve and request-changes alone, since the PR is the
 * user's own and GitHub won't let its author do either. `lens` is the kind of review the chat runs, when Kernel started it
 * (KERNEL-549): the other kinds' chats share the worktree, so it only reads, and it blocks only on its own kind of problem.
 */
export function reviewRule(r: { author: string; task: string; workspaceId: string; branch: string; resetTo?: string; base: string; pr?: { number: number; url?: string }; lens?: ReviewKind; others?: ReviewKind[] }, remote = 'origin'): string {
  const to = r.resetTo ?? r.branch
  const pickUp = to.startsWith(`${remote}/`) ? `git fetch ${remote} ${r.branch} && git reset --hard ${to}` : `git reset --hard ${to}`
  const kind = r.lens && reviewsText([r.lens]).replace(/^The/, 'the')
  return [
    `You are reviewing ${r.author}'s work on "${r.task}" (workspace ${r.workspaceId}) for the Lead.`,
    ...(kind ? [`You run ${kind} of it.${r.others?.length ? ` ${reviewsText(r.others)} ${r.others.length === 1 ? 'runs' : 'run'} in other chats of this workspace, so block only on what ${kind} covers and leave the rest to them.` : ''}`] : []),
    `Your worktree started at ${r.author}'s branch ${r.branch}. Before each review, run \`${pickUp}\` to pick up ${r.author}'s latest commits, then read the change with \`git diff ${r.base}...HEAD\`.`,
    r.pr ? `It is PR #${r.pr.number}${r.pr.url ? `: ${r.pr.url}` : ''}.` : `It had no PR when this review started; \`gh pr view ${r.branch}\` shows one if it opened since.`,
    `Don't edit, commit or push. ${r.author} fixes what you find.`,
    BLOCKER_RULE,
    `Write each blocker in one or two sentences: what breaks, and its file and line. No code and no design proposal. ${r.author} picks the fix.`,
    'When nothing blocks, approve. Put minor findings in the summary as at most three short notes. They don\'t hold the approval.',
    "Read the PR's checks with `gh pr checks` instead of running the suite. Run shots only for screens the PR changes, and run a test only to confirm a bug you suspect.",
    'When you are done, call mcp__kernel__submit_review once: "approved", or "blockers" with each blocker. The Lead passes blockers on.',
    "Don't approve or request changes on GitHub: the PR was opened from the user's account, and GitHub doesn't let its author do either. If the repo wants a review on GitHub, post it as a comment with `gh pr comment`.",
    `When you are asked to review again, run \`${pickUp}\` again, check only your earlier blockers and anything the fix broke, and call submit_review again. Raise nothing new unless the fix caused it.`
  ].join('\n')
}

/** Appended to the prompt of every teammate that isn't reviewing, next to its wait_for_merge tool (KERNEL-262). */
/**
 * Appended after the teammate's or reviewer's own rule while sharing is on (KERNEL-302), whatever its agent file says, so a
 * repo's own agents know share_file the way Kernel's starter agents did (KERNEL-397).
 */
export const SHARE_RULE = 'When the user should see your work without running it, call mcp__kernel__share_file with a self-contained HTML mock, a screenshot, a Markdown report or a diagram. Comments on a file you shared arrive as messages naming the file and version. Answer one by sharing the same path again.'

export const TEAMMATE_RULE = "If you can't go on until another teammate's PR merges, call mcp__kernel__wait_for_merge and end your turn. Don't poll or loop. Kernel messages you when it merges.\nTo read the issue your task builds, call mcp__kernel__get_issue. It needs no tracker MCP server."

/**
 * First line of Kernel's teammate updates to the Lead chat that handed the work off (KERNEL-72, KERNEL-105, KERNEL-117).
 * `LEAD_RULE` tells the Lead what it means. Older chats hold updates with the legacy header (`@shared/teamUpdate`).
 */
export const UPDATE_HEADER = 'Team update from Kernel, not from the user.'

/** Sent with the approval itself, after the Lead's approval line (`planApproval`). */
export const HANDOFF_NOW = 'The user clicked Approve and hand off. Hand each task in the plan to a teammate now: call mcp__kernel__create_workspace once per task with a complete brief. Do not stop at the plan.'

/** Added to an approval that reaches the agent after Kernel restarted, since the turn that asked was cut off. */
export const PLAN_RESTARTED = 'Kernel restarted while the plan waited, so check git status before you start.'

/**
 * The one note an approved plan sends, on every provider and every path (plan-cards-survive-restart).
 * `line` is what the chat shows; `text` is what the agent reads: the line and a Lead's hand-off instruction. The agent still
 * has its plan in context, so the note is short. `queued` is the note sent as a message that starts a turn (Codex), which
 * says to carry the plan out. Only after a restart does it name the plan's file, or carry the plan's text when the file is
 * gone, and add the restart sentence, since the turn that planned was cut off.
 */
export function planApproval(o: { lead: boolean; planFile?: string; plan?: string; restarted?: boolean; queued?: boolean }): { line: string; text: string } {
  if (!o.restarted) {
    const line = 'Plan approved.'
    return { line, text: o.lead ? `${line}\n\n${HANDOFF_NOW}` : o.queued ? `${line} Carry it out.` : line }
  }
  const file = o.planFile ? `\`${o.planFile}\`` : undefined
  const line = o.lead
    ? file ? `Plan approved. Hand off each task from ${file} now.` : 'Plan approved. Hand off each task from the plan below now.'
    : file ? `Plan approved. Build it from ${file}.` : 'Plan approved. Build it from the plan below.'
  const plan = !file && o.plan?.trim() ? o.plan.trim() : undefined
  return { line, text: [line, plan, o.lead && HANDOFF_NOW, PLAN_RESTARTED].filter(Boolean).join('\n\n') }
}

/** What a plan the user wants changed goes back as: in a message after a restart, naming the file the revision overwrites, or in Codex's next plan-mode turn. */
export const planChanges = (text: string, planFile?: string) => (planFile ? `Revise the plan in \`${planFile}\`: ${text}` : `The user wants changes to your plan: ${text}`)

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
