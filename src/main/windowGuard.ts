import { isAbsolute, resolve, sep } from 'node:path'

/**
 * A URL without its query or hash, or null when it doesn't parse. File URLs have no origin, so compare the parts. A file
 * path is compared decoded: loadFile leaves a % in a folder name as it is, while pathToFileURL escapes it.
 */
function base(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.protocol === 'file:' ? decoded(u.pathname) : u.pathname}`
  } catch {
    return null
  }
}

/** Decodes each run of %XX escapes as UTF-8 and leaves a bare % alone, where decodeURIComponent would throw. */
function decoded(path: string): string {
  return path.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'))
}

/**
 * True when `url` is the app's own page. The window may only navigate there, and only that page may call the bridge
 * (KERNEL-208). The hash is ignored because the renderer routes on it.
 */
export function isAppUrl(url: string | undefined, appUrl: string): boolean {
  const b = url ? base(url) : null
  return b !== null && b === base(appUrl)
}

/** Links leave the app only for https. A file:, javascript: or custom-scheme link would run something on the Mac. */
export function isSafeExternal(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** True when `path` is absolute and sits in one of `roots` (a room's checkout or a workspace's worktree). */
export function insideRoots(path: string, roots: string[]): boolean {
  if (!isAbsolute(path)) return false
  const p = resolve(path)
  return roots.some((r) => {
    const root = resolve(r)
    return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
  })
}
