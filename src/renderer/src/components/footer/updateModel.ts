import type { AppUpdate, ToastAction } from '@shared/types'
import { readSaved, writeSaved } from '../../remember'

const OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ENETDOWN|ENETUNREACH|EAI_AGAIN|offline/i
const UNREACHABLE = /ERR_CONNECTION|ERR_TIMED_OUT|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ESOCKETTIMEDOUT|timed? ?out/i

export const updateFailed = (u: AppUpdate | null | undefined): boolean => !!u && !!u.error && u.status !== 'ready' && u.status !== 'downloading'

export const updateDownloading = (u: AppUpdate | null | undefined): boolean => u?.status === 'downloading'

export const downloadPercent = (u: AppUpdate): number => Math.max(0, Math.min(100, Math.round(u.progress ?? 0)))

export type InstallFailed = NonNullable<AppUpdate['installFailed']>

/** The install failure to show: none while a newer update is ready or downloading, which takes precedence (KERNEL-1021). */
export const installFailure = (u: AppUpdate | null | undefined): InstallFailed | undefined =>
  u?.installFailed && u.status !== 'ready' && u.status !== 'downloading' ? u.installFailed : undefined

export const installFailedTitle = (f: InstallFailed): string => `Couldn't install Kernel ${f.version}`

/** Where Download again goes: the releases page, which holds a build whose signature checks out. */
export const RELEASES_URL = 'https://github.com/cjjutba/kernel/releases/latest'

export function updateReason(error: string | undefined, online = true, failed?: InstallFailed): string {
  if (failed) return failed.reason === 'signature' ? "The download's signature didn't match, so Kernel skips it." : 'Kernel will try again later.'
  if (!online || (error && OFFLINE.test(error))) return 'No internet connection'
  if (error && UNREACHABLE.test(error)) return 'Could not reach the update server'
  return 'Could not check for updates'
}

const FAILED_SEEN = 'kernel.installFailedSeen'

/** The toast after a relaunch on a failed install, once per failure. The seen mark is a remembered choice, since main keeps `installFailed` until a different version is offered. */
export function installFailedToast(u: AppUpdate | null | undefined): { title: string; sub: string; glyph: 'error'; action: ToastAction } | null {
  const f = installFailure(u)
  if (!f) return null
  const key = `${f.version} ${f.reason}`
  if (readSaved(FAILED_SEEN) === key) return null
  writeSaved(FAILED_SEEN, key)
  // A build whose signature failed is fixed by a fresh download. Any other failure waits for Kernel's next try, and About says where it stands.
  const action: ToastAction = f.reason === 'signature' ? { label: 'Download again', href: RELEASES_URL, primary: true } : { label: 'Open About', route: { name: 'settings', page: 'about' }, primary: true }
  return { title: installFailedTitle(f), sub: updateReason(undefined, true, f), glyph: 'error', action }
}
