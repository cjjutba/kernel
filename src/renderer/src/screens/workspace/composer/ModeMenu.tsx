import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { Provider } from '@shared/types'
import type { ModeAvailabilities } from '../../../permissionModes'
import { Button, Icon, Kbd } from '../../../ui'
import { useLayer } from '../../../ui/hooks'
import { MODE_ICON, buttonName, modeAria, modeRows, type ComposerMode, type Shown } from './modes'

/**
 * The permission mode of one chat (ComposerModeMenu.png, KERNEL-456): the five modes with a line each, a check on the picked one and
 * the chat's own provider's limits. The dropdown after the model button and Permission mode in the + menu open it. A mode the provider
 * can't run keeps its row, dimmed with the reason, and does nothing. When the chat runs in another mode than it picked, the picked row
 * says which and why. Arrow keys move, Enter picks, Escape closes, and Shift+Tab goes on to the next mode as it does in the box.
 */
export function ModeMenu({ anchorRef, provider, availability, shown, onPick, onCycle, onClose }: {
  anchorRef: React.RefObject<HTMLElement | null>; provider: Provider; availability: ModeAvailabilities | null; shown: Shown
  onPick: (mode: ComposerMode) => void; onCycle: () => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose, onOutside: onClose, ref, anchorRef })
  const rows = modeRows(shown, provider, availability)
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]

  useEffect(() => {
    const list = items()
    ;(list.find((el) => el.getAttribute('aria-checked') === 'true') ?? list[0])?.focus({ preventScroll: true })
    const trigger = anchorRef.current?.querySelector<HTMLElement>('button')
    // Closing from the keyboard would leave focus on the page's body, so it goes back to the dropdown. A press elsewhere keeps its own.
    return () => { if (!document.querySelector('[aria-modal="true"]') && (!document.activeElement || document.activeElement === document.body)) trigger?.focus({ preventScroll: true }) }
  }, [])

  const onKey = (e: KeyboardEvent) => {
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLElement)
    const go = (to: number) => { e.preventDefault(); e.stopPropagation(); list[(to + list.length) % list.length]?.focus() }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(list.length - 1)
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) onCycle(); else onClose() }
  }

  return (
    <div ref={ref} className="menu cmp-pop mode-pop" role="menu" aria-label="Permission mode" onKeyDown={onKey}>
      <p className="mode-head" aria-hidden="true">Permission mode</p>
      {rows.map((r) => (
        <button key={r.mode} type="button" role="menuitemradio" aria-checked={r.checked} aria-disabled={r.off || undefined} className="menu-item mode-row" data-off={r.off || undefined}
          onClick={() => { if (!r.off) onPick(r.mode) }}>
          <Icon name={r.icon} size={16} />
          <span className="mode-tx"><span className="mode-t">{r.name}</span><span className="mode-d" data-why={r.why || undefined}>{r.desc}</span></span>
          {r.checked && <Icon name="check" size={14} />}
        </button>
      ))}
      <div className="menu-sep" role="separator" />
      <div className="mode-foot"><Kbd>⇧ Tab</Kbd>cycles the modes</div>
    </div>
  )
}

/** The permission dropdown of the toolbar, after the model button: a chat's composer and New chat both draw it, with its menu under it. */
export function ModeButton({ provider, availability, shown, open, onOpen, onPick, onCycle }: {
  provider: Provider; availability: ModeAvailabilities | null; shown: Shown; open: boolean
  onOpen: (open: boolean) => void; onPick: (mode: ComposerMode) => void; onCycle: () => void
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  return (
    <span ref={anchor} style={{ position: 'relative' }}>
      <Button variant="ghost" className="cmp-model cmp-mode" data-mode={shown.runs} aria-label={modeAria(shown)} aria-haspopup="menu" aria-expanded={open} onClick={() => onOpen(!open)}>
        <Icon name={MODE_ICON[shown.runs]} size={14} /><span className="cmp-mode-name">{buttonName(shown.runs)}</span><Icon name="chevron" size={12} />
      </Button>
      {open && <ModeMenu anchorRef={anchor} provider={provider} availability={availability} shown={shown} onPick={onPick} onCycle={onCycle} onClose={() => onOpen(false)} />}
    </span>
  )
}
