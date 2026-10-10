import './settings.css'
import type { ReactNode } from 'react'
import type { RoomSettingsSection, SettingsPage } from '@shared/types'
import { useSettings } from './useSettings'
import { About } from './pages/About'
import { Account } from './pages/Account'
import { Appearance } from './pages/Appearance'
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
import { Scripts } from './pages/Scripts'
import { Shortcuts } from './pages/Shortcuts'
import { Skills } from './pages/Skills'
import { Team } from './pages/Team'

export { SettingsNav } from './SettingsNav'

/** The page to the right of the Settings nav. */
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
  else if (page === 'experimental') body = <Experimental s={settings} />
  else if (page === 'git') body = <Git s={settings} />
  else if (page === 'scripts') body = <Scripts s={settings} />
  else if (page === 'prs') body = <PRs s={settings} />
  else if (page === 'hooks') body = <Hooks s={settings} />
  else if (page === 'integrations') body = <Integrations />
  else if (page === 'room' && section === 'files') body = <Files />
  else if (page === 'room' && section === 'agents') body = <Team s={settings} />
  else if (page === 'room' && section === 'skills') body = <Skills />
  else if (page === 'room') body = <Room roomId={roomId} s={settings} />
  return <div className="panel">{body}</div>
}
