import { useEffect, useMemo, useState } from 'react'
import type { ChatPart, IssueSummary, ProjectTracker, TrackerKind } from '@shared/types'
import { call } from '../../api'
import { Icon, IssuePriority } from '../../icons'
import { go, useStore } from '../../store'
import { readUpNext, storeUpNext } from './upNextCache'

/** Up next shows this many issues. */
const SHOWN = 3

const NAMES: Record<TrackerKind, string> = { linear: 'Linear', github: 'GitHub' }

/**
 * Up next, on New chat's composer: the project tracker's issues nobody has started, the most pressing first, as `issues.next` lists them,
 * less the ones a workspace in the project already started from. A Linear project lists its own team's only. Each row is one button: the
 * priority, the key, the title and the project, with Plan always showing at the end, quiet at rest and full ink on hover and focus. Pressing it hands the issue to `onPlan` as a chip.
 * A project with no tracker, a Linear project with no team, or a tracker that doesn't answer shows nothing, and holds no space while it is asked,
 * so the box never moves for a project that has no Up next.
 */
export function UpNext({ projectId, lead, onPlan }: { projectId: string; lead: string; onPlan: (part: ChatPart) => void }) {
  const [view, setView] = useState(() => ({ projectId, entry: readUpNext(projectId) }))
  // Render this project's cached rows on the first paint of a new project, before the effect below refreshes them.
  const current = view.projectId === projectId ? view : { projectId, entry: readUpNext(projectId) }
  useEffect(() => {
    let live = true
    let rows: IssueSummary[] | undefined
    let kind: ProjectTracker['kind'] | undefined
    let pending = 2
    const done = () => {
      if (--pending || !live) return
      const old = readUpNext(projectId)
      // Each call that failed keeps what the cache had; both failing leaves the cached entry as it was.
      const entry = rows || kind !== undefined ? storeUpNext(projectId, { kind: kind ?? old?.kind, rows: rows ?? old?.rows ?? [] }) : old
      setView({ projectId, entry })
    }
    // Both calls start now: main resolves the tracker for `issues.next` itself, so the list never waits on the kind.
    call('issues.next', { projectId }).then((r) => { rows = r }, () => undefined).then(done)
    call('issues.tracker', { projectId }).then((t) => { kind = t.kind }, () => undefined).then(done)
    setView((v) => (v.projectId === projectId ? v : { projectId, entry: readUpNext(projectId) }))
    return () => { live = false }
  }, [projectId])
  const rows = current.entry?.rows ?? []
  const kind = current.entry?.kind === 'linear' || current.entry?.kind === 'github' ? current.entry.kind : undefined
  const started = useStore((s) => s.workspaces.flatMap((w) => (w.projectId === projectId && w.status !== 'archived' && w.source?.kind === 'issue' ? [w.source.id] : [])).join('\n'))
  const shown = useMemo(() => {
    const taken = new Set(started.split('\n'))
    return rows.filter((i) => !taken.has(i.id)).slice(0, SHOWN)
  }, [rows, started])
  if (!kind || !shown.length) return null

  const name = NAMES[kind]
  const ranked = shown.some((i) => i.priority !== undefined)
  return (
    <section className="up-next" aria-label={`Up next in ${name}`}>
      <div className="up-next-head">
        <h3>Up next in {name}</h3>
        <button type="button" className="up-next-all" onClick={() => go({ name: 'issues', projectId })}>All issues</button>
      </div>
      <ul className={ranked ? undefined : 'up-next-plain'}>
        {shown.map((i) => (
          <li key={i.id} className="up-next-item">
            <button type="button" className="up-next-row" aria-label={`Plan ${i.id}, ${i.title}, with ${lead}`} onClick={() => onPlan({ type: 'issue', name: i.id, title: i.title, url: i.url, source: i.source ?? kind })}>
              {ranked && <IssuePriority priority={i.priority ?? 0} size={14} />}
              <span className="mono up-next-key">{i.id}</span>
              <span className="up-next-title ellipsis">{i.title}</span>
              <span className="up-next-project ellipsis" title={i.project ? `Linear project: ${i.project}` : undefined}>{i.project}</span>
              <span className="up-next-plan" aria-hidden="true">Plan<Icon name="right" size={12} /></span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
