import { useRef, useState } from 'react'
import { EFFORT_LABELS, type Effort, type Provider } from '@shared/types'
import { Icon, ProviderMark } from '../../../ui'
import { ModelPicker } from './ModelPicker'
import { modelLabelOf, useProviderModels } from './providerModels'

/**
 * A model field in a form (New agent, the agent editor): the composer's model and effort control as a chip that opens the same picker
 * under it. `only` limits it to one provider's models, and `both` shows both providers' (Codex dimmed unless `grouped`), with the provider of the pick passed as the third argument (onboarding's Your team, KERNEL-1088). Escape and a pick return focus to the chip.
 */
export function ModelField({ label, provider = 'claude', only, both, grouped, startOpen, model, effort, fallback, onChange, onEffort, disabled, placement = 'down' }: {
  label: string; provider?: Provider; only?: Provider; both?: boolean; grouped?: boolean; startOpen?: boolean; model: string; effort: Effort; fallback?: Effort
  onChange: (model: string, effort: Effort, provider: Provider) => void; onEffort: (effort: Effort) => void; disabled?: boolean; placement?: 'up' | 'down'
}) {
  const [open, setOpen] = useState(!!startOpen)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const models = useProviderModels(provider)
  const codex = useProviderModels('codex')
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
      {open && <ModelPicker variant="settings" only={both ? undefined : only ?? provider} grouped={grouped} placement={placement} anchorRef={wrap} provider={provider} model={model} effort={effort} fallback={fallback ?? effort}
        onModel={(m, e) => { onChange(m, e, codex.some((x) => x.id === m) ? 'codex' : 'claude'); close() }} onEffort={onEffort} onClose={close} />}
    </span>
  )
}
