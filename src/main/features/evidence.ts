import type { CriterionEvidence, CriterionStatus, EvidenceLink, PlanStep, PrEvidence, PrInfo, RunEvidence, Workspace } from '@shared/types'
import { lensOf } from '@shared/merge'
import type { Handlers } from '../kernel'
import { exec } from '../services/exec'
import { Feature } from './feature'

/** What the PR comment carries, so Kernel finds its own comment again when it lost the id (KERNEL-1065). */
export const EVIDENCE_MARKER = '<!-- kernel-evidence -->'

const KEEP_PER_CRITERION = 40

type Stored = EvidenceLink & { criterion: number }
interface Saved {
  links: Stored[]
  comment?: { id: string; url?: string; body: string }
}

const metaKey = (workspaceId: string) => `evidence.${workspaceId}`
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether `text` names `name` on its own: the whole check name or path, not a piece of a longer word. */
const names = (text: string, name: string) => name.length >= 2 && new RegExp(`(^|[^\\w./-])${escape(name)}($|[^\\w/-]|\\.(?!\\w))`, 'i').test(text)

/**
 * Tracks each acceptance criterion of a plan step as passed, failed or unverified, from real events only (KERNEL-1065).
 * A criterion links to a CI check when its text names the check, to the reviewer's judgment when the verdict carries one,
 * to a touched file when its text names the path, and to a shared image when the image's note says "criterion N". Only
 * checks and the reviewer's judgment decide a status. Nothing an agent says counts, and no test command is guessed from
 * its name. A link remembers the head commit it was about and goes stale once the PR has another head.
 */
export class Evidence extends Feature {
  /** The last read of each PR, so a workspace event can weigh the evidence again without asking GitHub. */
  private infos = new Map<string, PrInfo>()
  /** What the last update looked at, so an event that changed none of it costs nothing. */
  private seen = new Map<string, string>()
  private files = new Map<string, string[]>()
  /** One update per workspace at a time, so two quick ones never post two comments. */
  private queue = new Map<string, Promise<unknown>>()

  onPrInfo(info: PrInfo) {
    if (!info.workspaceId) return
    this.infos.set(info.workspaceId, info)
    void this.update(info).catch(() => undefined)
  }

  onWorkspace(ws: Workspace) {
    const info = this.infos.get(ws.id)
    if (info && ws.prNumber) void this.update(info).catch(() => undefined)
  }

  /** The plan step this workspace was handed, with the plan it belongs to. */
  private stepOf(ws: Workspace): PlanStep | undefined {
    for (const a of this.store.approvals({ projectId: ws.projectId })) {
      if (a.kind !== 'plan') continue
      const step = a.steps?.find((s) => s.workspaceId === ws.id)
      if (step) return step
    }
    return undefined
  }

  /** The acceptance criteria of the plan step this workspace was handed, for a reviewer's brief. */
  criteriaOf(ws: Workspace): string[] { return this.stepOf(ws)?.criteria ?? [] }

  /** Files the branch changed since it left its base, read once per head. */
  private async touched(ws: Workspace, head: string | undefined): Promise<string[]> {
    const key = `${ws.id}@${head ?? ''}`
    const known = this.files.get(key)
    if (known) return known
    const r = await exec('git', ['-C', ws.path, 'diff', '--name-only', '--no-renames', `${ws.baseRef}...HEAD`]).catch(() => undefined)
    const list = r?.code === 0 ? r.stdout.split('\n').filter(Boolean) : []
    for (const k of this.files.keys()) if (k.startsWith(`${ws.id}@`)) this.files.delete(k)
    this.files.set(key, list)
    return list
  }

  private run(ws: Workspace, files: string[]): RunEvidence {
    const approvals = this.store.approvals({ workspaceId: ws.id })
      .filter((a) => a.kind !== 'plan' && (a.status === 'allowed' || a.status === 'denied' || a.status === 'answered'))
      .map((a) => ({ id: a.id, title: a.title, ...(a.toolName ? { toolName: a.toolName } : {}), status: a.status, at: a.createdAt }))
      .sort((x, y) => x.at - y.at)
    const images = this.store.sharedFiles({ workspaceId: ws.id }).filter((f) => f.kind === 'image' && f.versions.length)
      .map((f) => ({ sharedId: f.id, version: f.versions[f.versions.length - 1].n, title: f.title }))
    return { approvals, files, images }
  }

