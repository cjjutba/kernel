import { join } from 'node:path'
import type { AppSettings } from '@shared/types'

export type CopyInfo = { packaged: boolean; inApplicationsFolder: boolean; exePath: string; home: string }

/**
 * True only for Kernel installed in /Applications or ~/Applications. A dev run, a dist/ build or a
 * translocated copy is something else, and must leave the login item to the installed one.
 */
export function isInstalledCopy({ packaged, inApplicationsFolder, exePath, home }: CopyInfo): boolean {
  if (!packaged || !inApplicationsFolder) return false
  const bundles = ['/Applications/Kernel.app/', join(home, 'Applications', 'Kernel.app') + '/']
  return bundles.some((b) => exePath.startsWith(b))
}

/** What to pass to `app.setLoginItemSettings`, or null to leave the login item alone. */
export function loginItemSettings(installed: boolean, s: AppSettings): { openAtLogin: boolean } | null {
  return installed ? { openAtLogin: s.general.openAtLogin } : null
}
