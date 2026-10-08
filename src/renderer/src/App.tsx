import { useEffect, type ReactNode } from 'react'
import type { DevUiPage, Modal, Route } from '@shared/types'
import { call } from './api'
import { toggleFocus, toggleRightPanel, toggleSidebar } from './components/PanelToggles'
import { Footer, Sidebar } from './components/Shell'
import { Toasts } from './components/Toasts'
import { actions, getState, useStore } from './store'
import { Tooltips } from './ui'
import { openLead } from './lead'
import { AgentProfile } from './screens/agent/AgentProfile'
import { Board } from './screens/board/Board'
import { Floor } from './screens/floor/Floor'
import { History } from './screens/history/History'
import { Home } from './screens/home/Home'
import { Inbox } from './screens/inbox/Inbox'
import { CheckHooks } from './screens/onboarding/CheckHooks'
import { Checks } from './screens/onboarding/Checks'
import { Loading } from './screens/onboarding/Loading'
import { Welcome } from './screens/onboarding/Welcome'
import { ConfirmRemoveRoom } from './screens/rooms/ConfirmRemoveRoom'
import { ConnectRepo } from './screens/rooms/ConnectRepo'
import { NewRoom } from './screens/rooms/NewRoom'
import { OpenFolder } from './screens/rooms/OpenFolder'
import { Rooms } from './screens/rooms/Rooms'
import { RoomSetup } from './screens/rooms/RoomSetup'
import { CommandPalette } from './screens/search/CommandPalette'
import { roomInView } from './screens/search/model'
import { Settings, SettingsNav } from './screens/settings/Settings'
import { useAppearance } from './screens/settings/appearance'
import { ConfirmRetire } from './screens/team/ConfirmRetire'
import { NewAgent } from './screens/team/NewAgent'
import { Team } from './screens/team/Team'
import { WhatsNew } from './screens/update/WhatsNew'
import { ConfirmArchive } from './screens/workspace/ConfirmArchive'
import { ConfirmDiscard } from './screens/workspace/ConfirmDiscard'
import { NewWorkspace } from './screens/workspace/NewWorkspace'
import { Workspace } from './screens/workspace/Workspace'
import { DevUi } from './ui/DevUi'

/** Routes drawn full window, without the sidebar, like Welcome.png, Setup*.png and Settings*.png. */
const fullWindow = (r: Route) => r.name === 'onboarding' || r.name === 'settings' || r.name === 'devUi'

/** One branch per screen family. Each family's component lives in screens/<family>/, owned by its lane (docs/SCREENS.md). */
function Screen({ route }: { route: Route }): ReactNode {
  switch (route.name) {
    case 'onboarding':
      if (route.step === 'welcome') return <Welcome />
      if (route.step === 'room') return <RoomSetup roomId={route.roomId} />
      return <Checks />
    case 'home': return <Home />
    case 'inbox': return <Inbox />
    case 'history': return <History />
    case 'rooms': return <Rooms />
    case 'floor': return <Floor roomId={route.roomId} />
    case 'board': return <Board roomId={route.roomId} />
    case 'task': return <Board roomId={route.roomId} taskId={route.taskId} />
    case 'team': return <Team roomId={route.roomId} />
    case 'agent': return <AgentProfile roomId={route.roomId} agentId={route.agentId} />
    case 'workspace': return <Workspace workspaceId={route.workspaceId} />
    case 'settings': return <Settings page={route.page} roomId={route.roomId} />
    case 'devUi': return <DevUi page={route.page} />
  }
}

