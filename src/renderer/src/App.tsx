import { useEffect, type ReactNode } from 'react'
import type { Modal, Route } from '@shared/types'
import { Footer, Sidebar } from './components/Shell'
import { actions, getState, useStore } from './store'
import { AgentProfile } from './screens/agent/AgentProfile'
import { Board } from './screens/board/Board'
import { TaskDetail } from './screens/board/TaskDetail'
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
import { Settings } from './screens/settings/Settings'
import { ConfirmRetire } from './screens/team/ConfirmRetire'
import { NewAgent } from './screens/team/NewAgent'
import { Team } from './screens/team/Team'
import { WhatsNew } from './screens/update/WhatsNew'
import { ConfirmArchive } from './screens/workspace/ConfirmArchive'
import { ConfirmDiscard } from './screens/workspace/ConfirmDiscard'
import { NewWorkspace } from './screens/workspace/NewWorkspace'
import { Workspace } from './screens/workspace/Workspace'

/** Routes drawn full window, without the sidebar, like Welcome.png, Setup*.png and Settings*.png. */
const fullWindow = (r: Route) => r.name === 'onboarding' || r.name === 'settings'

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
    case 'task': return <><Board roomId={route.roomId} /><TaskDetail roomId={route.roomId} taskId={route.taskId} /></>
    case 'team': return <Team roomId={route.roomId} />
    case 'agent': return <AgentProfile roomId={route.roomId} agentId={route.agentId} />
    case 'workspace': return <Workspace workspaceId={route.workspaceId} />
    case 'settings': return <Settings page={route.page} roomId={route.roomId} />
  }
}

/** The one modal shell's contents (DESIGN.md: one modal at a time). */
function ModalView({ modal }: { modal: Exclude<Modal, null> }): ReactNode {
  switch (modal.name) {
    case 'newWorkspace': return <NewWorkspace roomId={modal.roomId} />
    case 'search': return <CommandPalette />
    case 'newRoom': return <NewRoom />
    case 'connectRepo': return <ConnectRepo />
    case 'openFolder': return <OpenFolder />
    case 'checkHooks': return <CheckHooks />
    case 'newAgent': return <NewAgent roomId={modal.roomId} step={modal.step} />
    case 'whatsNew': return <WhatsNew />
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

export function App() {
  const route = useStore((s) => s.ui.route)
  const modal = useStore((s) => s.ui.modal)
  const booted = useStore((s) => s.system.booted)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      if (e.key === 'k') { e.preventDefault(); actions.ui.openModal({ name: 'search' }) }
      if (e.key === ',') { e.preventDefault(); actions.ui.go({ name: 'settings', page: 'general' }) }
      if (e.key.toLowerCase() === 'n' && e.shiftKey) { e.preventDefault(); actions.ui.openModal({ name: 'newWorkspace', roomId: currentRoom() }) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!booted) return <div className="app"><div className="main" style={{ padding: 8 }}><Loading /></div></div>
  return (
    <div className="app">
      {!fullWindow(route) && <Sidebar />}
      <div className="main" style={fullWindow(route) ? { padding: 8 } : undefined}>
        <Screen route={route} />
        {route.name !== 'onboarding' && <Footer />}
      </div>
      {modal && <ModalView modal={modal} />}
    </div>
  )
}
