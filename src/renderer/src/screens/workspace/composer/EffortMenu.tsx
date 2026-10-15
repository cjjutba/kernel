import { useEffect, useRef, type KeyboardEvent } from 'react'
import { EFFORT_LABELS, type Effort, type Provider } from '@shared/types'
import { Button, Icon } from '../../../ui'
import { useLayer } from '../../../ui/hooks'
import { effortLabel } from './modelPrefs'
import { effortsOf, useProviderModels } from './providerModels'

/**
 * The effort of one chat, in its own menu from its own button after the model: the model's levels, a check on the current one and a quiet
 * Default tag on the model's own default. Arrow keys move, Enter picks, Escape closes.
 */
function EffortMenu({ anchorRef, efforts, effort, defaultEffort, onPick, onClose }: {
  anchorRef: React.RefObject<HTMLElement | null>; efforts: Effort[]; effort: Effort; defaultEffort?: Effort; onPick: (e: Effort) => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose, onOutside: onClose, ref, anchorRef })
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]

  useEffect(() => {
    const list = items()
    ;(list.find((el) => el.getAttribute('aria-checked') === 'true') ?? list[0])?.focus({ preventScroll: true })
    const trigger = anchorRef.current?.querySelector<HTMLElement>('button')
    // Closing from the keyboard would leave focus on the page's body, so it goes back to the button. A press elsewhere keeps its own.
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
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); onClose() }
  }

  return (
    <div ref={ref} className="menu cmp-pop eff-pop" role="menu" aria-label="Effort" onKeyDown={onKey}>
      <p className="mode-head" aria-hidden="true">Effort</p>
      {efforts.map((x) => (
        <button key={x} type="button" role="menuitemradio" aria-checked={x === effort} className="menu-item eff-row" onClick={() => onPick(x)}>
          <span className="grow">{EFFORT_LABELS[x]}</span>
          {x === defaultEffort && <span className="eff-tag">Default</span>}
          {x === effort && <Icon name="check" size={14} />}
        </button>
      ))}
    </div>
  )
}

/** The effort button of the toolbar, between the model and the permission mode: a chat's composer and New chat both draw it, with its menu over it. */
export function EffortButton({ provider, model, effort, open, onOpen, onPick, disabled }: {
  provider: Provider; model: string; effort: Effort; open: boolean; disabled?: boolean
  onOpen: (open: boolean) => void; onPick: (e: Effort) => void
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const models = useProviderModels(provider)
  return (
    <span ref={anchor} style={{ position: 'relative' }}>
      <Button variant="ghost" className="cmp-model cmp-effort" disabled={disabled} aria-label={`Effort: ${effortLabel(effort)}`} aria-haspopup="menu" aria-expanded={open} onClick={() => onOpen(!open)}>
        <span className="cmp-mode-name">{effortLabel(effort)}</span><Icon name="chevron" size={12} />
      </Button>
      {open && <EffortMenu anchorRef={anchor} efforts={effortsOf(model, models)} effort={effort} defaultEffort={models.find((m) => m.id === model)?.defaultEffort} onPick={(e) => { onPick(e); onOpen(false) }} onClose={() => onOpen(false)} />}
    </span>
  )
}
