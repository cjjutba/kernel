import './settings.css'
import type { ReactNode } from 'react'
import type { AppSettings, RoomSettingsSection, SettingsPage } from '@shared/types'
import { useSettings } from './useSettings'
import { About } from './pages/About'
import { Account } from './pages/Account'
import { Appearance } from './pages/Appearance'
import { BigTerminal } from './pages/BigTerminal'
import { Environment } from './pages/Environment'
import { Experimental } from './pages/Experimental'
import { General } from './pages/General'
import { Models } from './pages/Models'
import { Notifications } from './pages/Notifications'
import { Permissions } from './pages/Permissions'
import { Files } from './pages/Files'
import { Git } from './pages/Git'
import { Hooks } from './pages/Hooks'
import { Integrations } from './pages/Integrations'
import { PRs } from './pages/PRs'
import { Room } from './pages/Room'
import { RoomGit } from './pages/RoomGit'
import { RoomInstructions } from './pages/RoomInstructions'
import { RoomPermissions } from './pages/RoomPermissions'
import { RoomScripts } from './pages/RoomScripts'
import { Scripts } from './pages/Scripts'
import { Shortcuts } from './pages/Shortcuts'
import { Skills } from './pages/Skills'
import { Team } from './pages/Team'

export { SettingsNav } from './SettingsNav'

/** The page to the right of the Settings nav. A room's pages are `page: 'room'`, and `section` picks one. */
export function Settings({ page, roomId, section }: { page: SettingsPage; roomId?: string; section?: RoomSettingsSection }) {
  const settings = useSettings()
  let body: ReactNode
  if (page === 'shortcuts') body = <Shortcuts />
  else if (page === 'account') body = <Account />
  else if (page === 'about') body = <About />
  else if (!settings) body = null
  else if (page === 'general') body = <General s={settings} />
  else if (page === 'appearance') body = <Appearance s={settings} />
  else if (page === 'notifications') body = <Notifications s={settings} />
  else if (page === 'models') body = <Models s={settings} />
  else if (page === 'permissions') body = <Permissions s={settings} />
  else if (page === 'env') body = <Environment />
  else if (page === 'experimental') body = <Experimental s={settings} />
  else if (page === 'bigterm') body = <BigTerminal s={settings} />
  else if (page === 'git') body = <Git s={settings} />
  else if (page === 'scripts') body = <Scripts s={settings} />
  else if (page === 'prs') body = <PRs s={settings} />
  else if (page === 'hooks') body = <Hooks s={settings} />
  else if (page === 'integrations') body = <Integrations />
  else if (page === 'room') body = <RoomBody roomId={roomId} section={section} s={settings} />
  return <div className="panel">{body}</div>
}

/** One of a room's pages. Each reads and writes its own room only. */
function RoomBody({ roomId, section = 'general', s }: { roomId?: string; section?: RoomSettingsSection; s: AppSettings }) {
  switch (section) {
    case 'git': return <RoomGit roomId={roomId} s={s} />
    case 'scripts': return <RoomScripts roomId={roomId} />
    case 'files': return <Files roomId={roomId} />
    case 'instructions': return <RoomInstructions roomId={roomId} s={s} />
    case 'permissions': return <RoomPermissions roomId={roomId} />
    case 'agents': return <Team roomId={roomId} s={s} />
    case 'skills': return <Skills roomId={roomId} />
    case 'environment': return <Environment roomId={roomId} />
    default: return <Room roomId={roomId} />
  }
}
