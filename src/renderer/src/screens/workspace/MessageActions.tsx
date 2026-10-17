import { useRef } from 'react'
import type { MenuId } from '@shared/types'
import { actions, useStore } from '../../store'
import { cleanError } from '../../api'
import { CopyButton, IconButton, Menu, useBusy, type IconName } from '../../ui'

/** What a failed action says. A channel that no lane has built yet rejects with "Not built yet: ...", which is fine to show as it is. */
export async function attempt(title: string, fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return true } catch (e) { actions.ui.toast({ title, sub: cleanError(e) }); return false }
}

export interface MessageAction { icon: IconName; label: string; busyLabel?: string; onClick: () => unknown }

/** The "..." menu at the end of the row. `menu` is its id in the store, so one menu is open at a time and a fixture can open it. */
export interface MoreActions { menu: MenuId; items: MessageAction[] }

/**
 * Copy, then retry, edit and fork, as icon buttons under a message. Each one's label is its tooltip (DESIGN.md). Copy turns
 * into a check for 1.5s instead of toasting, and an action that waits on the main process spins until it settles. Hidden
 * until the message is hovered or something in it has focus (DESIGN.md), but the row keeps its height so nothing shifts.
 * `more` ends the row with a "..." menu, whose button spins for the entry that is running. `meta` leads the row with a
 * finished turn's time, which stays when the icons hide (KERNEL-346). `quiet` hides the time too until hover or focus, on every turn but the last (KERNEL-1025).
 */
export function MessageActions({ copy, items = [], more, meta, quiet, align = 'start', label }: { copy?: string; items?: MessageAction[]; more?: MoreActions; meta?: string; quiet?: boolean; align?: 'start' | 'end'; label: string }) {
  const [busy, run] = useBusy()
  const acts = (
    <div className="msg-acts" data-align={align} data-busy={(more && more.items.some((a) => a.label === busy)) || undefined} role="group" aria-label={label}>
      {copy !== undefined && <CopyButton text={copy} label="Copy" />}
      {items.map((a) => (
        <IconButton key={a.label} icon={a.icon} size={14} label={a.label} busy={busy === a.label} busyLabel={a.busyLabel} disabled={busy !== null}
          onClick={() => void run(a.label, async () => a.onClick())} />
      ))}
      {more && <MoreMenu more={more} busy={busy} run={run} />}
    </div>
  )
  if (meta === undefined) return acts
  return <div className="msg-foot" data-quiet={quiet || undefined}><span className="meta">{meta}</span>{acts}</div>
}

/**
 * Copy alone, for an agent line that isn't the end of its turn (KERNEL-828). It floats in the gap under the line, so it takes no
 * height, and shows on hover and keyboard focus like the full row. There is no Retry or Fork on it: Retry resends the turn's whole
 * message, and a fork copies the files as they are now, so neither belongs on a line with more work to come.
 */
export function CopyOverlay({ text }: { text: string }) {
  return (
    <div className="msg-copy">
      <CopyButton text={text} label="Copy" />
    </div>
  )
}

/** The "..." button and its menu, opening upward since the composer sits just below the last reply. */
function MoreMenu({ more, busy, run }: { more: MoreActions; busy: string | null; run: (key: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const open = useStore((s) => s.ui.menu === more.menu)
  const anchor = useRef<HTMLSpanElement>(null)
  const running = more.items.find((a) => a.label === busy)
  return (
    <span ref={anchor} className="msg-more">
      <IconButton icon="more" size={14} label="More actions" aria-haspopup="menu" aria-expanded={open} busy={!!running} busyLabel={running?.busyLabel} disabled={busy !== null}
        onClick={() => actions.ui.toggleMenu(more.menu)} />
      {open && (
        <Menu label="More actions" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ left: 0, bottom: 'calc(100% + 4px)', width: 232 }}
          items={more.items.map((a) => ({ id: a.label, label: a.label, icon: a.icon, onSelect: () => void run(a.label, async () => a.onClick()) }))} />
      )}
    </span>
  )
}
