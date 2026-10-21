import { useRef } from 'react'
import type { ChangedFile, PrCheck, PrInfo, Workspace } from '@shared/types'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { AgentAvatar, Button, EmptyList, Icon, LinkButton, Spinner, useBusy } from '../../../ui'
import { spotKey, useKeptScroll } from '../../../ui/keptScroll'
import { stripRemote } from '../../settings/remote'
import { useRemote } from '../../settings/useSettings'
import { attempt } from '../MessageActions'
import { commitAge } from '../compare'
import { Criteria } from '../pr/Criteria'
import { MergeButton } from '../pr/MergeButton'
import { request } from '../pr/PrHeader'
import { OUTSIDE_THE_REPO, type LocalStand } from '../pr/model'
import { useLocalMerge } from '../pr/useLocalMerge'
import { RefreshButton } from '../PanelTools'

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

const STATE_WORD: Record<PrCheck['state'], string> = { pass: 'Passed', fail: 'Failed', running: 'Running', queued: 'Queued', skipped: 'Skipped' }

/** "3 of 4 passed", or what runs now. */
const checksSummary = (checks: PrCheck[]) => `${checks.filter((c) => c.state === 'pass').length} of ${checks.length} passed`

/** A reviewer's line in Reviews: who, what they found, and when. */
function reviewLine(v: NonNullable<Workspace['reviews']>[number], name: string) {
  if (v.verdict === 'approved') return { who: name, did: 'approved', sub: v.keptFrom ? 'approval kept from an earlier commit' : undefined }
  const n = v.blockers?.length ?? 0
  return { who: name, did: n === 1 ? 'found 1 blocker' : `found ${n || 'some'} blockers`, sub: undefined }
}

/**
 * The Pull request tab (Pen 9.8): the PR's title and where it stands, its checks, who reviewed it and the acceptance criteria. The merge button and what holds it are under them. The
 * PR header in the title bar keeps the other actions until Part 10 moves them here. A branch with no PR says Checks run after it opens, with Create PR.
 */
