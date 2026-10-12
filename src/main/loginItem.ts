import { existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { MessageBoxOptions } from 'electron'
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

/**
 * Where a packaged copy outside Applications runs from, for "Kernel is running from ...", or undefined for an installed copy,
 * a dev run, or a copy in Applications under another name, which Electron won't move (KERNEL-443).
 */
export function runsFrom(copy: CopyInfo): string | undefined {
  if (isInstalledCopy(copy) || !copy.packaged || copy.inApplicationsFolder) return undefined
  // Gatekeeper runs a downloaded app that was never moved from a read-only copy in a random folder.
  if (copy.exePath.includes('/AppTranslocation/')) return 'a temporary copy macOS made'
  if (copy.exePath.startsWith('/Volumes/')) return 'a disk image'
  const bundle = copy.exePath.slice(0, copy.exePath.lastIndexOf('.app/') + 4)
  const folder = dirname(bundle)
  return folder === copy.home ? 'your home folder' : basename(folder)
}

/** The file that says Kernel asked to move, in its data folder. It asks once, whatever the answer. */
export const ASKED_FILE = 'asked-to-move'

/** The dialog that offers the move. "Move to Applications" is response 0. */
export const moveBox = (place: string): MessageBoxOptions => ({
  type: 'question',
  message: 'Move Kernel to Applications so it can update itself?',
  detail: `Kernel is running from ${place}, and it can only install updates from Applications. Kernel quits, moves and opens again.`,
  buttons: ['Move to Applications', "Don't move"],
  defaultId: 0,
  cancelId: 1
})

/** Asked during the move when Applications already has a Kernel that isn't running. "Replace" is response 0. */
export const replaceBox: MessageBoxOptions = {
  type: 'question',
  message: 'Replace the Kernel in Applications?',
  detail: 'The copy already there goes to the Trash.',
  buttons: ['Replace', 'Cancel'],
  defaultId: 0,
  cancelId: 1
}

const failBox = (err: unknown): MessageBoxOptions => ({
  type: 'error',
  message: 'Kernel could not move to Applications',
  detail: `${err instanceof Error ? err.message : String(err)}\n\nDrag Kernel into Applications in Finder, then open it from there.`,
  buttons: ['OK']
})

/**
 * Offers once to move a packaged copy that runs outside Applications, since only there can it update itself (KERNEL-443).
 * `move` is `app.moveToApplicationsFolder`, called only after the user says yes. `moved` means Electron is relaunching
 * the moved copy and this one should stop. A dev run, a headless run and a copy that asked before never show a dialog.
 */
export async function offerMove(o: {
  copy: CopyInfo
  headless: boolean
  dataDir: string
  show: (box: MessageBoxOptions) => Promise<number>
  move: () => boolean
}): Promise<'moved' | 'kept' | 'skipped'> {
  const place = runsFrom(o.copy)
  const asked = join(o.dataDir, ASKED_FILE)
  if (!place || o.headless || existsSync(asked)) return 'skipped'
  const yes = (await o.show(moveBox(place))) === 0
  try {
    if (yes && o.move()) return 'moved'
  } catch (err) {
    console.error('[kernel] could not move to Applications', err)
    await o.show(failBox(err))
  }
  try { writeFileSync(asked, new Date().toISOString()) } catch (err) { console.warn('[kernel] could not save that Kernel asked to move', err) }
  return 'kept'
}
