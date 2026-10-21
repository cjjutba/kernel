import { useState } from 'react'

/**
 * What the Files and Changes tabs have open in their right pane (Pen 9.3, 9.5), by workspace and tab. It outlives the tab, so coming back from Review finds the same file, and it goes with the
 * window like any pick that is only a view of the worktree.
 */
const picks = new Map<string, string>()

export function usePick(workspaceId: string, tab: 'file' | 'diff'): [string | undefined, (path: string) => void] {
  const [, bump] = useState(0)
  const key = `${workspaceId}\0${tab}`
  return [picks.get(key), (path) => { picks.set(key, path); bump((n) => n + 1) }]
}
