import { useEffect } from 'react'
import type { Effort, Provider } from '@shared/types'
import { effortFor } from '@shared/effort'
import { getState } from '../../../store'
import { nextEffort, useEffortMemory } from './modelPrefs'
import { effortsOf, fitEffort, useProviderModels } from './providerModels'
import { isCycleEffortKey, shortcutModel } from './modelShortcuts'
import { hotkeys, pressedDigit } from '../../../hotkeys'

/**
 * The model and effort keys, for a chat's composer and New chat's alike, with the picker open or closed: ^⌘1 to 9 pick the Nth current model of the
 * provider the box is on (the picker's hints say the same), and ⌘⇧/ cycles the effort. A model comes back at the effort it last ran at, else
 * `fallback`. The open picker handles these keys itself and marks the event, so it is left alone.
 */
export function useModelKeys({ provider, model, effort, fallback, onModel, onEffort, enabled = true }: {
  provider: Provider; model: string; effort: Effort; fallback: Effort
  onModel: (model: string, effort: Effort) => void; onEffort: (effort: Effort) => void; enabled?: boolean
}) {
  const models = useProviderModels(provider)
  const memory = useEffortMemory()
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || getState().ui.modal) return
      const n = pressedDigit(e, 'pickModel')
      if (n !== null) {
        const m = shortcutModel(String(n), models)
        if (!m) return
        e.preventDefault()
        onModel(m.id, m.id === model ? effort : fitEffort(effortFor(m.id, memory, fallback), m.id, models))
      } else if (isCycleEffortKey(e, hotkeys().cycleEffort)) {
        e.preventDefault()
        onEffort(nextEffort(effort, effortsOf(model, models)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}
