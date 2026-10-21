import { useRef } from 'react'
import type { ChangedFile, PrCheck, PrInfo, Workspace } from '@shared/types'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, EmptyList, Icon, Spinner, useBusy } from '../../../ui'
import { spotKey, useKeptScroll } from '../../../ui/keptScroll'
import { stripRemote } from '../../settings/remote'
import { useRemote } from '../../settings/useSettings'
import { attempt } from '../MessageActions'
import { Criteria } from '../pr/Criteria'
import { LocalMergeInfo } from '../pr/LocalMerge'
import { PrActionButton } from '../pr/PrTitleBar'
import { OUTSIDE_THE_REPO, type LocalStand } from '../pr/model'
import { reviewStages } from '../pr/prStage'
import { request, usePrActions, usePrFacts } from '../pr/usePr'
import { useLocalMerge } from '../pr/useLocalMerge'

type CheckState = 'ok' | 'run' | 'idle' | 'fail' | 'warn'
interface CheckRow { state: CheckState; label: string; meta?: string; dim?: boolean }

const ciState: Record<PrCheck['state'], CheckState> = { pass: 'ok', fail: 'fail', running: 'run', queued: 'run', skipped: 'idle' }

/** A check's state as the Pull request tab draws it (Pen 9.8): a plain check, a cross, a dash, or the checker loader while it runs. A passing one is green and a failing one red, and nothing is amber but the warning triangle. */
function CheckIcon({ state }: { state: CheckState }) {
  if (state === 'run') return <span className="check-spin"><Spinner label="Running" pattern="checker" /></span>
  const icon = state === 'ok' ? 'check' : state === 'fail' ? 'close' : state === 'warn' ? 'warning' : 'minus'
  return <span className="pr-check-ico" data-state={state}><Icon name={icon} size={14} /></span>
}

/**
 * One CI row. A check that doesn't decide the PR says so, and its failure shows the muted warning instead of the red x,
 * since the PR can still merge (KERNEL-388).
 */
export function checkRow(c: PrCheck): CheckRow {
  const word = c.state === 'running' || c.state === 'queued' ? 'running' : c.state === 'fail' ? 'failed' : c.meta
  if (!c.optional) return { state: ciState[c.state], label: c.name, meta: word }
  return { state: c.state === 'fail' ? 'warn' : ciState[c.state], label: c.name, meta: word ? `${word}, optional` : 'optional' }
}

/**
 * `remote` is the project's git remote, which a base ref like `origin/main` names. `local` is set for a branch that merges on the Mac,
 * which has no PR and no checks: Git says how it stands against its base and CI reads "No checks reported", as it does for a PR with none (KERNEL-478).
 */
export function checkGroups(ws: Workspace, changes: ChangedFile[], pr?: PrInfo, remote = 'origin', local?: { stand: LocalStand; base: string }): { title: string; rows: CheckRow[] }[] {
  const hasPr = !!ws.prNumber
  const base = local?.base ?? stripRemote(ws.baseRef, remote)
  const merged = ws.prState === 'merged'
  const conflict = ws.prState === 'conflict'
  const files = `${changes.length} ${changes.length === 1 ? 'file' : 'files'} changed`
  const behind = local?.stand === 'behind' ? pr?.local?.behind ?? 0 : 0
  const git: CheckRow = conflict
    ? { state: 'warn', label: `${pr?.conflicts.length || 1} ${(pr?.conflicts.length || 1) === 1 ? 'conflict' : 'conflicts'} with ${base}` }
    : behind
      ? { state: 'idle', label: `${files}, ${behind} behind ${base}` }
      : { state: 'ok', label: merged ? `Merged into ${base}` : `${files}, up to date with ${base}` }
  if (local) return [{ title: 'Git', rows: [git] }, { title: 'CI', rows: [{ state: 'idle', label: 'No checks reported', dim: true }] }]
  const prRow: CheckRow = hasPr
    ? { state: conflict ? 'warn' : 'ok', label: `#${ws.prNumber}${ws.prTitle ? ` ${ws.prTitle}` : ''}`, meta: merged ? 'merged' : ws.prState === 'closed' ? 'closed' : 'open' }
    : { state: 'idle', label: 'No pull request yet', meta: '⌘⇧P', dim: true }
  const ci: CheckRow[] = !hasPr
    ? [{ state: 'idle', label: 'Runs after the PR opens', dim: true }]
    : pr?.checks.length
      ? pr.checks.map(checkRow)
      : [{ state: ws.prState === 'checks' ? 'run' : 'idle', label: ws.prState === 'checks' ? 'Checks running' : 'No checks reported', dim: ws.prState !== 'checks' }]
  const groups = [{ title: 'Git', rows: [git] }, { title: 'Pull request', rows: [prRow] }, { title: 'CI', rows: ci }]
  const todos = (pr?.comments ?? []).map((c): CheckRow => ({ state: c.resolved ? 'ok' : 'idle', label: c.body, meta: c.resolved ? '' : c.association === 'outside' ? OUTSIDE_THE_REPO : 'from review', dim: !c.resolved }))
  return todos.length ? [...groups, { title: 'Todos', rows: todos }] : groups
}

/** The PR's Checks page on GitHub, or nothing for a branch with no PR, or one that merges on the Mac. */
export const checksUrl = (prUrl?: string) => (prUrl ? `${prUrl.replace(/\/+$/, '')}/checks` : undefined)

/** "4 passed", or what runs now: the count the Checks header ends on. */
const checksSummary = (checks: PrCheck[]) => {
  const running = checks.filter((c) => c.state === 'running' || c.state === 'queued').length
  const failed = checks.filter((c) => c.state === 'fail' && !c.optional).length
  const passed = checks.filter((c) => c.state === 'pass' || c.state === 'skipped').length
  return failed ? `${failed} failed` : running ? `${passed} of ${checks.length} passed` : `${passed} passed`
}