  /** The links today's events give each criterion. A criterion with none gets none: that is what unverified means. */
  private fresh(ws: Workspace, info: PrInfo, step: PlanStep, files: string[]): Stored[] {
    const head = info.head ?? ws.prHead
    const criteria = step.criteria ?? []
    const out: Stored[] = []
    const add = (criterion: number, link: Omit<EvidenceLink, 'stale'>) => out.push({ ...link, stale: false, criterion })
    criteria.forEach((text, i) => {
      for (const c of info.checks) {
        if (!names(text, c.name)) continue
        const effect = c.state === 'pass' ? 'supports' : c.state === 'fail' ? 'contradicts' : 'context'
        add(i, { id: `check:${c.name}:${head ?? ''}`, source: 'check', label: `CI check ${c.name}: ${c.state === 'pass' ? 'passed' : c.state === 'fail' ? 'failed' : c.state}`, effect, ...(head ? { commit: head } : {}), ...(c.url ? { url: c.url } : {}), ts: Date.now() })
      }
      for (const f of files) {
        const base = f.slice(f.lastIndexOf('/') + 1)
        if (!names(text, f) && !(base.includes('.') && names(text, base))) continue
        add(i, { id: `files:${f}:${head ?? ''}`, source: 'files', label: `Touched ${f}`, effect: 'context', ...(head ? { commit: head } : {}), ts: Date.now() })
      }
    })
    for (const v of ws.reviews ?? []) {
      if (v.prNumber && v.prNumber !== ws.prNumber) continue
      for (const j of v.criteria ?? []) {
        if (!Number.isInteger(j.index) || j.index < 0 || j.index >= criteria.length) continue
        const note = j.note?.trim()
        add(j.index, {
          id: `review:${v.workspaceId}:${lensOf(v)}:${j.index}:${v.sha ?? ''}`, source: 'review', judgedBy: 'reviewer',
          label: `Reviewer's judgment (${lensOf(v)}): ${j.met ? 'met' : 'not met'}${note ? `, ${note}` : ''}`,
          effect: j.met ? 'supports' : 'contradicts', ...(v.sha ? { commit: v.sha } : {}), ts: v.ts
        })
      }
    }
    for (const f of this.store.sharedFiles({ workspaceId: ws.id })) {
      if (f.kind !== 'image' || !f.versions.length) continue
      const v = f.versions[f.versions.length - 1]
      for (const m of (v.note ?? '').matchAll(/criteri(?:on|a)\s*#?(\d+)/gi)) {
        const i = Number(m[1]) - 1
        if (i >= 0 && i < criteria.length) add(i, { id: `image:${f.id}:${v.n}:${i}`, source: 'image', label: `Shared image ${f.title} (v${v.n})`, effect: 'context', ts: v.at })
      }
    }
    return out
  }

  /** A link from an older commit is stale, unless Kernel only brought the PR's branch up to date with its base after it. */
  private staleAt(ws: Workspace, head: string | undefined) {
    return (l: EvidenceLink) => !!l.commit && !!head && l.commit !== head && !(ws.baseUpdates ?? []).some((u) => u.from === l.commit && u.to === head)
  }

  /** Weighs the evidence for a PR as of now and keeps it. Posts it when the setting is on. */
  async update(info: PrInfo): Promise<PrEvidence | null> {
    const id = info.workspaceId
    const run = (this.queue.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => this.weigh(info))
    this.queue.set(id, run)
    return run
  }

  private async weigh(info: PrInfo): Promise<PrEvidence | null> {
    const ws = this.store.workspace(info.workspaceId)
    if (!ws) return null
    const head = info.head ?? ws.prHead
    const step = this.stepOf(ws)
    const files = await this.touched(ws, head)
    const run = this.run(ws, files)
    const saved = this.store.meta<Saved>(metaKey(ws.id)) ?? { links: [] }
    const stale = this.staleAt(ws, head)
    const fresh = step ? this.fresh(ws, info, step, files) : []
    const freshIds = new Set(fresh.map((l) => `${l.criterion}:${l.id}`))
    const links = [...saved.links.filter((l) => !freshIds.has(`${l.criterion}:${l.id}`)), ...fresh]
      .map((l) => ({ ...l, stale: stale(l) }))
    const criteria: CriterionEvidence[] = (step?.criteria ?? []).map((text, index) => {
      const mine = links.filter((l) => l.criterion === index).sort((a, b) => b.ts - a.ts).slice(0, KEEP_PER_CRITERION)
      const current = mine.filter((l) => !l.stale)
      const status: CriterionStatus = current.some((l) => l.effect === 'contradicts') ? 'failed' : current.some((l) => l.effect === 'supports') ? 'passed' : 'unverified'
      return { index, text, status, stale: mine.some((l) => l.stale), links: mine.map(({ criterion: _c, ...l }) => l) }
    })
    const evidence: PrEvidence = {
      workspaceId: ws.id, ...(info.number ? { prNumber: info.number } : {}), ...(head ? { head } : {}), ...(step ? { stepTitle: step.title } : {}),
      criteria, run, ...(saved.comment?.url ? { commentUrl: saved.comment.url } : {})
    }
    const keep = links.filter((l) => criteria[l.criterion] && criteria[l.criterion].links.some((k) => k.id === l.id))
    const signature = JSON.stringify([evidence, keep.length, this.settings.pr.evidenceComment])
    if (this.seen.get(ws.id) === signature) return evidence
    this.seen.set(ws.id, signature)
    const next: Saved = { links: keep, ...(saved.comment ? { comment: saved.comment } : {}) }
    this.store.saveMeta(metaKey(ws.id), next)
    if (this.settings.pr.evidenceComment && info.number && criteria.length) {
      const posted = await this.post(ws, info.number, evidence, next)
      if (posted?.url) evidence.commentUrl = posted.url
    }
    return evidence
  }

  /** Writes the one comment Kernel keeps on the PR. A body that is the same as the last one goes nowhere. */
  private async post(ws: Workspace, number: number, evidence: PrEvidence, saved: Saved) {
    const body = render(evidence)
    if (saved.comment?.body === body) return saved.comment
    const host = this.k.github
    if (!host.comment) return undefined
    try {
      const done = await host.comment(ws.path, String(number), body, { marker: EVIDENCE_MARKER, ...(saved.comment?.id ? { id: saved.comment.id } : {}) })
      const comment = { id: done.id, ...(done.url ? { url: done.url } : {}), body }
      this.store.saveMeta(metaKey(ws.id), { ...saved, comment })
      return comment
    } catch {
      // GitHub couldn't be reached: the next update tries again with the same comment.
      return undefined
    }
  }

  handlers() {
    return {
      'evidence.pr': async ({ workspaceId }) => {
        const info = await this.k.prs.getPr(workspaceId)
        return info ? this.update(info) : null
      }
    } satisfies Partial<Handlers>
  }
}

const WORD: Record<CriterionStatus, string> = { passed: 'Passed', failed: 'Failed', unverified: 'Unverified' }

/** The comment's text: each criterion with its status and the events behind it. */
export function render(e: PrEvidence): string {
  const lines = [EVIDENCE_MARKER, '### Acceptance evidence', '']
  lines.push(`${e.stepTitle ? `${e.stepTitle}. ` : ''}${e.head ? `Commit ${e.head.slice(0, 7)}.` : ''}`.trim(), '')
  for (const c of e.criteria) {
    lines.push(`- **${WORD[c.status]}${c.stale && c.status === 'unverified' ? ' (evidence is from an older commit)' : ''}**: ${c.text}`)
    for (const l of c.links) lines.push(`  - ${l.stale ? '(older commit) ' : ''}${l.label}`)
  }
  const ran = [e.run.approvals.length ? `${e.run.approvals.length} approval${e.run.approvals.length === 1 ? '' : 's'} given` : '', e.run.files.length ? `${e.run.files.length} file${e.run.files.length === 1 ? '' : 's'} touched` : '', e.run.images.length ? `${e.run.images.length} image${e.run.images.length === 1 ? '' : 's'} shared` : ''].filter(Boolean)
  lines.push('', ran.length ? `During the run: ${ran.join(', ')}.` : '', 'A criterion passes only on a CI check it names or the reviewer\'s judgment. An agent saying it is done never counts.')
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n')
}
