import type { AppUpdate } from '@shared/types'

const OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ENETDOWN|ENETUNREACH|EAI_AGAIN|offline/i
const UNREACHABLE = /ERR_CONNECTION|ERR_TIMED_OUT|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ESOCKETTIMEDOUT|timed? ?out/i

export const updateFailed = (u: AppUpdate | null | undefined): boolean => !!u && !!u.error && u.status !== 'ready' && u.status !== 'downloading'

export const updateDownloading = (u: AppUpdate | null | undefined): boolean => u?.status === 'downloading'

export const downloadPercent = (u: AppUpdate): number => Math.max(0, Math.min(100, Math.round(u.progress ?? 0)))

export function updateReason(error: string | undefined, online = true): string {
  if (!online || (error && OFFLINE.test(error))) return 'No internet connection'
  if (error && UNREACHABLE.test(error)) return 'Could not reach the update server'
  return 'Could not check for updates'
}
