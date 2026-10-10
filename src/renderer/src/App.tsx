import { Suspense, createElement, lazy, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import type { DevUiPage, Modal, Route } from '@shared/types'
import { call } from './api'
import { toggleFocus, toggleRightPanel, toggleSidebar, useFoldPanels } from './components/PanelToggles'
import { Footer, Sidebar } from './components/Shell'
import { Toasts } from './components/Toasts'
import { actions, getState, useStore } from './store'
import { Tooltips } from './ui'
import { openLead } from './lead'
import { AgentProfile } from './screens/agent/AgentProfile'
// Floor, Board and Settings load lazily (below), but their stylesheets stay eager, in the slots those screens' imports used to fill.
// Other screens lean on rules in floor.css and settings.css (.agent-dot, the compact .nav-item), and `.log-all` has to come before
// tokens.css's `.btn` to lose the tie, as FloorEmpty.png draws it. A new stylesheet under screens/floor, board or settings has to be
// imported here too, or it becomes a lazy chunk that lands after tokens.css.
import './screens/board/board.css'
import './screens/workspace/composer/composer.css'
import './screens/workspace/cards/cards.css'
import './screens/floor/moments/moments.css'
import './screens/floor/logs.css'
import './screens/floor/floor.css'
import { History } from './screens/history/History'
import { Home } from './screens/home/Home'
import { Inbox } from './screens/inbox/Inbox'
import { Issues } from './screens/issues/Issues'
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
import './screens/settings/settings.css'
import { useAppearance } from './screens/settings/appearance'
import { ConfirmRetire } from './screens/team/ConfirmRetire'
import { NewAgent } from './screens/team/NewAgent'
import { Team } from './screens/team/Team'
import { WhatsNew } from './screens/update/WhatsNew'
import { EnvVarForm } from './screens/settings/pages/EnvVarForm'
import { openSlot } from './components/sidebar/slots'
import { ConfirmArchive } from './screens/workspace/ConfirmArchive'
import { ConfirmCloseChats } from './screens/workspace/ConfirmCloseChats'
import { ConfirmDiscard } from './screens/workspace/ConfirmDiscard'
import { NewWorkspace } from './screens/workspace/NewWorkspace'
import { Workspace } from './screens/workspace/Workspace'
import { DevUi } from './ui/DevUi'

/**
 * React.lazy, plus a warm path. Route changes here are synchronous (the store is a useSyncExternalStore), and a lazy component
 * suspends on its first render even when its chunk is already in memory, which flashes the fallback. Once `warm()` has run, a
 * screen that mounts afterwards renders straight away. One that mounted cold keeps its lazy wrapper, so it never remounts.
 */
function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | undefined
  const fetch = () => load().then((c) => (loaded = c))
  const Lazy = lazy(() => fetch().then((component) => ({ default: component })))
  const Screen = (props: P) => {
    const [Ready] = useState(() => loaded)
    return Ready ? createElement(Ready, props) : createElement(Lazy as ComponentType<P>, props)
  }
  return { Screen, warm: () => void fetch() }
}
// Settings, and the hidden Floor and Board (D-104), load on first visit so they stay out of the main chunk.
const Board = lazy(() => import('./screens/board/Board').then((m) => ({ default: m.Board })))
const Floor = lazy(() => import('./screens/floor/Floor').then((m) => ({ default: m.Floor })))
const settings = lazyScreen(() => import('./screens/settings/Settings').then((m) => m.Settings))
const settingsNav = lazyScreen(() => import('./screens/settings/Settings').then((m) => m.SettingsNav))
const Settings = settings.Screen
const SettingsNav = settingsNav.Screen

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
    case 'issues': return <Issues issueId={route.issueId} />
    case 'history': return <History />
    case 'rooms': return <Rooms />
    case 'floor': return <Floor roomId={route.roomId} />
    case 'board': return <Board roomId={route.roomId} />
    case 'task': return <Board roomId={route.roomId} taskId={route.taskId} />
    case 'team': return <Team roomId={route.roomId} />
    case 'agent': return <AgentProfile roomId={route.roomId} agentId={route.agentId} />
    case 'workspace': return <Workspace workspaceId={route.workspaceId} />
    case 'settings': return <Settings page={route.page} roomId={route.roomId} section={route.section} />
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
    case 'envVar': return <EnvVarForm roomId={modal.roomId} editName={modal.editName} />
    case 'confirm':
      if (modal.kind === 'archive') return <ConfirmArchive workspaceId={modal.workspaceId} />
      if (modal.kind === 'discard') return <ConfirmDiscard workspaceId={modal.workspaceId} />
      if (modal.kind === 'removeRoom') return <ConfirmRemoveRoom roomId={modal.roomId} />
      if (modal.kind === 'closeChats') return <ConfirmCloseChats workspaceId={modal.workspaceId} chatIds={modal.chatIds} />
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

