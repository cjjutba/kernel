import { useRef, useState } from 'react'
import { EFFORT_LABELS, type Effort, type Provider } from '@shared/types'
import { Icon, ProviderMark } from '../../../ui'
import { ModelPicker } from './ModelPicker'
import { modelLabelOf, useProviderModels } from './providerModels'

/**
 * A model field in a form (New agent, the agent editor): the composer's model and effort control as a chip that opens the same picker
 * under it. `only` limits it to one provider's models. Escape and a pick return focus to the chip.
 */
export function ModelField({ label, provider = 'claude', only, model, effort, fallback, onChange, onEffort, disabled, placement = 'down' }: {
  label: string; provider?: Provider; only?: Provider; model: string; effort: Effort; fallback?: Effort
  onChange: (model: string, effort: Effort) => void; onEffort: (effort: Effort) => void; disabled?: boolean; placement?: 'up' | 'down'
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const models = useProviderModels(provider)
  const name = model ? modelLabelOf(model, models) : 'Default'
  const close = () => {
    const at = document.activeElement
    setOpen(false)
    if (!at || at === document.body || wrap.current?.contains(at)) button.current?.focus()
  }
  return (
    <span ref={wrap} className="select">
      <button ref={button} type="button" className="select-trigger ag-chip" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}, ${name}, ${EFFORT_LABELS[effort]}`} onClick={() => (open ? close() : setOpen(true))}>
        <ProviderMark provider={provider} size={14} />
        <span className="ag-chip-name">{name}</span>
        <span className="ag-chip-detail ellipsis">{EFFORT_LABELS[effort]}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && <ModelPicker variant="settings" only={only ?? provider} placement={placement} anchorRef={wrap} provider={provider} model={model} effort={effort} fallback={fallback ?? effort}
        onModel={(m, e) => { onChange(m, e); close() }} onEffort={onEffort} onClose={close} />}
    </span>
  )
}
