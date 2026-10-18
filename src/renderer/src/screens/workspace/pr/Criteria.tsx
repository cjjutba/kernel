import { useEffect, useState } from 'react'
import type { CriterionEvidence, EvidenceLink, PrEvidence, Workspace } from '@shared/types'
import { call } from '../../../api'
import { useStore } from '../../../store'
import { Icon } from '../../../ui'
import { providerLabel } from '../composer/providerModels'
import './pr.css'

/** The word a criterion shows. Evidence from an older commit no longer counts, so a criterion with only that reads Stale. Only the reviewer's judgment behind it reads "Reviewer says met", never Passed (KERNEL-1078). */
export const criterionWord = (c: Pick<CriterionEvidence, 'status' | 'stale'>) => (c.status === 'unverified' && c.stale ? 'Stale' : c.status === 'passed' ? 'Passed' : c.status === 'failed' ? 'Failed' : c.status === 'reviewer-met' ? 'Reviewer says met' : 'Unverified')

const GLYPH = { Passed: 'check', Failed: 'close', Unverified: 'minus', Stale: 'minus', 'Reviewer says met': 'check' } as const
const STATE_KEY = { Passed: 'passed', Failed: 'failed', Unverified: 'unverified', Stale: 'stale', 'Reviewer says met': 'reviewer-met' } as const

/** The provider of the newest verdict that names one, for "Reviewed by Codex". Verdicts from before provider was kept have none. */
export function reviewedBy(ws: Pick<Workspace, 'reviews' | 'prNumber'>): string | undefined {
  const mine = (ws.reviews ?? []).filter((v) => v.provider && (!v.prNumber || v.prNumber === ws.prNumber))
  const latest = mine.reduce<(typeof mine)[number] | undefined>((a, b) => (!a || b.ts > a.ts ? b : a), undefined)
  return latest?.provider ? providerLabel(latest.provider) : undefined
}

function Link({ l }: { l: EvidenceLink }) {
  const open = l.url ? <button type="button" className="crit-link" aria-label={`Open evidence: ${l.label}`} onClick={() => void call('system.openExternal', { url: l.url as string })}><span>{l.label}</span><Icon name="ext" size={12} /></button> : <span>{l.label}</span>
  return (
    <li className="crit-ev" data-stale={l.stale || undefined}>
      {open}
      {l.judgedBy && <span className="crit-tag">Reviewer’s judgment</span>}
      {l.stale && <span className="crit-tag">Older commit</span>}
    </li>
  )
}

function Criterion({ c }: { c: CriterionEvidence }) {
  const word = criterionWord(c)
  return (
    <li className="crit">
      <div className="crit-head">
        <span className="crit-state" data-state={STATE_KEY[word as keyof typeof STATE_KEY]}><Icon name={GLYPH[word as keyof typeof GLYPH]} size={12} />{word}</span>
        <span className="crit-text">{c.text}</span>
      </div>
      {c.links.length > 0 && <ul className="crit-evs" aria-label={`Evidence for ${c.text}`}>{c.links.map((l) => <Link key={l.id} l={l} />)}</ul>}
    </li>
  )
}

/** The acceptance criteria of the plan step this PR was handed, each with its state and the events behind it (KERNEL-1066). Without any, just the reviewer line. */
export function Criteria({ ws }: { ws: Workspace }) {
  const pr = useStore((s) => s.prs[ws.id])
  const [evidence, setEvidence] = useState<PrEvidence | null>(null)
  const by = reviewedBy(ws)
  // The engine weighs the evidence again on every PR read and review, so a change of head, checks or verdicts asks again.
  const stamp = [pr?.head, pr?.checks.map((c) => `${c.name}:${c.state}`).join(), ws.reviews?.map((v) => `${v.ts}`).join()].join('|')
  useEffect(() => {
    if (!ws.prNumber) return
    let live = true
    call('evidence.pr', { workspaceId: ws.id }).then((e) => { if (live) setEvidence(e) }).catch(() => undefined)
    return () => { live = false }
  }, [ws.id, ws.prNumber, stamp])
  // A PR whose step had no criteria still says which model reviewed it (KERNEL-1077).
  if (!evidence?.criteria.length) return by ? <span className="muted t-meta">Reviewed by {by}</span> : null
  return (
    <section className="col gap-4" aria-label="Acceptance criteria">
      <div className="row gap-10">
        <span className="muted t-meta t-medium">Acceptance criteria</span>
        <span className="grow" />
        {by && <span className="muted t-meta">Reviewed by {by}</span>}
      </div>
      <ul className="crit-list">{evidence.criteria.map((c) => <Criterion key={c.index} c={c} />)}</ul>
      {evidence.commentUrl && <button type="button" className="crit-link" aria-label="Open the evidence comment on GitHub" onClick={() => void call('system.openExternal', { url: evidence.commentUrl as string })}><span>Evidence comment on GitHub</span><Icon name="ext" size={12} /></button>}
    </section>
  )
}
