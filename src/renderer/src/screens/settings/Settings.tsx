import './settings.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppSettings, RoomSettingsSection, SettingsPage } from '@shared/types'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Icon } from '../../ui'
import { landWhenThere } from './landOnRow'
import { NAV_PAGES, ROOM_PAGES } from './nav'
import { SettingsPending } from './SettingsLoad'
import { useRoomSettingsLoad, useSettings } from './useSettings'
import { About } from './pages/About'
import { AgentEdit } from './pages/AgentEdit'
import { Agents } from './pages/Agents'
import { Accounts } from './pages/Accounts'
import { Appearance } from './pages/Appearance'
import { BigTerminal } from './pages/BigTerminal'
import { Environment } from './pages/Environment'
import { General } from './pages/General'
import { McpServers } from './pages/McpServers'
import { Models } from './pages/Models'
import { Notifications } from './pages/Notifications'
import { Permissions } from './pages/Permissions'
import { Git } from './pages/Git'
import { Hooks } from './pages/Hooks'
import { Integrations } from './pages/Integrations'
import { PRs } from './pages/PRs'
import { Privacy } from './pages/Privacy'
import { Room } from './pages/Room'
import { RoomGit } from './pages/RoomGit'
import { RoomPermissions } from './pages/RoomPermissions'
import { RoomPrs } from './pages/RoomPrs'
import { RoomSetup } from './pages/RoomSetup'
import { Shortcuts } from './pages/Shortcuts'
import { Skills } from './pages/Skills'
import { Team } from './pages/Team'

export { SettingsNav } from './SettingsNav'

/** The page to the right of the Settings nav. A room's pages are `page: 'room'`, and `section` picks one. */
export function Settings({ page, roomId, section, agentId }: { page: SettingsPage; roomId?: string; section?: RoomSettingsSection; agentId?: string }) {
  const settings = useSettings()
  const [failed, setFailed] = useState(false)
  const load = async () => {
    try {
      actions.settings.set(await call('settings.get', undefined))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }
  useEffect(() => { if (!settings) void load() }, [!!settings])
  let body: ReactNode
  if (page === 'shortcuts') body = <Shortcuts />
  else if (page === 'about') body = <About />
  else if (!settings) body = <SettingsPending title={page === 'room' ? 'Room settings' : NAV_PAGES.find((n) => n.page === page)?.label ?? 'Settings'} failed={failed} what="settings" onRetry={load} />
  else if (page === 'general') body = <General s={settings} />
  else if (page === 'appearance') body = <Appearance s={settings} />
  else if (page === 'notifications') body = <Notifications s={settings} />
  else if (page === 'models') body = <Models s={settings} />
  else if (page === 'agents') body = agentId ? <AgentEdit key={agentId} agentId={agentId} /> : <Agents />
  else if (page === 'accounts') body = <Accounts s={settings} />
  else if (page === 'mcp') body = <McpServers />
  else if (page === 'permissions') body = <Permissions s={settings} />
  else if (page === 'env') body = <Environment />
  else if (page === 'privacy') body = <Privacy s={settings} />
  else if (page === 'bigterm') body = <BigTerminal s={settings} />
  else if (page === 'git') body = <Git s={settings} />
  else if (page === 'prs') body = <PRs s={settings} />
  else if (page === 'hooks') body = <Hooks s={settings} />
  else if (page === 'integrations') body = <Integrations />
  else if (page === 'room') body = <RoomGate roomId={roomId} section={section} agentId={agentId} s={settings} />
  // A search result or a link names a row: land on it once the page has drawn it. The route is a new object for every move, so picking the same result twice lands twice.
  const route = useStore((s) => s.ui.route)
  const panel = useRef<HTMLDivElement>(null)
  const row = route.name === 'settings' ? route.row : undefined
  useEffect(() => (row ? landWhenThere(row, panel.current) : undefined), [route, row, !!settings])
  return <div className="panel" ref={panel}>{body}</div>
}

/** A room's page waits for the room's files, with its title in place, and says so when they don't come. */
function RoomGate({ roomId, section = 'general', agentId, s }: { roomId?: string; section?: RoomSettingsSection; agentId?: string; s: AppSettings }) {
  const room = useStore((st) => st.rooms.find((r) => r.id === roomId))
  const { rs, failed, retry } = useRoomSettingsLoad(roomId)
  if (room && !rs) {
    const crumb = <>{room.name}<span className="set-crumb-sep" aria-hidden="true"><Icon name="right" size={16} /></span></>
    return <SettingsPending title={ROOM_PAGES.find((p) => p.section === section)?.label ?? 'Settings'} crumb={crumb} failed={failed} what={`${room.name} settings`} onRetry={retry} />
  }
  return <RoomBody roomId={roomId} section={section} agentId={agentId} s={s} />
}

/** One of a room's pages. Each reads and writes its own room only. */
function RoomBody({ roomId, section = 'general', agentId, s }: { roomId?: string; section?: RoomSettingsSection; agentId?: string; s: AppSettings }) {
  switch (section) {
    case 'git': return <RoomGit roomId={roomId} s={s} />
    case 'setup': return <RoomSetup roomId={roomId} />
    case 'permissions': return <RoomPermissions roomId={roomId} />
    case 'agents': return agentId && roomId ? <AgentEdit key={`${roomId}/${agentId}`} roomId={roomId} agentId={agentId} /> : <Team roomId={roomId} s={s} />
    case 'prs': return <RoomPrs roomId={roomId} s={s} />
    case 'skills': return <Skills roomId={roomId} />
    case 'environment': return <Environment roomId={roomId} />
    default: return <Room roomId={roomId} />
  }
}
