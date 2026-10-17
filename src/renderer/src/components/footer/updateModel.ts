import type { AppUpdate } from '@shared/types'
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

export const installFailedTitle = (f: InstallFailed): string => `Version ${f.version} couldn't install`

export function updateReason(error: string | undefined, online = true, failed?: InstallFailed): string {
  if (failed) return failed.reason === 'signature' ? "This copy of Kernel can't install updates. Download the latest version from GitHub." : 'Kernel will try again later'
  if (!online || (error && OFFLINE.test(error))) return 'No internet connection'
  if (error && UNREACHABLE.test(error)) return 'Could not reach the update server'
  return 'Could not check for updates'
}

const FAILED_SEEN = 'kernel.installFailedSeen'

/** The toast after a relaunch on a failed install, once per failure. The seen mark is a remembered choice, since main keeps `installFailed` until a different version is offered. */
export function installFailedToast(u: AppUpdate | null | undefined): { title: string; sub: string } | null {
  const f = installFailure(u)
  if (!f) return null
  const key = `${f.version} ${f.reason}`
  if (readSaved(FAILED_SEEN) === key) return null
  writeSaved(FAILED_SEEN, key)
  return { title: installFailedTitle(f), sub: updateReason(undefined, true, f) }
}
