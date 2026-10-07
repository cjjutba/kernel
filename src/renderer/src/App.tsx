import { useEffect } from 'react'
import { Footer, Sidebar } from './components/Shell'
import { FloorScreen } from './screens/Floor'
import { WorkspaceScreen } from './screens/Workspace'
import { BoardScreen, HistoryScreen, HomeScreen, InboxScreen, OnboardingScreen, TeamScreen } from './screens/Pages'
import { NewWorkspaceModal, SearchModal } from './screens/Modals'
import { getState, setState, useStore } from './store'

export function App() {
  const route = useStore((s) => s.route)
  const modal = useStore((s) => s.modal)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      if (e.key === 'k') { e.preventDefault(); setState({ modal: { name: 'search' } }) }
      if (e.key === 'N' && e.shiftKey) { e.preventDefault(); const r = getState().route; setState({ modal: { name: 'newWorkspace', roomId: 'roomId' in r ? r.roomId : undefined } }) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        {route.name === 'onboarding' && <OnboardingScreen />}
        {route.name === 'home' && <HomeScreen />}
        {route.name === 'inbox' && <InboxScreen />}
        {route.name === 'history' && <HistoryScreen />}
        {route.name === 'floor' && <FloorScreen roomId={route.roomId} />}
        {route.name === 'board' && <BoardScreen roomId={route.roomId} />}
        {route.name === 'team' && <TeamScreen roomId={route.roomId} />}
        {route.name === 'workspace' && <WorkspaceScreen workspaceId={route.workspaceId} />}
        <Footer />
      </div>
      {modal?.name === 'newWorkspace' && <NewWorkspaceModal roomId={modal.roomId} />}
      {modal?.name === 'search' && <SearchModal />}
    </div>
  )
}
