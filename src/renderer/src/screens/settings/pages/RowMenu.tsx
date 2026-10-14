import { useRef, useState } from 'react'
import { IconButton, Menu, type MenuEntry } from '../../../ui'

/** The ⋯ button at the end of a list row and the menu under it (Agents, Variables; KERNEL-680). */
export function RowMenu({ label, items }: { label: string; items: MenuEntry[] }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  return (
    <span className="ag-more" ref={anchor}>
      <IconButton icon="more" size={14} label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} />
      {open && <Menu label={label} anchorRef={anchor} onClose={() => setOpen(false)} style={{ right: 0, top: 30, width: 168 }} items={items.map((i) => ({ ...i, onSelect: () => { setOpen(false); i.onSelect?.() } }))} />}
    </span>
  )
}
