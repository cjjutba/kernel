import { Fragment, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ChatItem, TeamUpdateRow, Workspace } from '@shared/types'
import { mergeableState } from '@shared/merge'
import { call } from '../../../api'
import { go, useStore } from '../../../store'
import { Icon } from '../../../ui'
import { KernelNote } from '../KernelNote'
import { MessageActions } from '../MessageActions'
import { SharedRow } from './SharedCard'
import { MergeButton } from '../pr/MergeButton'
import { inline } from '../markdown'
import { cardData, eventTone, isStillBlocked, mergeTargetOf, mergedAutomatically, newestRows, openItems, sections, taskParts, textOf } from './teamUpdate'
import './cards.css'

/** One workspace by id, so a row redraws only when its own workspace changes, not when any workspace does. */
const useWorkspaceById = (id: string) => useStore((s) => s.workspaces.find((w) => w.id === id))

type WorkspaceOf = (id: string) => Workspace | undefined
/** Whether this row, of the workspace `rowId` in the item `itemId`, is the one in the chat that offers Merge for the PR of `target`, a workspace id. May be a hook. */
type UseNewest = (target: string, itemId: string, rowId: string) => boolean

/**
 * Kernel's team update in a Lead chat (KERNEL-127): one row per teammate, with what happened and the reply it sent, so it
 * no longer reads as a message the user typed. The Lead reads the item's text; this draws the data saved with it.
 */
export function TeamUpdateCard({ item, chatId }: { item: Extract<ChatItem, { kind: 'user' }>; chatId: string }) {
  // Only one row about a PR in this chat offers Merge (KERNEL-351, KERNEL-581). One boolean per row, so a row redraws only when its answer changes.
  const useNewest = (target: string, itemId: string, rowId: string) => useStore((s) => {
    const row = newestRows(s.items[chatId], s.workspaces).get(target)
    return row?.itemId === itemId && row.workspaceId === rowId
  })
  return <TeamUpdateView item={item} workspaceOf={useWorkspaceById} useNewest={useNewest} />
}

/** The card itself, given how to find a row's workspace: a store hook in the app, a stub in tests. Each row calls it, so it may be a hook. */
export function TeamUpdateView({ item, workspaceOf, useNewest }: { item: Extract<ChatItem, { kind: 'user' }>; workspaceOf: WorkspaceOf; useNewest: UseNewest }) {
  const data = cardData(item)
  // An older update whose lines no longer read as rows still shows, as Kernel's note.
  if (!data.rows.length && !data.omitted) return <KernelNote item={item} />
  // An update from before KERNEL-117 counted the lines it left out, not workspaces. Past the 8th workspace, older updates dropped them and newer ones carry them into the next update (KERNEL-637), so the card says only that they didn't fit.
  const omitted = !data.omitted ? '' : item.update ? `Updates on ${data.omitted} more ${data.omitted === 1 ? 'workspace' : 'workspaces'} didn't fit here` : `${data.omitted} earlier ${data.omitted === 1 ? 'update' : 'updates'} left out`
  return (
    <div className="msg tucard-wrap">
      <section className="card tcard tucard" aria-label="Team update from Kernel">
        <header className="tucard-head"><h3 className="tucard-title">Team update</h3><span className="muted">from Kernel</span></header>
        {sections(data.rows).map((s, i) => (
          <div key={i} className="tucard-section">
            {s.fromChat && <div className="tucard-from">From "{s.fromChat}", {s.fromTab ? 'a tab you closed' : 'a Lead chat that is now closed'}</div>}
            {s.rows.map((row) => <Row key={row.workspaceId} row={row} itemId={item.id} workspaceOf={workspaceOf} useNewest={useNewest} />)}
          </div>
        ))}
        {omitted && <div className="tucard-omitted">{omitted}</div>}
      </section>
      <MessageActions label="Message actions" copy={textOf(item)} />
    </div>
  )
}

