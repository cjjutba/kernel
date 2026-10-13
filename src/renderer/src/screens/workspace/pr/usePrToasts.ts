import { useEffect } from 'react'
import type { PrState } from '@shared/types'
import { actions, getState, subscribe } from '../../../store'
import { remoteOf } from '../../settings/remote'
import { prToast } from './model'

/** Toasts for PR state changes from main: created, merged, and a create that ended without a PR. Mounted once, by `Toasts`. */
export function usePrToasts() {
  // Reads the store directly: a workspace changing is no reason to redraw whatever mounts this.
  useEffect(() => {
    let seen = getState().workspaces
    let prev: Map<string, PrState> | null = null
    const check = () => {
      const s = getState()
      if (s.workspaces === seen && prev) return
      seen = s.workspaces
      const before = prev
      prev = new Map(seen.map((w) => [w.id, w.prState]))
      if (!before) return
      for (const w of seen) {
        const agent = s.agents[w.roomId]?.find((a) => a.id === w.agentId)?.name
        // The method Kernel's merge used, which is the room's and can differ from the app's (KERNEL-468).
        const t = prToast(before.get(w.id), w, { method: w.mergedWith ?? s.settings?.pr.mergeMethod, agent, remote: remoteOf(s.roomSettings[w.roomId], s.settings) })
        if (t) actions.ui.toast(t)
      }
    }
    check()
    return subscribe(check)
  }, [])
}
