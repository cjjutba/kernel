import { beforeEach, describe, expect, it } from 'vitest'
import { getState, setState } from '../src/renderer/src/store'
import { tabOf } from '../src/renderer/src/nav'
import { runToastAction } from '../src/renderer/src/components/toastAction'
import type { Chat } from '../src/shared/types'

const chat = (id: string) => ({ id, closed: false }) as Chat

// "Sent to Sean", "Open chat": the comment goes to the workspace that shared the file, which may not be the one showing it.
describe('a toast action that opens a tab', () => {
  beforeEach(() => setState((s) => ({
    chats: { lead: [chat('lead-chat')], sean: [chat('sean-chat')] },
    ui: { ...s.ui, route: { name: 'workspace', workspaceId: 'lead' }, tabs: {} }
  })))

  it("goes to the workspace of the tab, from another workspace's chat", () => {
    runToastAction({ label: 'Open chat', tab: { workspaceId: 'sean', id: 'sean-chat' } })
    const { route } = getState().ui
    expect(route).toEqual({ name: 'workspace', workspaceId: 'sean' })
    expect(tabOf(getState(), 'sean')).toBe('sean-chat')
  })

  it('stays put when the tab is in the workspace on screen', () => {
    runToastAction({ label: 'Open chat', tab: { workspaceId: 'lead', id: 'lead-chat' } })
    expect(getState().ui.route).toEqual({ name: 'workspace', workspaceId: 'lead' })
    expect(tabOf(getState(), 'lead')).toBe('lead-chat')
  })

  it('does not move the app for an action with no tab', () => {
    runToastAction({ label: 'Okay' })
    expect(getState().ui.route).toEqual({ name: 'workspace', workspaceId: 'lead' })
  })
})
