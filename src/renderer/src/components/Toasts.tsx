import { call } from '../api'
import { actions, useStore } from '../store'
import { Toast, ToastStack } from '../ui'
import { usePrToasts } from '../screens/workspace/pr/usePrToasts'
import { UpdateCard } from './UpdateCard'
import './toasts.css'

/**
 * `ui.toasts`, bottom right of the main panel (WorkspaceToast.png). Each one leaves after 2.6s, or stays while hovered.
 * The update card sits last, under them (KERNEL-164). The stack stays mounted so a closed card stays closed.
 */
export function Toasts() {
  usePrToasts()
  const toasts = useStore((s) => s.ui.toasts)
  return (
    <div className="app-toasts">
      <ToastStack>
        {toasts.map((t) => (
          <Toast
            key={t.id} title={t.title} sub={t.sub} onDismiss={() => actions.ui.dismissToast(t.id)}
            // A plain link would navigate the app window away, so the action opens its link in the browser.
            action={t.action && { label: t.action.label, onClick: () => { const href = t.action?.href; if (href) void call('system.openExternal', { url: href }); actions.ui.dismissToast(t.id) } }}
          />
        ))}
        <UpdateCard />
      </ToastStack>
    </div>
  )
}