/** The state's word in the pill under the title, and its icon: Open, Draft, Merged or Closed. */
const PILL = { open: { word: 'Open', icon: 'pr' }, draft: { word: 'Draft', icon: 'prDraft' }, merged: { word: 'Merged', icon: 'merged' }, closed: { word: 'Closed', icon: 'prClosed' } } as const

/**
 * The Pull request tab (Pen 10.5): the pull request's title and number with its one action at the right, where it stands and what it merges into, its checks by name (no
 * durations), and the acceptance criteria with the evidence behind each. A branch with no pull request says Checks run after it opens, with Create PR.
 */
export function PullRequestTab({ ws, changes }: { ws: Workspace; changes: ChangedFile[] }) {
  const pr = useStore((s) => s.prs[ws.id])
  const local = useLocalMerge(ws)
  const remote = useRemote(ws.projectId)
  const facts = usePrFacts(ws)
  const { title } = reviewStages(ws, facts, true)
  const run = usePrActions(ws, { key: title?.button?.id, archivable: ws.prState === 'merged' || ws.prState === 'closed' })
  const [busy, create] = useBusy<'create'>()
  const scroller = useRef<HTMLDivElement>(null)
  useKeptScroll(scroller, { key: spotKey.panel(ws.id, 'pr'), ready: true })
  const url = pr?.url || ws.prUrl
  const hasPr = !!ws.prNumber
  const added = changes.reduce((n, f) => n + f.added, 0)
  const removed = changes.reduce((n, f) => n + f.removed, 0)
  const base = stripRemote(ws.baseRef, remote)
  const pill = PILL[ws.prState === 'merged' ? 'merged' : ws.prState === 'closed' ? 'closed' : ws.prState === 'draft' ? 'draft' : 'open']

  if (!hasPr && !local) {
    return (
      <div className="pr-tab">
        <div className="pr-card-head"><span className="pr-card-title">Checks</span></div>
        <EmptyList icon="pr" title="No pull request yet" action={<Button busy={busy === 'create'} busyLabel="Creating PR" onClick={() => void create('create', async () => { try { await request.create(ws.id) } catch (e) { actions.ui.toast({ title: 'Could not create the PR', sub: String(e instanceof Error ? e.message : e) }) } })}>Create PR</Button>}>Checks run after the PR opens.</EmptyList>
      </div>
    )
  }
  const checks = pr?.checks ?? []
  const first = checks.find((c) => c.state === 'running' || c.state === 'queued')
  const button = title?.button && (title.button.id === 'merge' && !local ? { ...title.button, label: 'Merge PR' } : title.button)
  return (
    <div className="pr-tab">
      <div ref={scroller} className="panel-scroll pr-body">
        <header className="pr-top">
          <div className="pr-title-row">
            <span className="pr-title-ico" data-state={ws.prState === 'merged' ? 'merged' : ws.prState === 'closed' ? 'closed' : 'open'}><Icon name={ws.prState === 'merged' ? 'merged' : ws.prState === 'closed' ? 'prClosed' : ws.prState === 'draft' ? 'prDraft' : 'pr'} size={16} /></span>
            <h2 className="pr-title ellipsis">{ws.prTitle ?? pr?.title ?? ws.title ?? ws.name}</h2>
            {ws.prNumber ? (url
              ? <button type="button" className="pr-num mono" aria-label={`Open PR ${ws.prNumber} on GitHub`} onClick={() => void attempt('Could not open GitHub', () => call('system.openExternal', { url }))}>#{ws.prNumber}</button>
              : <span className="pr-num mono">#{ws.prNumber}</span>) : null}
            <span className="grow" />
            {button && <PrActionButton button={button} run={run} />}
          </div>
          <div className="pr-meta">
            <span className="pr-pill" data-state={pill.word.toLowerCase()}><Icon name={pill.icon} size={12} />{local ? 'Merges on this Mac' : pill.word}</span>
            <span className="mono ellipsis">{ws.branch} into {base}</span>
            {changes.length > 0 && <><span className="pr-sep">·</span><span className="pr-stat"><span className="add">+{added}</span> <span className="del">-{removed}</span></span></>}
          </div>
        </header>

        {local && <LocalMergeInfo ws={ws} />}

        <section className="pr-section" aria-label="Checks">
          <div className="pr-card-head">
            <span className="pr-card-title">Checks</span>
            <span className="grow" />
            {checks.length > 0 && <span className="pr-card-sub">{checksSummary(checks)}</span>}
          </div>
          {local
            ? checkGroups(ws, changes, pr, remote, local).slice(0, 1).flatMap((g) => g.rows).map((r, i) => (
              <div key={i} className="pr-row"><CheckIcon state={r.state} /><span className="pr-name ellipsis">{r.label}</span></div>
            ))
            : checks.length
              ? checks.map((c) => {
                const r = checkRow(c)
                return (
                  <div key={c.name} className="pr-row">
                    <CheckIcon state={r.state} />
                    <span className="pr-name ellipsis">{c.name}</span>
                    {c.optional && <span className="pr-sub">optional</span>}
                  </div>
                )
              })
              : (
                <EmptyList icon="checkCircle" title="No checks reported" action={url ? <Button icon="ext" onClick={() => void attempt('Could not open GitHub', () => call('system.openExternal', { url }))}>Open on GitHub</Button> : undefined}>GitHub hasn’t reported a check on this pull request.</EmptyList>
              )}
          {first && <div className="pr-row pr-wait"><Spinner label={null} pattern="checker" /><span className="pr-sub">Waiting for {first.name}</span></div>}
        </section>
        <Criteria ws={ws} />
      </div>
    </div>
  )
}
