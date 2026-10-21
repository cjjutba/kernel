import { readSaved, writeSaved } from '../remember'
import { TOKEN_KEY } from './bridge'

/** Pairing from the browser's side (remote-web-client). The token lives in localStorage (through `remember.ts`); the code is read from the URL's hash and never sent anywhere else. */

/** Why the last session ended, for the page that follows the reload. Session storage, so a new tab starts clean. */
const NOTICE_KEY = 'kernel.remote.notice'

/** Through `remember.ts`, the one place that touches localStorage. With storage blocked the token lasts until the page closes. */
export const storedToken = (): string | null => readSaved(TOKEN_KEY)
export const storeToken = (token: string) => writeSaved(TOKEN_KEY, token)
export const forgetToken = () => writeSaved(TOKEN_KEY, null)

export const pairCode = (hash: string = location.hash): string | undefined => /^#pair=([A-Za-z0-9_-]+)$/.exec(hash)?.[1]

export const takeNotice = (): string | undefined => {
  try { const n = sessionStorage.getItem(NOTICE_KEY) ?? undefined; sessionStorage.removeItem(NOTICE_KEY); return n } catch { return undefined }
}
export const leaveNotice = (text: string) => { try { sessionStorage.setItem(NOTICE_KEY, text) } catch { /* the page shows the plain message */ } }

/** A name for this device that the Mac lists in Settings, Remote access, from what the browser says it is. */
export function deviceName(ua: string = navigator.userAgent): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) || /CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
  return browser ? `${os} ${browser}` : os
}

/** Spends the code. Resolves with the token, or throws a sentence the person can act on. */
export async function pair(code: string, name: string, origin: string = location.origin): Promise<string> {
  let r: Response
  try {
    r = await fetch(`${origin}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: name.trim() || undefined }) })
  } catch {
    throw new Error('Could not reach your Mac. Check that you are on the same network.')
  }
  if (r.ok) {
    const body = (await r.json().catch(() => ({}))) as { token?: unknown }
    if (typeof body.token === 'string' && body.token) return body.token
    throw new Error('Your Mac sent an answer that Kernel does not understand.')
  }
  if (r.status === 429) throw new Error('Too many tries. Wait a minute and open the link again.')
  if (r.status === 401) throw new Error('This pairing link was used or has run out. Make a new one in Settings, Remote access on your Mac.')
  throw new Error('Pairing did not work. Make a new link in Settings, Remote access on your Mac.')
}
