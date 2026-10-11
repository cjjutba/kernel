import './settings.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Room, RoomSettings } from '@shared/types'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Button, Icon, Kbd, Menu, useBusy } from '../../ui'
import { useRoomSettings } from './useSettings'

/** One settings page: the title, an optional intro and its sections. `action` sits at the right of the title. */
export function Page({ title, intro, action, children }: { title: string; intro?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-scroll">
      <div className="set-page">
        <div>
          <div className="set-head">
            <h1>{title}</h1>
            {action}
          </div>
          {intro && <p className="set-intro">{intro}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}

/** `action` sits at the right of the heading (Add run script). `note` is the line under the card. */
export function Section({ title, action, note, children }: { title: string; action?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-section">
      {action ? <div className="set-section-head"><h2>{title}</h2>{action}</div> : <h2>{title}</h2>}
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  )
}

/**
 * A label and optional description on the left, the control on the right. `full` puts the control on its own line.
 * `source` is the line under the label that says where a room's value came from, and `onReset` adds Reset, which sends `null` for the key.
 */
export function Row({ label, source, desc, onReset, children, full }: { label: ReactNode; source?: ReactNode; desc?: ReactNode; onReset?: () => void; children?: ReactNode; full?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <span className="set-label">{label}</span>
        {source && <span className="set-desc">{source}</span>}
        {desc && <span className="set-desc">{desc}</span>}
      </div>
      {onReset && <Button variant="ghost" className="set-reset" aria-label={`Reset ${typeof label === 'string' ? label : 'setting'}`} onClick={onReset}>Reset</Button>}
      {children}
      {full && <div className="set-full">{full}</div>}
    </div>
  )
}

export function Keys({ keys }: { keys: string[] }) {
  return <span className="set-keys">{keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>
}

/** A list with one entry per line (Always ask before, Never allow). Saved when the field loses focus. */
export function LinesField({ label, value, onSave }: { label: string; value: string[]; onSave: (lines: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'))
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setText(value.join('\n')) }, [value.join('\n')])
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px` } }, [text])
  const commit = () => {
    const next = text.split('\n').map((l) => l.trim()).filter(Boolean)
    if (next.join('\n') !== value.join('\n')) onSave(next)
  }
  return <textarea ref={ref} className="set-lines" aria-label={label} rows={Math.max(2, value.length)} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />
}

/** A short list on one line, comma separated (Protected branches). */
export function ListField({ label, value, onSave }: { label: string; value: string[]; onSave: (items: string[]) => void }) {
  const [text, setText] = useState(value.join(', '))
  useEffect(() => { setText(value.join(', ')) }, [value.join(',')])
  const commit = () => {
    const next = text.split(',').map((l) => l.trim()).filter(Boolean)
    if (next.join(',') !== value.join(',')) onSave(next)
  }
  return <input className="set-inline" aria-label={label} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}

/** Free text, kept as typed (blank lines and all): instructions and scripts. Saved when the field loses focus. */
export function TextField({ label, value, onSave, placeholder }: { label: string; value: string; onSave: (text: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setText(value) }, [value])
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px` } }, [text])
  return <textarea ref={ref} className="set-lines" aria-label={label} placeholder={placeholder} rows={Math.max(1, text.split('\n').length)} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onSave(text)} />
}

/** A page for a repo's settings when there is no repo to read them from yet. */
export function NoRoom() {
  return <Page title="No room yet" intro="These settings belong to a repo. Add a room first and they show up here.">{null}</Page>
}

/** Where a room's value came from, for the line under its label. The app default says nothing. A personal value only the room sees says nothing either. */
export function sourceLine(rs: RoomSettings | null, path: string): string | undefined {
  const s = rs?.sources?.[path]
  return s === 'shared' ? 'From settings.toml' : s === 'override' ? 'Overriding settings.toml' : undefined
}

/** Does this room set the value itself (in its personal file, with or without settings.toml)? Those are the values Reset can drop. */
export const isOverride = (rs: RoomSettings | null, path: string) => rs?.sources?.[path] === 'local' || rs?.sources?.[path] === 'override'

/** The room a room page shows, with its settings. `room` is undefined when the route's room is gone. */
export function useRoomPage(roomId?: string): { room: Room | undefined; rs: RoomSettings | null } {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  return { room, rs: useRoomSettings(roomId) }
}

/**
 * The button at the top right of a room page: it opens settings.local.toml, and its menu opens settings.toml.
 * Only a file that exists is offered, and `sources` says which do: a value from settings.toml means that file is there.
 */
function OpenSettingsFiles({ room, rs }: { room: Room; rs: RoomSettings | null }) {
  const open = useStore((s) => s.ui.menu === 'settingsFiles')
  const [busy, run] = useBusy()
  const anchor = useRef<HTMLDivElement>(null)
  const values = Object.values(rs?.sources ?? {})
  const files = [
    ...(values.some((s) => s === 'local' || s === 'override') ? ['settings.local.toml'] : []),
    ...(values.some((s) => s === 'shared' || s === 'override') ? ['settings.toml'] : [])
  ]
  if (!files.length) return null
  const [first, ...more] = files
  const edit = (file: string) => run('open', async () => {
    try { await call('system.openInEditor', { path: `${room.path}/.kernel/${file}` }) } catch (e) { actions.ui.toast({ title: `Could not open ${file}`, sub: (e as Error).message }) }
  })
  return (
    <div className="set-files" ref={anchor}>
      <div className="set-split">
        <Button variant="ghost" className="set-split-main" icon="doc" busy={busy === 'open'} busyLabel="Opening" onClick={() => void edit(first)}>Open {first}</Button>
        {more.length > 0 && (
          <button type="button" className="set-split-caret" aria-label="More files" aria-haspopup="menu" aria-expanded={open} disabled={busy !== null} onClick={() => actions.ui.toggleMenu('settingsFiles')}><Icon name="chevron" size={10} stroke={1.9} /></button>
        )}
      </div>
      {open && <Menu label="More files" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: 0, top: 36, width: 224 }} items={more.map((f) => ({ id: f, label: `Open ${f}`, icon: 'doc' as const, onSelect: () => void edit(f) }))} />}
    </div>
  )
}

/** A room page: the title, what it is, the settings files button, and the sections. */
export function RoomPage({ room, rs, title, intro, children }: { room: Room; rs: RoomSettings | null; title: string; intro: string; children: ReactNode }) {
  return <Page title={title} intro={intro} action={<OpenSettingsFiles room={room} rs={rs} />}>{children}</Page>
}
