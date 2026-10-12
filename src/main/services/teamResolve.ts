import { basename } from 'node:path'
import type { AgentDef, AgentWarning, RosterAdvice, TeamConfig } from '@shared/types'
import { KERNEL_LEAD, KERNEL_REVIEWER, NO_REVIEWER, RESERVED_AGENT_IDS } from '@shared/team'
import type { Builtins } from './builtins'
import { canOpenPr, toolName } from './agentTools'
import { isUnreadable } from './agents'

/** Room setup asks for a roster when a room has more agent files than this (KERNEL-465). */
export const ROSTER_LIMIT = 12

/** Words that say an agent works a task through to a pull request. "Merge request" is GitLab's name for one. */
const PR_WORKFLOW = /\b(pull[- ]?requests?|PRs?|merge[- ]requests?|branch(es)?|worktrees?)\b/i

/**
 * An agent file written to be called as a subagent, with no pull request workflow (KERNEL-465): it names neither Edit nor
 * Write, and neither its description nor its prompt mentions a branch, a pull request or a worktree. Collections of Claude
 * Code subagents are mostly these, and they have no tools line, which would otherwise make every one of them a teammate.
 */
export function writtenAsSubagent(a: Pick<AgentDef, 'tools' | 'description' | 'prompt'>): boolean {
  return !a.tools?.some((t) => ['Edit', 'Write'].includes(toolName(t))) && !PR_WORKFLOW.test(`${a.description}\n${a.prompt}`)
}

/** Whether an agent takes tasks when `[team]` says nothing about it: its tools can open a pull request, and it isn't written as a subagent. */
export function takesTasksByDefault(a: Pick<AgentDef, 'tools' | 'disallowedTools' | 'description' | 'prompt'>): boolean {
  return canOpenPr(a.tools, a.disallowedTools) && !writtenAsSubagent(a)
}

/**
 * What Room setup reads to ask for a roster (KERNEL-465), from the team resolved without one. Kernel suggests the agents
 * that take tasks. The Lead and the reviewer are on the team whatever the roster says.
 */
export function adviseRoster(agents: AgentDef[], config?: TeamConfig): RosterAdvice {
  const files = agents.filter((a) => !a.builtIn)
  return { agents: files.length, needed: files.length > ROSTER_LIMIT && !config?.roster?.length, suggested: files.filter((a) => a.member).map((a) => a.id) }
}

/**
 * Where a room's Lead and reviewer came from, for `team.resolved` (KERNEL-397). A reviewer from `builtin` is no agent:
 * the room has no reviewer of its own, and Kernel's code review runs (KERNEL-553).
 */
export interface Resolved {
  agents: AgentDef[]
  leadFrom: 'file' | 'setting' | 'builtin' | 'none'
  reviewerFrom: 'file' | 'setting' | 'builtin'
}

/**
 * A room's team (KERNEL-397): its agent files, what `[team]` overrides, and Kernel's own Rowan when the files have no Lead.
 * Exactly one agent leads, at most one reviews, and every file agent either takes tasks or doesn't.
 * - Lead: `[team] lead`, else a file marked Lead (the first by name when several are), else Kernel's Rowan.
 * - Reviewer: `[team] reviewer`, else the first other file whose role says review, else none. With no reviewer, Kernel's
 *   code review runs, unless `[team] reviewer` is `none`. `kernel-reviewer` names that code review (KERNEL-553).
 * - Takes tasks: `[team] members` and `helpers` decide, else whether its tools can open a pull request and it isn't
 *   written as a subagent (KERNEL-465).
 * - On the team: every file, or only those `[team] roster` lists, plus the Lead and the reviewer. They are picked from every
 *   file first, so a roster never changes who leads or reviews (KERNEL-465).
 * A file with a reserved id, or the same id as an earlier file, is left out with a warning. A file Kernel can't read stays
 * on the team with its error, but never leads, reviews or takes a task (KERNEL-451). A plugin agent leads or reviews only
 * when `[team]` names it, since a plugin brings its agents to every room (KERNEL-463). The Lead comes first, then by name.
 */
