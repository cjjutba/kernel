import { basename } from 'node:path'
import type { AgentDef, AgentWarning, TeamConfig } from '@shared/types'
import { KERNEL_LEAD, KERNEL_REVIEWER, NO_REVIEWER, RESERVED_AGENT_IDS } from '@shared/team'
import type { Builtins } from './builtins'
import { canOpenPr } from './agentTools'

/** Where a room's Lead and reviewer came from, for `team.resolved` (KERNEL-397). */
export interface Resolved {
  agents: AgentDef[]
  leadFrom: 'file' | 'setting' | 'builtin' | 'none'
  reviewerFrom: 'file' | 'setting' | 'builtin' | 'none'
}

/**
 * A room's team (KERNEL-397): its agent files, what `[team]` overrides, and Kernel's own Rowan and Theo where the files
 * leave a gap. Exactly one agent leads, at most one reviews, and every file agent either takes tasks or doesn't.
 * - Lead: `[team] lead`, else a file marked Lead (the first by name when several are), else Kernel's Rowan.
 * - Reviewer: `[team] reviewer` (`none` for nobody), else the first other file whose role says review, else Kernel's Theo.
 * - Takes tasks: `[team] members` and `helpers` decide, else whether its tools can open a pull request.
 * A file with a reserved id, or the same id as an earlier file, is left out with a warning. The Lead comes first, then by name.
 */
export function resolveTeam(o: { files: AgentDef[]; config?: TeamConfig; builtins: Builtins }): Resolved {
  const cfg = o.config ?? {}
  const warnings = new Map<string, AgentWarning[]>()
  const warn = (id: string | undefined, w: AgentWarning) => { if (id) warnings.set(id, [...(warnings.get(id) ?? []), w]) }

  // Files in name order, so the same folder always resolves the same way.
  const byFile = [...o.files].sort((a, b) => basename(a.file).localeCompare(basename(b.file)))
  const files: AgentDef[] = []
  const skipped: string[] = []
  for (const a of byFile) {
    if (RESERVED_AGENT_IDS.includes(a.id)) { skipped.push(basename(a.file)); continue }
    const first = files.find((f) => f.id === a.id)
    if (first) { warn(first.id, { kind: 'duplicate-id', detail: basename(a.file) }); continue }
    files.push(a)
  }
  const byName = (a: AgentDef, b: AgentDef) => a.name.localeCompare(b.name)
  const named = (id: string | undefined) => (id ? files.find((a) => a.id === id) : undefined)

  // The Lead.
  let lead: AgentDef | undefined
  let leadFrom: Resolved['leadFrom'] = 'none'
  if (cfg.lead === KERNEL_LEAD && o.builtins.lead) { lead = o.builtins.lead; leadFrom = 'setting' }
  else if (named(cfg.lead)) { lead = named(cfg.lead); leadFrom = 'setting' }
  else if (cfg.lead) warn('$lead', { kind: 'setting-missing', detail: `lead = "${cfg.lead}"` })
  const marked = files.filter((a) => a.lead).sort(byName)
  if (!lead && marked.length) { lead = marked[0]; leadFrom = 'file' }
  if (!lead && o.builtins.lead) { lead = o.builtins.lead; leadFrom = 'builtin' }
  for (const a of marked) if (a !== lead) warn(a.id, { kind: 'second-lead', detail: lead?.name })

  // The reviewer, never the Lead.
  let reviewer: AgentDef | undefined
  let reviewerFrom: Resolved['reviewerFrom'] = 'none'
  if (cfg.reviewer === NO_REVIEWER) reviewerFrom = 'setting'
  else if (cfg.reviewer === KERNEL_REVIEWER && o.builtins.reviewer) { reviewer = o.builtins.reviewer; reviewerFrom = 'setting' }
  else if (named(cfg.reviewer) && named(cfg.reviewer) !== lead) { reviewer = named(cfg.reviewer); reviewerFrom = 'setting' }
  else if (cfg.reviewer) warn('$reviewer', { kind: 'setting-missing', detail: `reviewer = "${cfg.reviewer}"` })
  if (!reviewer && cfg.reviewer !== NO_REVIEWER) {
    reviewer = files.filter((a) => a !== lead && /\breview/i.test(a.role)).sort(byName)[0]
    if (reviewer) reviewerFrom = 'file'
    else if (o.builtins.reviewer) { reviewer = o.builtins.reviewer; reviewerFrom = 'builtin' }
  }

  const team: AgentDef[] = files.map((a) => {
    const isLead = a === lead
    const isReviewer = a === reviewer
    const opens = canOpenPr(a.tools)
    const member = isLead ? false : cfg.helpers?.includes(a.id) ? false : cfg.members?.includes(a.id) ? true : opens
    if (!isLead && !isReviewer && !opens && !cfg.members?.includes(a.id) && !cfg.helpers?.includes(a.id)) warn(a.id, { kind: 'cant-open-pr' })
    if (!a.description.trim()) warn(a.id, { kind: 'no-description' })
    if (!isLead && !a.lead && /\blead\b/i.test(a.role)) warn(a.id, { kind: 'looks-like-lead' })
    return { ...a, lead: isLead, reviewer: isReviewer, member }
  })
  for (const b of [lead, reviewer]) if (b?.builtIn) team.push({ ...b, lead: b === lead, reviewer: b === reviewer, member: false })

  // A setting that names nobody, and a file Kernel skipped, are flagged on whoever holds the role, or the Lead.
  const holder = (role: '$lead' | '$reviewer') => (role === '$lead' ? lead : reviewer ?? lead)?.id
  for (const role of ['$lead', '$reviewer'] as const) for (const w of warnings.get(role) ?? []) warn(holder(role), w)
  for (const file of skipped) warn(lead?.id, { kind: 'reserved-id', detail: file })

  const agents = team
    .map((a) => (warnings.get(a.id)?.length ? { ...a, warnings: warnings.get(a.id) } : a))
    .sort((a, b) => Number(b.lead) - Number(a.lead) || byName(a, b))
  return { agents, leadFrom, reviewerFrom }
}
