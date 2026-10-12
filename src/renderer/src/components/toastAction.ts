import type { Toast } from '@shared/types'
import { call } from '../api'
import { actions } from '../store'

/**
 * What a toast's action does when pressed. A link opens in the browser. A tab opens in the app, and the app goes to that tab's workspace, since
 * `openTab` only records the tab for a workspace that is not on screen (an agent's comment goes to the workspace that shared the file, not
 * necessarily the one showing it). `go` keeps the tab just opened.
 */
export function runToastAction(action: NonNullable<Toast['action']>) {
  if (action.href) void call('system.openExternal', { url: action.href })
  if (action.route) actions.ui.go(action.route)
  if (action.tab) {
    actions.ui.openTab(action.tab.workspaceId, action.tab.id)
    actions.ui.go({ name: 'workspace', workspaceId: action.tab.workspaceId })
  }
}