export function PullRequestTab({ ws, changes }: { ws: Workspace; changes: ChangedFile[] }) {
  const pr = useStore((s) => s.prs[ws.id])
  const local = useLocalMerge(ws)
  const agents = useStore((s) => s.agents[ws.projectId])
  const remote = useRemote(ws.projectId)
  const [busy, run] = useBusy<'create'>()
  const scroller = useRef<HTMLDivElement>(null)
  useKeptScroll(scroller, { key: spotKey.panel(ws.id, 'pr'), ready: true })
  const url = pr?.url || ws.prUrl
  const hasPr = !!ws.prNumber
  const added = changes.reduce((n, f) => n + f.added, 0)
  const removed = changes.reduce((n, f) => n + f.removed, 0)
  const base = stripRemote(ws.baseRef, remote)
  const word = ws.prState === 'merged' ? 'Merged' : ws.prState === 'closed' ? 'Closed' : ws.prState === 'draft' ? 'Draft' : 'Open'
  const create = () => run('create', async () => {
    try { await request.create(ws.id) } catch (e) { actions.ui.toast({ title: 'Could not create the PR', sub: String(e instanceof Error ? e.message : e) }) }
  })
  const reviews = (ws.reviews ?? []).filter((v) => !v.prNumber || v.prNumber === ws.prNumber).sort((a, b) => b.ts - a.ts)

  if (!hasPr && !local) {
    return (
      <div className="pr-tab">
        <div className="pr-card-head"><span className="pr-card-title">Checks</span></div>
        <EmptyList icon="pr" title="No pull request yet" action={<Button busy={busy === 'create'} busyLabel="Creating PR" onClick={() => void create()}>Create PR</Button>}>Checks run after the PR opens.</EmptyList>
      </div>
    )
  }
  const checks = pr?.checks ?? []
  const first = checks.find((c) => c.state === 'running' || c.state === 'queued')
  const settled = checks.length > 0 && !first
  return (
    <div className="pr-tab">
      <div ref={scroller} className="panel-scroll pr-body">
        <header className="pr-top">
          <div className="pr-title-row">
            <span className="pr-title-ico" data-state={ws.prState === 'merged' ? 'merged' : ws.prState === 'closed' ? 'closed' : 'open'}><Icon name={ws.prState === 'merged' ? 'merged' : ws.prState === 'closed' ? 'prClosed' : ws.prState === 'draft' ? 'prDraft' : 'pr'} size={14} /></span>
            <h2 className="pr-title ellipsis">{ws.prTitle ?? pr?.title ?? ws.title ?? ws.name}</h2>
            <span className="grow" />
            {url && <LinkButton variant="quiet" size="meta" onClick={() => void attempt('Could not open GitHub', () => call('system.openExternal', { url }))}>Open on GitHub<Icon name="ext" size={12} /></LinkButton>}
          </div>
          <div className="pr-meta">
            {ws.prNumber ? <span className="mono">#{ws.prNumber}</span> : null}
            <span>{local ? 'Merges on this Mac' : word}</span>
            <span className="pr-sep">·</span>
            <span className="mono ellipsis">{ws.branch}</span>
            <Icon name="arrowRight" size={12} />
            <span className="mono">{base}</span>
            {changes.length > 0 && <><span className="pr-sep">·</span><span>{changes.length} {changes.length === 1 ? 'file' : 'files'}, <span className="add">+{added}</span> <span className="del">-{removed}</span></span></>}
          </div>
        </header>

        <section className="pr-section" aria-label="Checks">
          <div className="pr-card-head">
            <span className="pr-card-title">Checks</span>
            <span className="grow" />
            {checks.length > 0 && <span className="pr-card-sub">{checksSummary(checks)}</span>}
            {hasPr && <RefreshButton ids={[ws.id]} label="Refresh checks" failTitle="Could not refresh checks" />}
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
                    {c.meta && c.state === 'pass' && <span className="pr-sub">{c.meta}</span>}
                    <span className="grow" />
                    {c.url ? <button type="button" className="pr-state-word" onClick={() => void attempt('Could not open GitHub', () => call('system.openExternal', { url: c.url as string }))}>{STATE_WORD[c.state]}</button> : <span className="pr-state-word">{STATE_WORD[c.state]}</span>}
                  </div>
                )
              })
              : (
                <EmptyList icon="checkCircle" title="No checks reported" action={url ? <Button icon="ext" onClick={() => void attempt('Could not open GitHub', () => call('system.openExternal', { url }))}>Open on GitHub</Button> : undefined}>GitHub hasn’t reported a check on this pull request.</EmptyList>
              )}
        </section>

        {reviews.length > 0 && (
          <section className="pr-section" aria-label="Reviews">
            <div className="pr-card-head"><span className="pr-card-title">Reviews</span></div>
            {reviews.map((v) => {
              const name = agents?.find((a) => a.id === v.agentId)?.name ?? v.agentId
              const line = reviewLine(v, name)
              return (
                <div key={`${v.workspaceId}:${v.lens ?? 'code'}`} className="pr-row">
                  <AgentAvatar name={name} size={16} />
                  <span className="pr-name ellipsis">{line.who} {line.did}</span>
                  {line.sub && <span className="pr-sub ellipsis">{line.sub}</span>}
                  <span className="grow" />
                  <span className="pr-sub">{commitAge(v.ts)}</span>
                </div>
              )
            })}
          </section>
        )}
        <Criteria ws={ws} />
      </div>
      <footer className="pr-foot">
        <span className="pr-foot-text">
          {first ? <><Spinner label={null} pattern="checker" />Waiting for {first.name}</> : settled ? 'All checks have run' : pr?.state === 'conflict' ? 'This branch has conflicts with its base' : ''}
        </span>
        <span className="grow" />
        {hasPr && <MergeButton ws={ws} short />}
      </footer>
    </div>
  )
}

