import { call } from '../api'
import { actions, useStore } from '../store'
import { Toast, ToastStack } from '../ui'
import './toasts.css'

/** `ui.toasts`, bottom right of the main panel (WorkspaceToast.png). Each one leaves after 2.6s, or stays while hovered. */
export function Toasts() {
  const toasts = useStore((s) => s.ui.toasts)
  if (!toasts.length) return null
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
      </ToastStack>
    </div>
  )
}
