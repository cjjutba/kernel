import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentDef } from '@shared/types'
import { KERNEL_REVIEWER, NO_REVIEWER } from '@shared/team'
import { Icon } from '../../ui'
import { useLayer } from '../../ui/hooks'
import './rooms.css'

interface Choice { value: string; label: string; sub?: string }

/**
 * The Reviewer picker on RoomSetupTeam.png (KERNEL-551): the team's reviewer agents, then Kernel's code review, then No reviewer
 * under a rule. An agent shows its role under its name. Arrow keys move, Enter picks, Escape closes and returns to the button.
 */
export function ReviewerPicker({ value, agents, disabled, labelledBy, onChange }: { value: string; agents: AgentDef[]; disabled?: boolean; labelledBy: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const choices: Choice[] = [
    ...agents.map((a) => ({ value: a.id, label: a.name, sub: a.role || undefined })),
    { value: KERNEL_REVIEWER, label: 'Kernel’s code review', sub: 'Kernel reviews each pull request' }
  ]
  const none: Choice = { value: NO_REVIEWER, label: 'No reviewer', sub: 'No code review runs by itself' }
  const all = [...choices, none]
  const current = all.find((c) => c.value === value) ?? choices[choices.length - 1]

  const close = (restore = true) => { setOpen(false); if (restore) button.current?.focus() }
  useLayer({ onEscape: close, onOutside: () => close(false), ref: list, anchorRef: wrap }, open)
  useEffect(() => { if (open) (list.current?.querySelector<HTMLElement>('[aria-selected=true]') ?? list.current?.querySelector<HTMLElement>('[role=option]'))?.focus({ preventScroll: true }) }, [open])

  const pick = (v: string) => { close(); if (v !== value) onChange(v) }
  const move = (e: KeyboardEvent) => {
    const nodes = [...(list.current?.querySelectorAll<HTMLElement>('[role=option]') ?? [])]
    const i = nodes.indexOf(document.activeElement as HTMLElement)
    const to = e.key === 'ArrowDown' ? (i + 1) % nodes.length : e.key === 'ArrowUp' ? (i - 1 + nodes.length) % nodes.length : e.key === 'Home' ? 0 : e.key === 'End' ? nodes.length - 1 : -1
    if (to < 0) { if (e.key === 'Tab') close(false); return }
    e.preventDefault()
    nodes[to]?.focus()
  }
  const option = (c: Choice) => (
    <button key={c.value} type="button" role="option" aria-selected={c.value === value} tabIndex={-1} className="menu-item rs-opt" data-sub={c.sub ? '' : undefined} onClick={() => pick(c.value)}>
      <span className="rs-opt-text"><span>{c.label}</span>{c.sub && <span className="rs-opt-sub">{c.sub}</span>}</span>
      {c.value === value && <Icon name="check" size={14} />}
    </button>
  )

  return (
    <span ref={wrap} className="rs-pick-wrap">
      <button
        ref={button} type="button" className="rs-pick" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} aria-labelledby={`${labelledBy} ${id}-value`} disabled={disabled}
        onClick={() => setOpen((o) => !o)} onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true) } }}
      >
        <span id={`${id}-value`}>{current.label}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div ref={list} id={id} role="listbox" aria-labelledby={labelledBy} className="menu rs-menu" onKeyDown={move}>
          {choices.map(option)}
          <div role="separator" className="menu-sep" />
          {option(none)}
        </div>
      )}
    </span>
  )
}
