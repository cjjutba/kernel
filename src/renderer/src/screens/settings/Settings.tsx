import './settings.css'
import type { ReactNode } from 'react'
import type { SettingsPage } from '@shared/types'
import { PlaceholderPage } from '../../components/Placeholder'
import { useSettings } from './useSettings'
import { About } from './pages/About'
import { Account } from './pages/Account'
import { Appearance } from './pages/Appearance'
import { Experimental } from './pages/Experimental'
import { General } from './pages/General'
import { Models } from './pages/Models'
import { Notifications } from './pages/Notifications'
import { Permissions } from './pages/Permissions'
import { Shortcuts } from './pages/Shortcuts'

export { SettingsNav } from './SettingsNav'

/** The page to the right of the Settings nav. Pages for projects and rooms are KERNEL-26's and show their placeholder in the same shell. */
export function Settings({ page }: { page: SettingsPage; roomId?: string }) {
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
  else body = <PlaceholderPage title={`Settings: ${page}`} issue="KERNEL-26" />
  return <div className="panel">{body}</div>
}
