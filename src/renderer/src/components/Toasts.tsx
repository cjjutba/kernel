import type { Toast as ToastType } from '@shared/types'
import { actions, useStore } from '../store'
import { useUsageActions } from './footer/useUsageActions'
import { Toast, ToastStack } from '../ui'
import { usePrToasts } from '../screens/workspace/pr/usePrToasts'
import { runToastAction } from './toastAction'
import { UpdateCard } from './UpdateCard'
import './toasts.css'

/**
 * `ui.toasts`, bottom right of the main panel (WorkspaceToast.png). Each one leaves after 2.6s, or stays while hovered. Swiping
 * it right or pressing its action dismisses it sooner.
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
  return (
    <div className="app-toasts">
      <ToastStack>
        {toasts.map((t) => (
          <Toast
            key={t.id} title={t.title} sub={t.sub} onDismiss={() => actions.ui.dismissToast(t.id)}
            // A plain link would navigate the app window away, so the action opens its link in the browser, or its tab in the app.
            action={t.action && undoable(t.action) ? { label: t.action.label, boxed: !!t.action.tab, onClick: () => { if (t.action) press(t.action) } } : undefined}
          />
        ))}
        <UpdateCard />
      </ToastStack>
    </div>
  )
}
