import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import type { SharedComment, SharedFile, SharedVersion } from '@shared/types'
import { call, onPush } from '../../../api'
import { actions, go } from '../../../store'
import { Button, Icon, useBusy, useEscape } from '../../../ui'
import { attempt } from '../MessageActions'
import { canSend, chipName, popoverPlace, previewLines, type Draft, type Size, type Spot } from './comment'
import type { Surface } from './commentSurfaces'
import type { Rect } from './cover'
import { sendHint, sendsOn, useSendWith } from '../composer/sendKey'

const MOVE_MS = 80

/**
 * Comment mode over a shared file (KERNEL-311, WorkspaceSharedComment.png and the rest). The layer fills the file's box: a crosshair, an outline
 * round what the pointer is over, a numbered pin for each earlier comment on this version, and the popover where a click leaves a pin and
 * a note is written. What a point means is the surface's business, so a page, an image and Markdown share this. Esc cancels the popover
 * first and then leaves comment mode, since the popover is the newer layer.
 */
export function CommentLayer({ layerRef, kind, file, version, by, archived, surface, onExit, onWheel, watch }: {
  layerRef: RefObject<HTMLDivElement | null>
  kind: SharedFile['kind']
  file: SharedFile
  version: SharedVersion
  /** The agent that shared the file, who gets the comment. */
  by: string
  /** The workspace that shared it is archived, so nothing could be delivered. */
  archived: boolean
  surface: Surface
  onExit: () => void
  /** A page scrolls under the pointer, since the layer covers the native view. */
  onWheel?: (dx: number, dy: number) => void
  /** Changes whenever the file under the layer moves or scales, so every pin, and the one being written, is placed again (an image that zoomed or scrolled, KERNEL-598). */
  watch?: unknown
}) {
  const [all, setAll] = useState<SharedComment[]>([])
  const [spots, setSpots] = useState<(Spot | null)[]>([])
  const [again, setAgain] = useState(0)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [hover, setHover] = useState<{ outline: Rect; label: string } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [reading, setReading] = useState<number | null>(null)
  const [busy, run] = useBusy<'send'>()
  const pins = useRef(new Map<string, HTMLButtonElement>())
  const lastPin = useRef<string | null>(null)
  const mine = useMemo(() => all.filter((c) => c.version === version.n), [all, version.n])

  useEscape(onExit)

  useEffect(() => {
    let live = true
    setAll([])
    call('shared.comments', { sharedId: file.id }).then((r) => { if (live) setAll((now) => merge(r, now)) }).catch(() => undefined)
    const off = onPush((e) => {
      if (e.type === 'shared.comment' && e.comment.sharedId === file.id) setAll((now) => merge(now, [e.comment]))
      // A page that scrolled or reflowed has moved the elements the pins were left on.
      if (e.type === 'preview' && e.state === 'settled') setAgain((n) => n + 1)
    })
    return () => { live = false; off() }
  }, [file.id])

  useEffect(() => {
    const el = layerRef.current
    if (!el) return
    const measure = () => { setSize({ width: el.clientWidth, height: el.clientHeight }); setAgain((n) => n + 1) }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [layerRef])

  useEffect(() => {
    let live = true
    void surface.spots(mine).then((s) => { if (live) setSpots(s) })
    return () => { live = false }
  }, [surface, mine, again, watch])

  // The pin being written goes with its spot too, by the anchor it was left at.
  useEffect(() => {
    if (watch === undefined || !draft) return
    let live = true
    void surface.spots([{ anchor: draft.anchor }]).then(([s]) => { if (live && s) setDraft((d) => (d && d.anchor === draft.anchor ? { ...d, at: s } : d)) })
    return () => { live = false }
  }, [watch])

  // Pointer moves are many and the answer comes from the page, so ask at most every MOVE_MS about the latest point.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<Spot | null>(null)
  const asked = useRef(0)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const at = (e: MouseEvent): Spot => {
    const b = layerRef.current?.getBoundingClientRect()
    return { x: e.clientX - (b?.left ?? 0), y: e.clientY - (b?.top ?? 0) }
  }
  const onMove = (e: MouseEvent) => {
    if (reading !== null) return
    latest.current = at(e)
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      const p = latest.current
      const n = ++asked.current
      if (p) void surface.hover(p).then((h) => { if (n === asked.current) setHover(h) })
    }, MOVE_MS)
  }
  const onLeave = () => { latest.current = null; asked.current++; setHover(null) }

  const place = async (p: Spot) => {
    const got = await surface.pick(p)
    if (!got) return
    setHover(null)
    setReading(null)
    setDraft((d) => ({ at: got.at, anchor: got.anchor, note: d?.note ?? '' }))
  }
  const onClick = (e: MouseEvent) => { if (!busy) void place(at(e)) }

  const send = () => run('send', () => attempt('Could not send the comment', async () => {
    if (!draft || !canSend(draft.note, archived, false)) return
    const image = kind === 'markdown' ? undefined : await surface.crop(draft.anchor, draft.at)
    const r = await call('shared.comment', { sharedId: file.id, version: version.n, note: draft.note.trim(), anchor: draft.anchor, ...(image ? { image } : {}) })
    setDraft(null)
    actions.ui.toast({
      title: `Sent to ${by}`,
      ...(r.queued ? { sub: `${by} will see it when they finish.` } : {}),
      action: { label: 'Open chat', tab: { workspaceId: r.workspaceId, id: r.chatId } }
    })
  }))

  const closeReading = () => {
    const id = lastPin.current
    setReading(null)
    if (id) requestAnimationFrame(() => pins.current.get(id)?.focus())
  }

  const shown = mine.map((c, i) => ({ c, n: i + 1, at: spots[i] ?? null })).filter((p): p is { c: SharedComment; n: number; at: Spot } => !!p.at && p.at.x >= 0 && p.at.y >= 0 && p.at.x <= size.width && p.at.y <= size.height)
  const open = reading !== null ? mine[reading] : undefined

  return (
    <div
      ref={layerRef} className="cm-layer" data-kind={kind}
      onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick} onWheel={onWheel && !draft ? (e) => onWheel(e.deltaX, e.deltaY) : undefined}
    >
      {hover && (
        <span className="cm-hover" style={{ left: hover.outline.x, top: hover.outline.y, width: hover.outline.width, height: hover.outline.height }} aria-hidden="true">
          <span className="cm-hover-label">{hover.label}</span>
        </span>
      )}
      {shown.map(({ c, n, at: p }) => (
        <button
          key={c.id} type="button" className="cm-pin" style={{ left: p.x, top: p.y }} aria-label={`Comment ${n}: ${c.note}`} aria-haspopup="dialog"
          ref={(el) => { if (el) pins.current.set(c.id, el); else pins.current.delete(c.id) }}
          onClick={(e) => { e.stopPropagation(); setDraft(null); lastPin.current = c.id; setReading(mine.indexOf(c)) }}
        >{n}</button>
      ))}
      {draft && <span className="cm-pin" data-active="true" style={{ left: draft.at.x, top: draft.at.y }} aria-hidden="true">{mine.length + 1}</span>}
      {draft && (
        <Pop at={draft.at} layer={size} label="Add a comment">
          <Writing
            draft={draft} file={file} version={version.n} kind={kind} by={by} archived={archived} busy={busy === 'send'}
            onNote={(note) => setDraft({ ...draft, note })} onCancel={() => setDraft(null)} onSend={() => void send()}
          />
        </Pop>
      )}
      {open && spots[reading!] && (
        <Pop at={spots[reading!]!} layer={size} label={`Comment ${reading! + 1}`}>
          <Reading comment={open} onClose={closeReading} />
        </Pop>
      )}
    </div>
  )
}

