import type { AppUpdate } from '@shared/types'

/** "0.2.0" reads as "0.2", as on Welcome. */
export const short = (v: string) => v.replace(/^(\d+\.\d+).*/, '$1')

export interface WhatsNewView {
  /** A downloaded update: Later and Restart to update. Otherwise Done. */
  ready: boolean
  title: string
  notes: { title: string; body: string }[]
}

/**
 * Which What's new to show. Right after an update installs, that version's notes. With an update downloaded, the new
 * version's notes and the offer to restart (WhatsNew.png). Otherwise, the running version's notes (KERNEL-154): the
 * sidebar, the account menu and the palette open it whatever the updater is doing.
 */
export function whatsNewView(u: AppUpdate | null | undefined): WhatsNewView {
  if (u?.installed && u.version) return { ready: false, title: `What's new in Kernel ${short(u.version)}`, notes: u.notes ?? [] }
  if (u?.status === 'ready' && u.version) return { ready: true, title: `Kernel ${short(u.version)} is ready`, notes: u.notes ?? [] }
  return { ready: false, title: u?.current ? `What's new in Kernel ${short(u.current)}` : "What's new in Kernel", notes: u?.currentNotes ?? [] }
}
