import type { Toast } from '@shared/types'
import { call, cleanError } from '../api'
import { actions } from '../store'
import { commandComposer } from '../screens/workspace/composer/bus'
import { setupToasts } from '../screens/onboarding/setupToasts'
import { runRetry } from '../retry'

/**
 * What a toast's action does when pressed. A link opens in the browser. A tab opens in the app, and the app goes to that tab's workspace, since
 * `openTab` only records the tab for a workspace that is not on screen (an agent's comment goes to the workspace that shared the file, not
 * necessarily the one showing it). `go` keeps the tab just opened.
 */
export function runToastAction(action: NonNullable<Toast['action']>) {
  if (action.copy) void navigator.clipboard.writeText(action.copy).catch(() => actions.ui.toast({ title: 'Could not copy', sub: action.copy }))
  if (action.recheck || action.fix) void (action.fix ? call('preflight.fix', { id: action.fix }) : call('preflight.run', undefined)).then((checks) => { actions.system.setPreflight(checks); setupToasts(checks) }).catch((e) => actions.ui.toast({ title: 'Could not check again', sub: cleanError(e) }))
  if (action.retrySetup) void call('projects.retrySetup', { projectId: action.retrySetup }).catch((e) => actions.ui.toast({ title: 'Could not try again', sub: cleanError(e) }))
  if (action.recheckPush) void call('projects.pushCheck', { projectId: action.recheckPush, recheck: true }).catch((e) => actions.ui.toast({ title: 'Could not check again', sub: cleanError(e) }))
  if (action.pickProject) commandComposer('project')
  if (action.retry) runRetry(action.retry)
  if (action.href) void call('system.openExternal', { url: action.href })
  if (action.route) actions.ui.go(action.route)
  if (action.modal) actions.ui.openModal(action.modal)
  if (action.tab) {
    actions.ui.openTab(action.tab.workspaceId, action.tab.id)
    actions.ui.go({ name: 'workspace', workspaceId: action.tab.workspaceId })
  }
}
