import { Fragment, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ChatItem, TeamUpdateRow, Workspace } from '@shared/types'
import { go, useStore } from '../../../store'
import { KernelNote } from '../KernelNote'
import { copyText, MessageActions } from '../MessageActions'
import { cardData, eventTone, sections, taskParts, textOf } from './teamUpdate'
import './cards.css'

/**
 * Kernel's team update in a Lead chat (KERNEL-127): one row per teammate, with what happened and the reply it sent, so it
 * no longer reads as a message the user typed. The Lead reads the item's text; this draws the data saved with it.
 */
export function TeamUpdateCard({ item }: { item: Extract<ChatItem, { kind: 'user' }> }) {
  const workspaces = useStore((s) => s.workspaces)
  return <TeamUpdateView item={item} workspaceOf={(id) => workspaces.find((w) => w.id === id)} />
}

/** The card itself, given how to find a row's workspace: the store in the app, a stub in tests. */
export function TeamUpdateView({ item, workspaceOf }: { item: Extract<ChatItem, { kind: 'user' }>; workspaceOf: (id: string) => Workspace | undefined }) {
  const data = cardData(item)
  // An older update whose lines no longer read as rows still shows, as Kernel's note.
  if (!data.rows.length && !data.omitted) return <KernelNote item={item} />
  // An update from before KERNEL-117 counted the lines it left out, not workspaces.
  const omitted = !data.omitted ? '' : item.update ? `Updates on ${data.omitted} more ${data.omitted === 1 ? 'workspace' : 'workspaces'} left out` : `${data.omitted} earlier ${data.omitted === 1 ? 'update' : 'updates'} left out`
  return (
    <div className="msg tucard-wrap">
      <section className="card tcard tucard" aria-label="Team update from Kernel">
        <header className="tucard-head"><h3 className="tucard-title">Team update</h3><span className="muted">from Kernel</span></header>
        {sections(data.rows).map((s, i) => (
          <div key={i} className="tucard-section">
            {s.fromChat && <div className="tucard-from">From "{s.fromChat}", a Lead chat that is now closed</div>}
            {s.rows.map((row) => <Row key={row.workspaceId} row={row} ws={workspaceOf(row.workspaceId)} />)}
          </div>
        ))}
        {omitted && <div className="tucard-omitted">{omitted}</div>}
      </section>
      <MessageActions label="Message actions" items={[{ label: 'Copy', onClick: () => void copyText(textOf(item)) }]} />
    </div>
  )
}

function Row({ row, ws }: { row: TeamUpdateRow; ws: Workspace | undefined }) {
  const archived = ws?.status === 'archived'
  const { key, title } = taskParts(row.task)
  return (
    <div className="tucard-row">
      <div className="tucard-line">
        <span className="tucard-name">{row.name}</span>
        {key && <span className="tucard-key">{key}</span>}
        <span className="tucard-task ellipsis">{title}</span>
        {ws && (
          <button type="button" className="tucard-open" data-to={archived ? 'history' : 'workspace'} aria-label={archived ? `Find ${row.name}'s workspace for ${row.task} in History` : `Open ${row.name}'s workspace for ${row.task}`}
            onClick={() => (archived ? go({ name: 'history' }) : go({ name: 'workspace', workspaceId: ws.id }))}>
            {archived ? 'In History' : 'Open'}
          </button>
        )}
      </div>
      {/* The events as one line of text between dots, colored only for what failed, merged or passed (KERNEL-274). */}
      {row.events.length > 0 && (
        <p className="tucard-events">
          {row.events.map((e, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="tucard-sep" aria-hidden="true">·</span>}
              {/* A screen reader hears a full stop between events, unless one already ends the sentence. */}
              <span className="tucard-ev" data-tone={eventTone(e)}>{e.text.replace(/\.$/, '')}<span className="sr-only">{/[!?…]$/.test(e.text) ? ' ' : '. '}</span></span>
            </Fragment>
          ))}
        </p>
      )}
      {row.reply && <Reply text={row.reply} />}
    </div>
  )
}

/** The teammate's reply, three lines until the user asks for the rest. Show more appears only when the lines run over. */
function Reply({ text }: { text: string }) {
  const ref = useRef<HTMLQuoteElement>(null)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const measure = () => setOver(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [text, open])
  return (
    <>
      {/* Clamped, paragraphs sit on the next line so a blank one doesn't use up the three. */}
      <blockquote ref={ref} id={id} className="tucard-quote" data-clamped={open ? undefined : 'true'}>{open ? text : text.replace(/\n{2,}/g, '\n')}</blockquote>
      {(over || open) && <button type="button" className="tucard-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
    </>
  )
}
