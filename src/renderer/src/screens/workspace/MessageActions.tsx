import { useRef, useState } from 'react'
import type { MenuId } from '@shared/types'
import { actions, useStore } from '../../store'
import { cleanError } from '../../api'
import { IconButton, Menu, useBusy, type IconName } from '../../ui'

/** What a failed action says. A channel that no lane has built yet rejects with "Not built yet: ...", which is fine to show as it is. */
export async function attempt(title: string, fn: () => Promise<unknown>) {
  try { await fn() } catch (e) { actions.ui.toast({ title, sub: cleanError(e) }) }
}

/** Copies `text` and says "Copied" for 1.5s. Only a failure toasts. */
export function useCopy(text: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  const copy = () => void navigator.clipboard.writeText(text).then(
    () => { setCopied(true); setTimeout(() => setCopied(false), 1500) },
    () => actions.ui.toast({ title: 'Could not copy', sub: 'The clipboard is not available.' })
  )
  return [copied, copy]
}

export interface MessageAction { icon: IconName; label: string; busyLabel?: string; onClick: () => unknown }

/** The "..." menu at the end of the row. `menu` is its id in the store, so one menu is open at a time and a fixture can open it. */
export interface MoreActions { menu: MenuId; items: MessageAction[] }

/**
 * Copy, then retry, edit and fork, as icon buttons under a message. Each one's label is its tooltip (DESIGN.md). Copy turns
 * into a check for 1.5s instead of toasting, and an action that waits on the main process spins until it settles. Hidden
 * until the message is hovered or something in it has focus (DESIGN.md), but the row keeps its height so nothing shifts.
 * `more` ends the row with a "..." menu, whose button spins for the entry that is running. `meta` leads the row with a
 * finished turn's time, which stays when the icons hide (KERNEL-346).
 */
export function MessageActions({ copy, items = [], more, meta, align = 'start', label }: { copy: string; items?: MessageAction[]; more?: MoreActions; meta?: string; align?: 'start' | 'end'; label: string }) {
  const [copied, onCopy] = useCopy(copy)
  const [busy, run] = useBusy()
  const acts = (
    <div className="msg-acts" data-align={align} data-busy={(more && more.items.some((a) => a.label === busy)) || undefined} role="group" aria-label={label}>
      <IconButton box="sm" icon={copied ? 'check' : 'copy'} size={14} label={copied ? 'Copied' : 'Copy'} onClick={onCopy} />
      {items.map((a) => (
        <IconButton box="sm" key={a.label} icon={a.icon} size={14} label={a.label} busy={busy === a.label} busyLabel={a.busyLabel} disabled={busy !== null}
          onClick={() => void run(a.label, async () => a.onClick())} />
      ))}
      {more && <MoreMenu more={more} busy={busy} run={run} />}
    </div>
  )
  if (meta === undefined) return acts
  return <div className="msg-foot"><span className="meta">{meta}</span>{acts}</div>
}

/** The "..." button and its menu, opening upward since the composer sits just below the last reply. */
function MoreMenu({ more, busy, run }: { more: MoreActions; busy: string | null; run: (key: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const open = useStore((s) => s.ui.menu === more.menu)
  const anchor = useRef<HTMLSpanElement>(null)
  const running = more.items.find((a) => a.label === busy)
  return (
    <span ref={anchor} className="msg-more">
      <IconButton box="sm" icon="more" size={14} label="More actions" aria-haspopup="menu" aria-expanded={open} busy={!!running} busyLabel={running?.busyLabel} disabled={busy !== null}
        onClick={() => actions.ui.toggleMenu(more.menu)} />
      {open && (
        <Menu label="More actions" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ left: 0, bottom: 'calc(100% + 4px)', width: 232 }}
          items={more.items.map((a) => ({ id: a.label, label: a.label, icon: a.icon, onSelect: () => void run(a.label, async () => a.onClick()) }))} />
      )}
    </span>
  )
}