/** Earlier comments first, then new ones, once each. */
function merge(a: SharedComment[], b: SharedComment[]): SharedComment[] {
  const seen = new Set<string>()
  return [...a, ...b].filter((c) => !seen.has(c.id) && !!seen.add(c.id)).sort((x, y) => x.at - y.at)
}

/** The popover's frame: below its pin, inside the layer. It is measured once drawn, so it can go above the pin where there is no project below. */
function Pop({ at, layer, label, children }: { at: Spot; layer: Size; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pop, setPop] = useState<Size>({ width: 380, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    // Only a changed size sets state, or every render would ask for another.
    if (el) setPop((p) => (p.width === el.offsetWidth && p.height === el.offsetHeight ? p : { width: el.offsetWidth, height: el.offsetHeight }))
  })
  const p = popoverPlace(at, layer, pop)
  return (
    <div
      ref={ref} className="cm-pop" role="dialog" aria-label={label} style={{ left: p.x, top: p.y }}
      onClick={(e) => e.stopPropagation()} onMouseMove={(e) => e.stopPropagation()}
    >{children}</div>
  )
}

function Writing({ draft, file, version, kind, by, archived, busy, onNote, onCancel, onSend }: {
  draft: Draft; file: SharedFile; version: number; kind: SharedFile['kind']; by: string; archived: boolean; busy: boolean
  onNote: (note: string) => void; onCancel: () => void; onSend: () => void
}) {
  useEscape(onCancel)
  const ok = canSend(draft.note, archived, busy)
  const sendWith = useSendWith()
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends and Shift+Enter breaks the line, or Cmd+Enter sends by Send messages with. Enter that picks a word in an input method is not a send.
    if (!sendsOn(e, sendWith) || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (ok) onSend()
  }
  return (
    <>
      <h3 className="cm-title">Add a comment</h3>
      <textarea className="cm-note" aria-label="Comment" rows={2} value={draft.note} autoFocus disabled={busy} onChange={(e) => onNote(e.target.value)} onKeyDown={onKeyDown} />
      {archived ? (
        <p className="cm-gone" role="alert">
          {by}'s workspace is archived, so the comment can't reach {by}. Restore it from <button type="button" className="cm-link" onClick={() => go({ name: 'history' })}>History</button> to send.
        </p>
      ) : (
        <>
          <div className="cm-sees"><span>{by} will see</span>{kind !== 'markdown' && <span className="cm-chip"><Icon name="image" size={12} />{chipName(file.title, version)}</span>}</div>
          <div className="cm-lines">{previewLines(file, version, draft.anchor).map((l, i) => <span key={i}>{l}</span>)}</div>
        </>
      )}
      <div className="cm-foot">
        <span className="cm-hint">{archived ? '' : `${sendHint(sendWith)}, Esc to cancel`}</span>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" disabled={!ok && !busy} busy={busy} busyPattern="arrow-right" busyLabel="Sending" onClick={onSend}>Send</Button>
      </div>
    </>
  )
}

/** An earlier comment, opened from its pin. It can be read and closed; the agent already has it. */
function Reading({ comment, onClose }: { comment: SharedComment; onClose: () => void }) {
  useEscape(onClose)
  return (
    <>
      <p className="cm-said">{comment.note}</p>
      <div className="cm-foot"><span className="cm-hint" /><Button autoFocus onClick={onClose}>Close</Button></div>
    </>
  )
}
