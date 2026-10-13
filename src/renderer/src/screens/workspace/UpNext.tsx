import { useEffect, useMemo, useState } from 'react'
import type { ChatPart, IssueSummary, TrackerKind } from '@shared/types'
import { call } from '../../api'
import { IssuePriority } from '../../icons'
import { go, useStore } from '../../store'
import { Button } from '../../ui'
import { useRoomTracker } from '../issues/useRoomTracker'

/** Up next shows this many issues. */
const SHOWN = 3

const NAMES: Record<TrackerKind, string> = { linear: 'Linear', github: 'GitHub', jira: 'Jira' }

/**
 * Up next, under New chat with Rowan's composer: the room tracker's issues nobody has started, the most pressing first, as
 * `issues.next` lists them, less the ones a workspace in the room already started from. Plan hands the issue to `onPlan` as a chip.
 * A room with no tracker, one on Jira, whose issues Kernel can't list yet, or a tracker that doesn't answer shows nothing.
 */
export function UpNext({ roomId, lead, onPlan }: { roomId: string; lead: string; onPlan: (part: ChatPart) => void }) {
  const { read } = useRoomTracker(roomId)
  const kind = read.kind === 'ready' && (read.tracker.kind === 'linear' || read.tracker.kind === 'github') ? read.tracker.kind : undefined
  const [rows, setRows] = useState<IssueSummary[]>([])
  useEffect(() => {
    setRows([])
    if (!kind) return
    let live = true
    call('issues.next', { roomId }).then((r) => { if (live) setRows(r) }, () => undefined)
    return () => { live = false }
  }, [roomId, kind])
  const started = useStore((s) => s.workspaces.flatMap((w) => (w.roomId === roomId && w.status !== 'archived' && w.source?.kind === 'issue' ? [w.source.id] : [])).join('\n'))
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
