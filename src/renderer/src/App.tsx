import { Suspense, createElement, lazy, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import type { DevUiPage, Modal, Route } from '@shared/types'
import { call } from './api'
import { SidebarToggle, toggleFocus, toggleRightPanel, toggleSidebar, useFoldPanels } from './components/PanelToggles'
import { Footer, Sidebar } from './components/Shell'
import { Toasts } from './components/Toasts'
import { ConfirmBypass } from './components/ConfirmBypass'
import { askAboutTelemetry, TelemetryAsk } from './components/TelemetryAsk'
import { McpSetUp } from './screens/settings/pages/McpSetUp'
import { actions, getState, useStore } from './store'
import { Tooltips } from './ui'
import { openLead, openNewChat } from './lead'
// Settings loads lazily (below), but its stylesheet stays eager, in the slot the screen's import used to fill. Other screens lean on
// rules in settings.css (the compact .nav-item). A new stylesheet under screens/settings has to be imported here too, or it becomes
// a lazy chunk that lands after tokens.css.
import './screens/workspace/composer/composer.css'
import './screens/workspace/cards/cards.css'
import { History } from './screens/history/History'
import { Inbox } from './screens/inbox/Inbox'
import { ConfirmIssueTaken } from './screens/issues/ConfirmIssueTaken'
import { backToNewChat, startHeld } from './screens/new-workspace/start'
import { useWarmUpNext } from './screens/workspace/warmUpNext'
import { Issues } from './screens/issues/Issues'
import { PullRequests } from './screens/prs/PullRequests'
import { CheckHooks } from './screens/onboarding/CheckHooks'
import { Loading } from './screens/onboarding/Loading'
import { Onboarding } from './screens/onboarding/Onboarding'
import { Splash } from './screens/onboarding/Splash'
import { ConfirmRemoveProject } from './screens/projects/ConfirmRemoveProject'
import { ConfirmDeleteHistory } from './screens/history/ConfirmDeleteHistory'
import { ConnectRepo } from './screens/projects/ConnectRepo'
import { NewProject } from './screens/projects/NewProject'
import { OpenFolder } from './screens/projects/OpenFolder'
import { Projects } from './screens/projects/Projects'
import { ProjectSetup } from './screens/projects/ProjectSetup'
import { CommandPalette } from './screens/search/CommandPalette'
import { projectInView } from './screens/search/model'
import './screens/settings/settings.css'
import { useAppearance } from './screens/settings/appearance'
import { ConfirmRetire } from './screens/agent/ConfirmRetire'
import { NewAgent } from './screens/agent/NewAgent'
import { WhatsNew } from './screens/update/WhatsNew'
import { EnvVarForm } from './screens/settings/pages/EnvVarForm'
import { openSlot, openWorkspaceSlot } from './components/sidebar/slots'
import { ConfirmArchive } from './screens/workspace/ConfirmArchive'
import { ConfirmArchiveChat } from './screens/workspace/ConfirmArchiveChat'
import { ConfirmCloseChats } from './screens/workspace/ConfirmCloseChats'
import { ConfirmDiscard } from './screens/workspace/ConfirmDiscard'
import { ConfirmRevert } from './screens/workspace/ConfirmRevert'
import { LeadNewScreen, Workspace } from './screens/workspace/Workspace'
import { useArchiveLanding } from './screens/workspace/archiveLanding'
import { useArchiveStage } from './screens/workspace/archiveMotion'
import { toggleBottomPanel } from './screens/workspace/bottomSplit'
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
// Settings loads on first visit so it stays out of the main chunk.
const settings = lazyScreen(() => import('./screens/settings/Settings').then((m) => m.Settings))
const settingsNav = lazyScreen(() => import('./screens/settings/Settings').then((m) => m.SettingsNav))
const Settings = settings.Screen
const SettingsNav = settingsNav.Screen

/** Routes drawn full window, without the sidebar column, like Welcome.png and Setup*.png. Settings keeps the column and swaps its list (KERNEL-509). */
const fullWindow = (r: Route) => r.name === 'onboarding' || r.name === 'devUi'

/** One branch per screen family. Each family's component lives in screens/<family>/, owned by its lane. */
function Screen({ route }: { route: Route }): ReactNode {
  switch (route.name) {
    case 'onboarding':
      if (route.step === 'project') return <ProjectSetup projectId={route.projectId} />
      if (route.step === 'checks' || route.step === 'accounts' || route.step === 'team' || route.step === 'loop') return <Onboarding key={route.step} step={route.step} />
      return <Splash />
    case 'inbox': return <Inbox />
    case 'issues': return <Issues issueId={route.issueId} projectId={route.projectId} tracker={route.tracker} />
    case 'prs': return <PullRequests filter={route.filter} />
    case 'history': return <History />
    case 'projects': return <Projects />
    case 'workspace': return <Workspace workspaceId={route.workspaceId} />
    case 'leadNew': return <LeadNewScreen projectId={route.projectId} source={route.source} picks={route.picks} />
    case 'settings': return <Settings page={route.page} projectId={route.projectId} section={route.section} agentId={route.agentId} />
    case 'devUi': return <DevUi page={route.page} />
  }
}

/** The one modal shell's contents (DESIGN.md: one modal at a time). */
function ModalView({ modal }: { modal: Exclude<Modal, null> }): ReactNode {
  switch (modal.name) {
    case 'search': return <CommandPalette />
    case 'newProject': return <NewProject prefill={modal.prefill} />
    case 'connectRepo': return <ConnectRepo />
    case 'openFolder': return <OpenFolder />
    case 'checkHooks': return <CheckHooks />
    case 'newAgent': return <NewAgent projectId={modal.projectId} step={modal.step} prefill={modal.prefill} />
    case 'whatsNew': return <WhatsNew update={modal.update} />
    case 'envVar': return <EnvVarForm projectId={modal.projectId} editName={modal.editName} />
    case 'telemetryAsk': return <TelemetryAsk />
    case 'mcpSetUp': return <McpSetUp provider={modal.provider} accountId={modal.accountId} />
    case 'confirm':
      if (modal.kind === 'archive') return <ConfirmArchive workspaceId={modal.workspaceId} />
      if (modal.kind === 'discard') return <ConfirmDiscard workspaceId={modal.workspaceId} />
      if (modal.kind === 'revert') return <ConfirmRevert workspaceId={modal.workspaceId} checkpointId={modal.checkpointId} start={modal.start} />
      if (modal.kind === 'removeProject') return <ConfirmRemoveProject projectId={modal.projectId} />
      if (modal.kind === 'deleteHistory') return <ConfirmDeleteHistory workspaceIds={modal.workspaceIds} />
      if (modal.kind === 'closeChats') return <ConfirmCloseChats workspaceId={modal.workspaceId} chatIds={modal.chatIds} />
      if (modal.kind === 'archiveChat') return <ConfirmArchiveChat threadId={modal.threadId} />
      // New chat opens this when the issue it starts from has findings (KERNEL-500): Start anyway sends the held chat, Cancel brings the box back.
      if (modal.kind === 'issueTaken') return <ConfirmIssueTaken issue={modal.issue} findings={modal.findings} onStart={() => startHeld(modal.held)} onCancel={() => backToNewChat(modal.held)} />
      if (modal.kind === 'bypass') return <ConfirmBypass projectId={modal.projectId} chatId={modal.chatId} draftKey={modal.draftKey} />
      return <ConfirmRetire projectId={modal.projectId} agentId={modal.agentId} />
  }
}

/** The project the user is looking at, for shortcuts that act on "this project". */
function currentProject(): string | undefined {
  const s = getState()
  const r = s.ui.route
  if ('projectId' in r) return r.projectId
  if (r.name === 'workspace') return s.workspaces.find((w) => w.id === r.workspaceId)?.projectId
}

/** Dev builds only: `#/dev/ui` and `#/dev/ui/<page>` open the component gallery. Production has no way to reach it except a fixture forcing the route. */
const devUiPages: DevUiPage[] = ['components', 'display', 'states', 'overlays', 'dialogs']
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
  useArchiveLanding()
  useArchiveStage()
  const route = useStore((s) => s.ui.route)
  const modal = useStore((s) => s.ui.modal)
  const booted = useStore((s) => s.system.booted)
  useWarmUpNext(booted)
  const sidebar = useStore((s) => s.ui.sidebar)
  // Settings shows the column even with the sidebar hidden (⌘B), so it never counts as hidden: its panel starts at the column's edge, like the app's.
  const settingsOpen = route.name === 'settings'
  const column = !fullWindow(route) && (sidebar || settingsOpen)
  const hidden = booted && !fullWindow(route) && !column
  // Settings is one ⌘, away, so fetch it once the app is idle. Without that, the first ⌘, swaps the window for the loading shell until the chunk lands.
  useEffect(() => {
    if (!booted) return
    const id = requestIdleCallback(() => { settings.warm(); settingsNav.warm() })
    return () => cancelIdleCallback(id)
  }, [booted])
  // Usage data is asked about once, after the first project, in a build that can send it (KERNEL-397).
  const projects = useStore((s) => s.projects.length)
  useEffect(() => { if (booted && route.name !== 'onboarding' && !modal) void askAboutTelemetry() }, [booted, projects, route.name, modal])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌃1 to ⌃9 open the workspaces of the chat in view (KERNEL-814). With no such chat they do nothing and are left to the page.
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const key = /^Digit([1-9])$/.exec(e.code)
        const s = getState()
        if (key && !s.ui.modal && s.ui.route.name !== 'onboarding' && openWorkspaceSlot(Number(key[1]))) e.preventDefault()
        return
      }
      if (!e.metaKey) return
      // ⌘1 to ⌘9 open the project in view's Lead chats, not its workspaces (KERNEL-357). Ctrl is left out because ^⌘1 to 4 pick a model in the composer.
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
      // ⌘K opens search, and closes it when it is already open (like Esc). Over any other modal it does nothing (it would replace that modal) and so it does during onboarding.
      if (e.key === 'k') {
        e.preventDefault()
        const s = getState()
        if (s.ui.modal?.name === 'search') actions.ui.closeModal()
        else if (!s.ui.modal && s.ui.route.name !== 'onboarding') actions.ui.openModal({ name: 'search' })
      }
      // ⌘, opens Settings, and goes back to the app when Settings is already open (like Back to app). A modal over Settings keeps it open.
      if (e.key === ',') {
        e.preventDefault()
        const s = getState()
        if (s.ui.route.name !== 'settings') actions.ui.openSettings()
        else if (!s.ui.modal) actions.ui.leaveSettings()
      }
      if (e.key === '\\') { e.preventDefault(); toggleFocus() }
      // ⌘J collapses or opens the right panel's bottom pane (KERNEL-513). Match the physical key, as ⌘B does.
      if (e.code === 'KeyJ' && !e.shiftKey && !e.altKey && !e.ctrlKey) { e.preventDefault(); toggleBottomPanel() }
      // ⌘B is the sidebar; ⌘⌥B and ⌘⇧B are the right panel (KERNEL-425). Option turns B into ∫, so match the physical key.
      if (e.code === 'KeyB' && !(e.shiftKey && e.altKey)) { e.preventDefault(); if (e.altKey || e.shiftKey) toggleRightPanel(); else toggleSidebar() }
      // ⌘N and ⌘⇧N open the New chat page, and go back from it when it is already open (like Esc, so the draft is kept). Over a modal they do nothing, and so do they during onboarding.
      if (e.key.toLowerCase() === 'n' && !e.altKey && !e.ctrlKey) {
        e.preventDefault()
        const s = getState()
        if (s.ui.modal || s.ui.route.name === 'onboarding') return
        if (s.ui.route.name === 'leadNew') actions.ui.back()
        else openNewChat(currentProject())
      }
      // The Lead's chat in the project in view, or the first project when none is (Inbox, History).
      if (e.code === 'KeyL' && e.shiftKey && !e.altKey) {
        e.preventDefault()
        const s = getState()
        const project = projectInView(s.ui.route, s.projects, s.workspaces)
        if (project) void openLead(project.id)
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
      <div className="app app-col" data-sidebar={hidden ? 'hidden' : undefined}>
        <div className="app-body">
          {column && <Sidebar settingsList={route.name === 'settings' ? <SettingsNav page={route.page} projectId={route.projectId} section={route.section} /> : undefined} />}
          <div className="main" style={fullWindow(route) ? { padding: 8 } : undefined}>
            <Screen route={route} />
          </div>
        </div>
        {!fullWindow(route) && <Footer />}
        {/* Once, at a fixed spot, so it is the same element with the sidebar open or hidden. Settings has no toggle: its column can't be hidden. */}
        {!fullWindow(route) && route.name !== 'settings' && <SidebarToggle />}
        {modal && <ModalView modal={modal} />}
        <Toasts />
        <Tooltips />
      </div>
    </Suspense>
  )
}