/** The one modal shell's contents (DESIGN.md: one modal at a time). */
function ModalView({ modal }: { modal: Exclude<Modal, null> }): ReactNode {
  switch (modal.name) {
    case 'newWorkspace': return <NewWorkspace roomId={modal.roomId} source={modal.source} />
    case 'search': return <CommandPalette />
    case 'newRoom': return <NewRoom prefill={modal.prefill} />
    case 'connectRepo': return <ConnectRepo />
    case 'openFolder': return <OpenFolder />
    case 'checkHooks': return <CheckHooks />
    case 'newAgent': return <NewAgent roomId={modal.roomId} step={modal.step} prefill={modal.prefill} />
    case 'whatsNew': return <WhatsNew update={modal.update} />
    case 'confirm':
      if (modal.kind === 'archive') return <ConfirmArchive workspaceId={modal.workspaceId} />
      if (modal.kind === 'discard') return <ConfirmDiscard workspaceId={modal.workspaceId} />
      if (modal.kind === 'removeRoom') return <ConfirmRemoveRoom roomId={modal.roomId} />
      return <ConfirmRetire roomId={modal.roomId} agentId={modal.agentId} />
  }
}

/** The room the user is looking at, for shortcuts that act on "this room". */
function currentRoom(): string | undefined {
  const s = getState()
  const r = s.ui.route
  if ('roomId' in r) return r.roomId
  if (r.name === 'workspace') return s.workspaces.find((w) => w.id === r.workspaceId)?.roomId
}

/** Dev builds only: `#/dev/ui` and `#/dev/ui/<page>` open the component gallery. Production has no way to reach it except a fixture forcing the route. */
const devUiPages: DevUiPage[] = ['components', 'display', 'overlays', 'dialogs']
function useDevUiHash() {
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const on = () => {
      const m = /^#\/dev\/ui(?:\/(\w+))?$/.exec(location.hash)
      if (!m) return
      const page = devUiPages.find((p) => p === m[1]) ?? 'components'
      actions.ui.go({ name: 'devUi', page })
    }
    on()
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
}

export function App() {
  useDevUiHash()
  useAppearance()
  const route = useStore((s) => s.ui.route)
  const modal = useStore((s) => s.ui.modal)
  const booted = useStore((s) => s.system.booted)
  const sidebar = useStore((s) => s.ui.sidebar)
  const hidden = booted && !fullWindow(route) && !sidebar
  useEffect(() => { void call('system.trafficLights', { at: hidden ? 'header' : 'sidebar' }).catch(() => undefined) }, [hidden])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      if (e.key === 'k') { e.preventDefault(); actions.ui.openModal({ name: 'search' }) }
      if (e.key === ',') { e.preventDefault(); actions.ui.go({ name: 'settings', page: 'general' }) }
      if (e.key === '\\') { e.preventDefault(); toggleFocus() }
      // Option turns B into ∫, so match the physical key.
      if (e.code === 'KeyB' && !e.shiftKey) { e.preventDefault(); if (e.altKey) toggleRightPanel(); else toggleSidebar() }
      if (e.key.toLowerCase() === 'n' && e.shiftKey) { e.preventDefault(); actions.ui.openModal({ name: 'newWorkspace', roomId: currentRoom() }) }
      // The Lead's chat in the room in view, or the first room when none is (Home, Inbox).
      if (e.code === 'KeyL' && e.shiftKey && !e.altKey) {
        e.preventDefault()
        const s = getState()
        const room = roomInView(s.ui.route, s.rooms, s.workspaces)
        if (room) void openLead(room.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!booted || (route.name === 'onboarding' && route.step === 'loading')) return <div className="app"><Loading /></div>
  return (
    <div className="app" data-sidebar={hidden ? 'hidden' : undefined}>
      {route.name === 'settings' && <SettingsNav page={route.page} roomId={route.roomId} />}
      {!fullWindow(route) && sidebar && <Sidebar />}
      <div className="main" style={fullWindow(route) ? { padding: 8 } : undefined}>
        <Screen route={route} />
        {route.name !== 'onboarding' && route.name !== 'devUi' && <Footer />}
      </div>
      {modal && <ModalView modal={modal} />}
      <Toasts />
      <Tooltips />
    </div>
  )
}