function Row({ row, itemId, workspaceOf, useNewest }: { row: TeamUpdateRow; itemId: string; workspaceOf: WorkspaceOf; useNewest: UseNewest }) {
  const ws = workspaceOf(row.workspaceId)
  // A reviewer's row merges the PR it reviewed. Once that workspace is archived the PR is over, and the row says In History.
  const targetId = ws ? mergeTargetOf(ws) : row.workspaceId
  const target = workspaceOf(targetId)
  const merge = useNewest(targetId, itemId, row.workspaceId) && target && target.status !== 'archived' ? target : undefined
  const archived = ws?.status === 'archived'
  // A PR the reviews still block after their rounds comes to the user: "Needs you" takes the Merge button's place, and what is open lists under it (KERNEL-557).
  const stuck = isStillBlocked(row) && !!merge && mergeableState(merge.prState)
  const open = stuck && target ? openItems(target) : []
  // A merge Kernel made on its own links to the PR, since no one pressed Merge to see it (KERNEL-557).
  const link = mergedAutomatically(row) && ws?.prUrl ? { url: ws.prUrl, number: row.prNumber ?? ws.prNumber } : undefined
  // The key from the task, else from the issue the workspace started on, as the PRs tab reads it (KERNEL-411).
  const parts = taskParts(row.task)
  const key = parts.key ?? (ws?.source?.kind === 'issue' ? ws.source.id : undefined)
  const title = parts.title
  return (
    <div className="tucard-row">
      <div className="tucard-line">
        <span className="tucard-name">{row.name}</span>
        {key && <span className="tucard-key">{key}</span>}
        <span className="tucard-task ellipsis">{title}</span>
        {ws && (
          <span className="tucard-act">
            {stuck ? <span className="tucard-why">Needs you</span> : merge && <MergeButton ws={merge} />}
            <button type="button" className="tucard-open" data-to={archived ? 'history' : 'workspace'} aria-label={archived ? `Find ${row.name}'s workspace for ${row.task} in History` : `Open ${row.name}'s workspace for ${row.task}`}
              onClick={() => (archived ? go({ name: 'history' }) : go({ name: 'workspace', workspaceId: ws.id }))}>
              {archived ? 'In History' : 'Open'}
            </button>
          </span>
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
      {open.length > 0 && (
        <ul className="tucard-items" aria-label="Still open">
          {open.slice(0, MAX_OPEN).map((i, n) => <li key={n}><span className="tucard-kind">{i.kind}</span><span className="tucard-what" data-tip={i.text}>{i.text}</span></li>)}
          {open.length > MAX_OPEN && <li className="tucard-more-open">{open.length - MAX_OPEN} more</li>}
        </ul>
      )}
      {row.reply ? <Reply text={row.reply} link={link} /> : link && <p className="tucard-quote"><PrLink {...link} lone /></p>}
      {row.shared?.map((f) => <SharedRow key={f.sharedId} sharedId={f.sharedId} version={f.version} title={f.title} kind={f.kind} />)}
    </div>
  )
}

/** The most blockers a still blocked row lists. The PR itself has the rest. */
const MAX_OPEN = 5

/** "PR #162 ↗", the PR on GitHub, in the merged tone. */
function PrLink({ url, number, tabbable = true, lone }: { url: string; number?: number; tabbable?: boolean; lone?: boolean }) {
  const name = number ? `PR #${number}` : 'the PR'
  return (
    <a className="tucard-pr" data-lone={lone || undefined} href={url} aria-label={`Open ${name} on GitHub`} tabIndex={tabbable ? undefined : -1} aria-hidden={tabbable ? undefined : true}
      onClick={(e) => { e.preventDefault(); void call('system.openExternal', { url }).catch(() => undefined) }}>
      {number ? `PR #${number}` : 'PR'}<Icon name="ext" size={12} />
    </a>
  )
}

/**
 * The teammate's reply, three lines until the user asks for the rest. Show more appears only when the lines run over. A `link` follows
 * the last line. When the lines run over it is cut off with them, so it shows again under the reply, and the one in the text steps aside.
 */
function Reply({ text, link }: { text: string; link?: { url: string; number?: number } }) {
  const ref = useRef<HTMLQuoteElement>(null)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  const clipped = over && !open
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
      {/* Inline code, bold and links render as they do in chat, so a reply never shows raw backticks (KERNEL-411). */}
      <blockquote ref={ref} id={id} className="tucard-quote" data-clamped={open ? undefined : 'true'}>{inline(open ? text : text.replace(/\n{2,}/g, '\n'))}{link && <PrLink {...link} tabbable={!clipped} />}</blockquote>
      {(over || open) && <button type="button" className="tucard-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
      {link && clipped && <p className="tucard-quote"><PrLink {...link} lone /></p>}
    </>
  )
}
