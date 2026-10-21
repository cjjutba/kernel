import { useEffect, useRef } from 'react'
import type { Approval, Decision } from '@shared/types'
import { call } from '../../api'
import { actions, getState } from '../../store'
import { attempt } from './MessageActions'
import { bottomKindOf } from './bottomSplit'
import { runningRuns } from './runScripts'

/** The request ⌘↵ and ⌘⌫ answer: the oldest permission request waiting in the open chat. A plan or a question has its own keys. */
export function pendingRequest(approvals: Approval[], chatId: string | undefined): Approval | undefined {
  if (!chatId) return undefined
  return approvals.filter((a) => a.status === 'pending' && a.chatId === chatId && a.kind === 'tool').sort((a, b) => a.createdAt - b.createdAt)[0]
}

/** A field with something typed in keeps ⌘↵ and ⌘⌫ for itself. An empty composer doesn't. */
export function typingIn(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.length > 0
  return el.isContentEditable && (el.textContent ?? '').length > 0
}

/** Which run script ⌘R acts on: the first that is running, which it stops, else the project's first, which it starts. */
export function runTarget(running: string[], listed: string[]): { name: string; stop: boolean } {
  return running.length ? { name: running[0], stop: true } : { name: listed[0] ?? 'run', stop: false }
}

/**
 * The workspace's shortcuts from Settings, Shortcuts that no button owns (KERNEL-539). ⌘⇧D opens All changes. ⌘R starts the
 * run script or stops the one running, and shows the Run tab; main hands it over as `kernel:run-script`, since the View menu's
 * Reload would take it first. ⌘↵ and ⌘⌫ allow or deny the open chat's permission request. None fires while a modal is open.
 */
export function useWorkspaceShortcuts(o: { workspaceId: string; chatId?: string; openDiff: (path: string) => void }) {
  const latest = useRef(o)
  latest.current = o
  useEffect(() => {
    const decide = (a: Approval, decision: Decision) => attempt('Could not send your answer', async () => actions.approvals.upsert(await call('approvals.decide', { id: a.id, decision })))
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.metaKey || e.ctrlKey || e.altKey || e.isComposing || getState().ui.modal) return
      const { chatId, openDiff } = latest.current
      if (e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); openDiff(''); return }
      if (e.shiftKey || (e.key !== 'Enter' && e.key !== 'Backspace') || typingIn(document.activeElement)) return
      const a = pendingRequest(getState().approvals, chatId)
      if (!a) return
      e.preventDefault()
      void decide(a, e.key === 'Enter' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied in Kernel.' })
    }
    const onRun = () => {
      const s = getState()
      const { workspaceId } = latest.current
      const ws = s.workspaces.find((w) => w.id === workspaceId)
      if (!ws || s.ui.modal) return
      const listed = (s.projectSettings[ws.projectId]?.runScripts ?? []).map((r) => r.name)
      const t = runTarget(runningRuns(s, workspaceId), listed)
      actions.ui.setWorkspaceView({ bottom: 'run' })
      actions.ui.setBottomCollapsed(bottomKindOf(s, ws), false)
      if (t.stop) void attempt(`Could not stop ${t.name}`, () => call('scripts.stop', { workspaceId, kind: 'run', name: t.name }))
      else {
        actions.workspaces.clearScriptExit(workspaceId, 'run', t.name)
        void attempt(`Could not start ${t.name}`, () => call('scripts.run', { workspaceId, kind: 'run', name: t.name }))
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('kernel:run-script', onRun)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('kernel:run-script', onRun) }
  }, [])
}
