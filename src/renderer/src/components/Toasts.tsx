import { useEffect, useRef, useState } from 'react'
import type { Toast as ToastType } from '@shared/types'
import { actions, useStore } from '../store'
import { useUsageActions } from './footer/useUsageActions'
import { Toast, ToastStack } from '../ui'
import { usePrToasts } from '../screens/workspace/pr/usePrToasts'
import { runToastAction } from './toastAction'
import { UpdateCard } from './UpdateCard'
import './toasts.css'

const UNDO_KBD = '⌘⌥Z'

/**
 * `ui.toasts`, bottom right of the main panel (WorkspaceToast.png). Each one leaves after 5s, or stays while hovered. Swiping
 * it right or down, pressing its action, or Escape (newest first, when nothing else is open) dismisses it sooner. ⌘⌥Z presses
 * the newest toast's action, such as Undo after an account switch. The stack holds three.
 * The update card sits last, under them (KERNEL-164). The stack stays mounted so a closed card stays closed.
 */
export function Toasts() {
  usePrToasts()
  const toasts = useStore((s) => s.ui.toasts)
  const accounts = useStore((s) => s.accounts)
  const { switchTo } = useUsageActions()
  // Undo goes through the footer's own switch. It's left out once the account it returns to is removed or signed out (KERNEL-699).
  const undoable = (a: NonNullable<ToastType['action']>) => !a.switchAccount || accounts.some((x) => x.provider === a.switchAccount?.provider && x.id === a.switchAccount.accountId && x.signedIn)
  const press = (a: NonNullable<ToastType['action']>) => a.switchAccount ? void switchTo(a.switchAccount.provider, a.switchAccount.accountId) : runToastAction(a)
  const [closing, setClosing] = useState<string[]>([])
  const live = toasts.filter((t) => !closing.includes(t.id))
  const keys = useRef({ live, undoable, press })
  keys.current = { live, undoable, press }
  const actionable = [...live].reverse().find((t) => t.action && undoable(t.action))
  useEffect(() => {
    // Bubble phase: a menu, popover or modal takes Escape first (useLayer listens in the capture phase and stops it).
    const onKey = (e: KeyboardEvent) => {
      const { live: now, undoable: can, press: go } = keys.current
      if (e.key === 'Escape' && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const newest = now[now.length - 1]
        if (!newest) return
        e.preventDefault()
        setClosing((c) => [...c, newest.id])
      } else if (e.code === 'KeyZ' && e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey) {
        const target = [...now].reverse().find((t) => t.action && can(t.action))
        if (!target?.action) return
        e.preventDefault()
        go(target.action)
        setClosing((c) => [...c, target.id])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="app-toasts">
      <ToastStack>
        {toasts.map((t) => (
          <Toast
            key={t.id} title={t.title} sub={t.sub} closing={closing.includes(t.id)} onDismiss={() => actions.ui.dismissToast(t.id)}
            // A plain link would navigate the app window away, so the action opens its link in the browser, or its tab in the app.
            action={t.action && undoable(t.action) ? { label: t.action.label, boxed: !!t.action.tab, kbd: t === actionable ? UNDO_KBD : undefined, onClick: () => { if (t.action) press(t.action) } } : undefined}
          />
        ))}
        <UpdateCard />
      </ToastStack>
    </div>
  )
}