export function resolveTeam(o: { files: AgentDef[]; config?: TeamConfig; builtins: Builtins }): Resolved {
  const cfg = o.config ?? {}
  const warnings = new Map<string, AgentWarning[]>()
  const warn = (id: string | undefined, w: AgentWarning) => { if (id) warnings.set(id, [...(warnings.get(id) ?? []), w]) }

  // Files in name order, so the same folder always resolves the same way. A file Kernel can read keeps its id over one it can't.
  const byFile = [...o.files].sort((a, b) => Number(isUnreadable(a)) - Number(isUnreadable(b)) || basename(a.file).localeCompare(basename(b.file)))
  const files: AgentDef[] = []
  const skipped: string[] = []
  for (const a of byFile) {
    if (RESERVED_AGENT_IDS.includes(a.id)) { skipped.push(basename(a.file)); continue }
    const first = files.find((f) => f.id === a.id)
    if (first) { warn(first.id, { kind: 'duplicate-id', detail: basename(a.file) }); continue }
    files.push(a)
  }
  const byName = (a: AgentDef, b: AgentDef) => a.name.localeCompare(b.name)
  const named = (id: string | undefined) => (id ? files.find((a) => a.id === id && !isUnreadable(a)) : undefined)

  // The Lead.
  let lead: AgentDef | undefined
  let leadFrom: Resolved['leadFrom'] = 'none'
  if (cfg.lead === KERNEL_LEAD && o.builtins.lead) { lead = o.builtins.lead; leadFrom = 'setting' }
  else if (named(cfg.lead)) { lead = named(cfg.lead); leadFrom = 'setting' }
  else if (cfg.lead) warn('$lead', { kind: 'setting-missing', detail: `lead = "${cfg.lead}"` })
  const marked = files.filter((a) => a.lead && a.origin !== 'plugin').sort(byName)
  if (!lead && marked.length) { lead = marked[0]; leadFrom = 'file' }
  if (!lead && o.builtins.lead) { lead = o.builtins.lead; leadFrom = 'builtin' }
  for (const a of marked) if (a !== lead) warn(a.id, { kind: 'second-lead', detail: lead?.name })

  // The reviewer, never the Lead. `none` and Kernel's code review are no agent.
  let reviewer: AgentDef | undefined
  let reviewerFrom: Resolved['reviewerFrom'] = 'builtin'
  const noAgent = cfg.reviewer === NO_REVIEWER || cfg.reviewer === KERNEL_REVIEWER
  if (noAgent) reviewerFrom = 'setting'
  else if (named(cfg.reviewer) && named(cfg.reviewer) !== lead) { reviewer = named(cfg.reviewer); reviewerFrom = 'setting' }
  else if (cfg.reviewer) warn('$reviewer', { kind: 'setting-missing', detail: `reviewer = "${cfg.reviewer}"` })
  if (!reviewer && !noAgent) {
    reviewer = files.filter((a) => a !== lead && a.origin !== 'plugin' && /\breview/i.test(a.role)).sort(byName)[0]
    if (reviewer) reviewerFrom = 'file'
  }

  const onRoster = (a: AgentDef) => !cfg.roster?.length || cfg.roster.includes(a.id) || a === lead || a === reviewer
  const team: AgentDef[] = files.filter(onRoster).map((a) => {
    // Its error is the one thing to say about it.
    if (isUnreadable(a)) return { ...a, lead: false, reviewer: false, member: false }
    const isLead = a === lead
    const isReviewer = a === reviewer
    const opens = canOpenPr(a.tools, a.disallowedTools)
    const byDefault = takesTasksByDefault(a)
    const member = isLead ? false : cfg.helpers?.includes(a.id) ? false : cfg.members?.includes(a.id) ? true : byDefault
    if (!isLead && !isReviewer && !cfg.members?.includes(a.id) && !cfg.helpers?.includes(a.id)) {
      if (!opens) warn(a.id, { kind: 'cant-open-pr' })
      else if (!byDefault) warn(a.id, { kind: 'looks-like-subagent' })
    }
    if (!a.description.trim()) warn(a.id, { kind: 'no-description' })
    if (!isLead && !a.lead && /\blead\b/i.test(a.role)) warn(a.id, { kind: 'looks-like-lead' })
    return { ...a, lead: isLead, reviewer: isReviewer, member }
  })
  if (lead?.builtIn) team.push({ ...lead, lead: true, reviewer: false, member: false })

  // A setting that names nobody, and a file Kernel skipped, are flagged on whoever holds the role, or the Lead.
  const holder = (role: '$lead' | '$reviewer') => (role === '$lead' ? lead : reviewer ?? lead)?.id
  for (const role of ['$lead', '$reviewer'] as const) for (const w of warnings.get(role) ?? []) warn(holder(role), w)
  for (const file of skipped) warn(lead?.id, { kind: 'reserved-id', detail: file })

  const agents = team
    .map((a) => (warnings.get(a.id)?.length ? { ...a, warnings: [...(a.warnings ?? []), ...warnings.get(a.id)!] } : a))
    .sort((a, b) => Number(b.lead) - Number(a.lead) || byName(a, b))
  return { agents, leadFrom, reviewerFrom }
}
