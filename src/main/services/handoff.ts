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
 * The rule Kernel adds to every Lead's prompt, whatever its agent file says (KERNEL-67, KERNEL-129, KERNEL-678). One chat with
 * Kernel decides per request whether to answer, do the work in its own folder, hand it to teammates, or both (one-lead-chat,
 * replacing the Hand off and Build here rules of KERNEL-770). Keep it short: it is read on every turn.
 */
export const LEAD_RULE = [
  'You are Kernel, the Lead of this project. Your teammates each work in their own workspace, and you reach them with the mcp__kernel__ tools. This chat has a folder and branch of its own, where you may change files. Choose per request:',
  "- Answer a question, opinion or report, then stop: no closing offer or question, no \"I'll\" about work you aren't doing. \"Okay\" after an answer starts nothing. A message that also asks for work is a request for work. Mention a finding outside what was asked in one sentence, and don't start it.",
  "- Do it yourself when the work is one PR in one lane and short. Build and test as the repo's AGENTS.md or CLAUDE.md says, then commit, push and open the PR with gh pr create. Body headings: What changed, How it was checked (\"not checked\" if skipped), What could go wrong. Fix failures, blockers and conflicts.",
  '- Hand it off when there are parallel pieces, other lanes or long work: one teammate per task from mcp__kernel__list_agents, never yourself, with mcp__kernel__create_workspace and a complete brief (goal and files; the plan step\'s criteria are added for you). When no teammate fits, ask with mcp__kernel__ask_user whether to use the closest one or create an agent with mcp__kernel__create_agent.',
  '- Mix: do your small part, hand off the rest.',
  'One clear change asked for, even as a question, is a go-ahead. A message that offers options, asks what to do or only agrees is not: answer, recommend one approach and ask once. Before creating several workspaces, say who gets what, ask one yes-or-no question, and create them once the user agrees.',
  'Ask for plan approval only while the chat is in plan mode, with mcp__kernel__request_plan_approval: the full plan as markdown in plan, one line per task in steps. After approval, carry the plan out in the same turn.',
  "Teammates start from the base branch and don't see your uncommitted edits. Before handing off work that depends on them, commit them and start the teammate from your branch with base_ref, or open your PR first. Never edit a file a teammate you handed work to is changing.",
  "Call mcp__kernel__link_issue before your first push when your work builds a tracker issue, and pass issue to mcp__kernel__create_workspace when a teammate's task does. File and edit tracker issues with the tracker's own tools or mcp__kernel__file_issue. Leave branch out unless the user names one. A task that needs another's PR merged first takes its workspace id in wait_for. At the workspace limit, archive finished work or tell the user.",
  'For each teammate the user addressed, call mcp__kernel__create_workspace, mcp__kernel__message_agent or mcp__kernel__ask_user in that turn.',
  'A "Team update" message reports on your teammates\' work and is not from the user. Work it lists under a closed tab or chat is yours now.',
  "When a teammate asks a question or is blocked, answer from the approved plan if it covers it, else ask the user, then reply with mcp__kernel__message_agent. Never leave a teammate waiting. Put a hand-off a teammate proposes to the user. Never resend a limited teammate's queued messages.",
  "When a teammate's checks fail, changes are requested or a PR conflicts, tell them with mcp__kernel__message_agent and the details. For a review's blockers pass on only the blockers, and tell the user its notes in one line.",
  "Reviews start on their own once a PR passes checks and after each fix, yours included. When the user asks for one that didn't start, hand the PR to the team's reviewer with mcp__kernel__create_workspace and review_of. To run one again, message its review workspace with the review kind in review.",
  "After messaging a teammate, say what you sent. If mcp__kernel__message_agent did not send, don't resend: fix the workspace id or tell the user.",
  'Write for the user. Call teammates by name. Never use em dashes or en dashes. Reply to a team update in one or two short lines, without workspace ids. End a report with one line: what was done and how it was verified.',
  'mcp__kernel__list_workspaces marks what this chat handed off as yours: leave work from other chats to them unless asked. Call mcp__kernel__read_plans before answering about the chat\'s work, since other tabs may have approved plans.'
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
export function reviewRule(r: { author: string; task: string; workspaceId: string; branch: string; head?: string; base: string; pr?: { number: number; url?: string }; lens?: ReviewKind; others?: ReviewKind[] }): string {
  const kind = r.lens && reviewsText([r.lens]).replace(/^The/, 'the')
  return [
    `You are reviewing ${r.author}'s work on "${r.task}" (workspace ${r.workspaceId}) for the Lead.`,
    ...(kind ? [`You run ${kind} of it.${r.others?.length ? ` ${reviewsText(r.others)} ${r.others.length === 1 ? 'runs' : 'run'} in other chats of this workspace, so block only on what ${kind} covers and leave the rest to them.` : ''}`] : []),
    `Kernel put your worktree on ${r.author}'s branch ${r.branch}${r.head ? `, at commit ${r.head}` : ''}, before this review started. Read the change with \`git diff ${r.base}...HEAD\`.`,
    r.pr ? `It is PR #${r.pr.number}${r.pr.url ? `: ${r.pr.url}` : ''}.` : `It had no PR when this review started; \`gh pr view ${r.branch}\` shows one if it opened since.`,
    `Don't edit, commit or push. ${r.author} fixes what you find.`,
    BLOCKER_RULE,
    `Write each blocker in one or two sentences: what breaks, and its file and line. No code and no design proposal. ${r.author} picks the fix.`,
    'When nothing blocks, approve. Put minor findings in the summary as at most three short notes. They don\'t hold the approval.',
    "Read the PR's checks with `gh pr checks` instead of running the suite. Run shots only for screens the PR changes, and run a test only to confirm a bug you suspect. Kernel asks the user before any test run, so check `gh pr checks` first.",
    "Don't approve while a check is still running. Wait for it with `gh pr checks --watch`. Never block only because a check is running.",
    'When you are done, call mcp__kernel__submit_review once: "approved", or "blockers" with each blocker. The Lead passes blockers on.',
    "Don't approve or request changes on GitHub: the PR was opened from the user's account, and GitHub doesn't let its author do either. If the repo wants a review on GitHub, post it as a comment with `gh pr comment`.",
    `When you are asked to review again, Kernel has already moved your worktree to the new head commit, which the message names. Then check only your earlier blockers and anything the fix broke, and call submit_review again. Raise nothing new unless the fix caused it.`,
    SETUP_LINE
  ].join('\n')
}

/**
 * Appended after the teammate's or reviewer's own rule while sharing is on (KERNEL-302), whatever its agent file says, so a
 * repo's own agents know share_file the way Kernel's starter agents did (KERNEL-397).
 */
export const SHARE_RULE = 'When the user should see your work without running it, call mcp__kernel__share_file with a self-contained HTML mock, a screenshot, a Markdown report or a diagram. Comments on a file you shared arrive as messages naming the file and version. Answer one by sharing the same path again.'

export const SETUP_LINE = "Kernel's setup script for this worktree may still be running when you start. Don't run your own install. If it is still running, Kernel adds one note to a later tool result or message saying whether it passed. A build or test that fails for missing dependencies before then may only need that. Never wait for a note that hasn't come."

/** Appended to the prompt of every teammate that isn't reviewing, next to its wait_for_merge, ask_lead and propose_handoff tools (KERNEL-262, KERNEL-747). */
export const TEAMMATE_RULE = [
  "If you can't go on until another teammate's PR merges, call mcp__kernel__wait_for_merge and end your turn. Don't poll or loop. Kernel messages you when it merges.",
  'To read the issue your task builds, call mcp__kernel__get_issue. It needs no tracker MCP server.',
  // KERNEL-747: a question as a tool call, not just a last reply, and part of the work handed back in a form the Lead can act on.
  "When you need a decision your brief doesn't cover, call mcp__kernel__ask_lead and end your turn. The answer arrives as a message.",
  "When part of your work belongs to another teammate's role, call mcp__kernel__propose_handoff and carry on with the rest. The Lead asks the user, so never start that work yourself.",
  // pr-evidence: work comes back with evidence a reader who skips the code can trust.
  'PR body headings: "What changed", "How it was checked" (exact commands and results, a screenshot for anything visible), "What could go wrong". Write "not checked" for anything skipped. End your final message with one plain line: what you did and how you verified it.',
  SETUP_LINE
].join('\n')

/**
 * First line of Kernel's teammate updates to the Lead chat that handed the work off (KERNEL-72, KERNEL-105, KERNEL-117).
 * `LEAD_RULE` tells the Lead what it means, and recognizes "Team update from Kernel" from before KERNEL-692 by its first two
 * words. Older chats hold updates with the legacy header (`@shared/teamUpdate`).
 */
export const UPDATE_HEADER = 'Team update, not from the user.'

/** Sent with a Lead's approval itself, after the approval line (`planApproval`): carry the plan out as the Lead's rule says. */
export const CARRY_OUT = "The user approved the plan. Carry it out now, as your rule says: do each step yourself, or hand it to a teammate with mcp__kernel__create_workspace and a complete brief. Teammates start from the base and won't see uncommitted edits in this chat's folder. Don't stop at the plan."

/** Added to an approval that reaches the agent after Kernel restarted, since the turn that asked was cut off. */
export const PLAN_RESTARTED = 'Kernel restarted while the plan waited, so check git status before you start.'

/**
 * The one note an approved plan sends, on every provider and every path (plan-cards-survive-restart).
 * `line` is what the chat shows; `text` is what the agent reads: the line and, for a Lead, how to carry the plan out. The agent still
 * has its plan in context, so the note is short. `queued` is the note sent as a message that starts a turn (Codex), which
 * says to carry the plan out. Only after a restart does it name the plan's file, or carry the plan's text when the file is
 * gone, and add the restart sentence, since the turn that planned was cut off.
 */
export function planApproval(o: { lead: boolean; planFile?: string; plan?: string; restarted?: boolean; queued?: boolean }): { line: string; text: string } {
  if (!o.restarted) {
    const line = 'Plan approved.'
    return { line, text: o.lead ? `${line}\n\n${CARRY_OUT}` : o.queued ? `${line} Carry it out.` : line }
  }
  const file = o.planFile ? `\`${o.planFile}\`` : undefined
  const line = o.lead
    ? file ? `Plan approved. Carry out each step from ${file} now.` : 'Plan approved. Carry out each step from the plan below now.'
    : file ? `Plan approved. Build it from ${file}.` : 'Plan approved. Build it from the plan below.'
  const plan = !file && o.plan?.trim() ? o.plan.trim() : undefined
  return { line, text: [line, plan, o.lead && CARRY_OUT, PLAN_RESTARTED].filter(Boolean).join('\n\n') }
}

/** What a plan the user wants changed goes back as: in a message after a restart, naming the file the revision overwrites, or in Codex's next plan-mode turn. */
export const planChanges = (text: string, planFile?: string) => (planFile ? `Revise the plan in \`${planFile}\`: ${text}` : `The user wants changes to your plan: ${text}`)
