import { useEffect, useRef } from 'react'
import type { PrState } from '@shared/types'
import { actions, getState, useStore } from '../../../store'
import { prToast } from './model'

/** Toasts for PR state changes from main: created, merged, and a create that ended without a PR. Mounted once, by `Toasts`. */
export function usePrToasts() {
  const workspaces = useStore((s) => s.workspaces)
  const prev = useRef<Map<string, PrState> | null>(null)
  useEffect(() => {
    const before = prev.current
    prev.current = new Map(workspaces.map((w) => [w.id, w.prState]))
    if (!before) return
    const s = getState()
    for (const w of workspaces) {
      const agent = s.agents[w.roomId]?.find((a) => a.id === w.agentId)?.name
      const t = prToast(before.get(w.id), w, { method: s.settings?.pr.mergeMethod, agent })
      if (t) actions.ui.toast(t)
    }
  }, [workspaces])
}
