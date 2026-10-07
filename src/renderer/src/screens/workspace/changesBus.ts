type Listener = (workspaceId: string) => void
const listeners = new Set<Listener>()

/** Ask the open workspace to read its changed files again, after something outside a turn changed them (a discard). */
export function refreshChanges(workspaceId: string) { for (const l of listeners) l(workspaceId) }

export function onRefreshChanges(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