/** Back or forward, unless a modal is open or setup is on screen. */
function stepHistory(dir: 'back' | 'forward') {
  const s = getState()
  if (s.ui.modal || s.ui.route.name === 'onboarding') return
  actions.ui[dir]()
}

export function App() {
  useDevUiHash()
  useAppearance()
  useFoldPanels()
  const route = useStore((s) => s.ui.route)
  const modal = useStore((s) => s.ui.modal)
  const booted = useStore((s) => s.system.booted)
  const sidebar = useStore((s) => s.ui.sidebar)
  const hidden = booted && !fullWindow(route) && !sidebar
  // Settings is one ⌘, away, so fetch it once the app is idle. Without that, the first ⌘, swaps the window for the loading shell until the chunk lands.
  useEffect(() => {
    if (!booted) return
    const id = requestIdleCallback(() => { settings.warm(); settingsNav.warm() })
    return () => cancelIdleCallback(id)
  }, [booted])
  useEffect(() => { void call('system.trafficLights', { at: hidden ? 'header' : 'sidebar' }).catch(() => undefined) }, [hidden])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      // ⌘1 to ⌘9 open the room in view's Team, Lead and workspaces. Ctrl is left out because ^⌘1 to 4 pick a model in the composer.
      const digit = /^Digit([1-9])$/.exec(e.code)
      if (digit && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const s = getState()
        if (!s.ui.modal && s.ui.route.name !== 'onboarding') { e.preventDefault(); openSlot(Number(digit[1])) }
        return
      }
      // ⌘[ and ⌘] go back and forward, as in Slack and Linear. Not with a modal open or during setup, like ⌘1 to ⌘9.
      if ((e.code === 'BracketLeft' || e.code === 'BracketRight') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        stepHistory(e.code === 'BracketLeft' ? 'back' : 'forward')
        return
      }
      if (e.key === 'k') { e.preventDefault(); actions.ui.openModal({ name: 'search' }) }
      if (e.key === ',') { e.preventDefault(); actions.ui.openSettings() }
      if (e.key === '\\') { e.preventDefault(); toggleFocus() }
      // Option turns B into ∫, so match the physical key.
      if (e.code === 'KeyB' && !e.shiftKey) { e.preventDefault(); if (e.altKey) toggleRightPanel(); else toggleSidebar() }
      if (e.key.toLowerCase() === 'n' && e.shiftKey) { e.preventDefault(); actions.ui.openModal({ name: 'newWorkspace', roomId: currentRoom() }) }
      // ⌘N does the same, but not over a modal (it would reset the New chat prompt) or during onboarding.
      if (e.key === 'n' && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault()
        const s = getState()
        if (!s.ui.modal && s.ui.route.name !== 'onboarding') actions.ui.openModal({ name: 'newWorkspace', roomId: currentRoom() })
      }
      // The Lead's chat in the room in view, or the first room when none is (Home, Inbox).
      if (e.code === 'KeyL' && e.shiftKey && !e.altKey) {
        e.preventDefault()
        const s = getState()
        const room = roomInView(s.ui.route, s.rooms, s.workspaces)
        if (room) void openLead(room.id)
      }
    }
    // A mouse's back button is 3 and its forward button 4.
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      stepHistory(e.button === 3 ? 'back' : 'forward')
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouseUp)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mouseup', onMouseUp) }
  }, [])
  if (!booted || (route.name === 'onboarding' && route.step === 'loading')) return <div className="app"><Loading /></div>
  // While a screen's chunk loads, show the boot shell again. `data-lazy` lets scripts/shots.ts wait for it to go.
  return (
    <Suspense fallback={<div className="app" data-lazy="pending"><Loading /></div>}>
      <div className="app" data-sidebar={hidden ? 'hidden' : undefined}>
        {route.name === 'settings' && <SettingsNav page={route.page} roomId={route.roomId} section={route.section} />}
        {!fullWindow(route) && sidebar && <Sidebar />}
        <div className="main" style={fullWindow(route) ? { padding: 8 } : undefined}>
          <Screen route={route} />
          {route.name !== 'onboarding' && route.name !== 'devUi' && <Footer />}
        </div>
        {modal && <ModalView modal={modal} />}
        <Toasts />
        <Tooltips />
      </div>
    </Suspense>
  )
}
