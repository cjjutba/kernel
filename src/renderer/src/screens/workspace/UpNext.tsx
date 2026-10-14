import { useEffect, useMemo, useState } from 'react'
import type { ChatPart, IssueSummary, RoomTracker, TrackerKind } from '@shared/types'
import { call } from '../../api'
import { IssuePriority } from '../../icons'
import { go, useStore } from '../../store'
import { Button } from '../../ui'
import { readUpNext, storeUpNext } from './upNextCache'

/** Up next shows this many issues. */
const SHOWN = 3

const NAMES: Record<TrackerKind, string> = { linear: 'Linear', github: 'GitHub', jira: 'Jira' }

/**
 * Up next, under New chat's composer: the room tracker's issues nobody has started, the most pressing first, as
 * `issues.next` lists them, less the ones a workspace in the room already started from. Plan hands the issue to `onPlan` as a chip.
 * A room with no tracker, one on Jira, whose issues Kernel can't list yet, or a tracker that doesn't answer shows nothing.
 */
export function UpNext({ roomId, lead, onPlan }: { roomId: string; lead: string; onPlan: (part: ChatPart) => void }) {
  const [view, setView] = useState(() => ({ roomId, entry: readUpNext(roomId), settled: false }))
  // Render this room's cached rows on the first paint of a new room, before the effect below refreshes them.
  const current = view.roomId === roomId ? view : { roomId, entry: readUpNext(roomId), settled: false }
  useEffect(() => {
    let live = true
    let rows: IssueSummary[] | undefined
    let kind: RoomTracker['kind'] | undefined
    let pending = 2
    const done = () => {
      if (--pending || !live) return
      const old = readUpNext(roomId)
      // Each call that failed keeps what the cache had; both failing leaves the cached entry as it was.
      const entry = rows || kind !== undefined ? storeUpNext(roomId, { kind: kind ?? old?.kind, rows: rows ?? old?.rows ?? [] }) : old
      setView({ roomId, entry, settled: true })
    }
    // Both calls start now: main resolves the tracker for `issues.next` itself, so the list never waits on the kind.
    call('issues.next', { roomId }).then((r) => { rows = r }, () => undefined).then(done)
    call('issues.tracker', { roomId }).then((t) => { kind = t.kind }, () => undefined).then(done)
    setView((v) => (v.roomId === roomId ? v : { roomId, entry: readUpNext(roomId), settled: false }))
    return () => { live = false }
  }, [roomId])
  const rows = current.entry?.rows ?? []
  const kind = current.entry?.kind === 'linear' || current.entry?.kind === 'github' ? current.entry.kind : undefined
  const started = useStore((s) => s.workspaces.flatMap((w) => (w.roomId === roomId && w.status !== 'archived' && w.source?.kind === 'issue' ? [w.source.id] : [])).join('\n'))
  const shown = useMemo(() => {
    const taken = new Set(started.split('\n'))
    return rows.filter((i) => !taken.has(i.id)).slice(0, SHOWN)
  }, [rows, started])
  // Nothing cached and nothing answered yet: hold the block's height, so the composer doesn't move when the rows land.
  if (!current.entry && !current.settled) return <UpNextSpace />
  if (!kind || !shown.length) return null

  const name = NAMES[kind]
  const ranked = shown.some((i) => i.priority !== undefined)
  return (
    <section className="up-next" aria-label={`Up next in ${name}`}>
      <div className="up-next-head">
        <h3>Up next in {name}</h3>
        <button type="button" className="up-next-all" onClick={() => go({ name: 'issues', roomId })}>All issues</button>
      </div>
      <ul className={ranked ? undefined : 'up-next-plain'}>
        {shown.map((i) => (
          <li key={i.id} className="up-next-row">
            {ranked && <IssuePriority priority={i.priority ?? 0} size={14} />}
            <span className="mono up-next-key">{i.id}</span>
            <span className="ellipsis">{i.title}</span>
            <Button className="up-next-plan" aria-label={`Plan ${i.id} with ${lead}`} onClick={() => onPlan({ type: 'issue', name: i.id, title: i.title, url: i.url, source: i.source ?? kind })}>Plan</Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The empty block, the same markup as the real one with nothing visible, so the two always have the same height. */
function UpNextSpace() {
  return (
    <section className="up-next up-next-space" aria-hidden="true">
      <div className="up-next-head"><h3>&nbsp;</h3></div>
      <ul className="up-next-plain">
        {[0, 1, 2].map((i) => <li key={i} className="up-next-row" />)}
      </ul>
    </section>
  )
}
