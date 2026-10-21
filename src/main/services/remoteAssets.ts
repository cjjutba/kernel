import { readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Asset } from './remoteServer'

/**
 * The web client's files for `RemoteServer`'s `assets` seam (remote-web-client): the folder `pnpm build` writes the renderer to, served
 * read-only. A path maps to one file inside the folder and nothing else. There is no directory listing, no index of a folder, no
 * dot file and no file of a type not listed here, and the real path of a match (symlinks resolved) has to stay inside the folder.
 * With no build in the folder (a dev run) every path gets undefined, and the server keeps its placeholder page.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
}

const extOf = (name: string) => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i).toLowerCase() }

/** The file a URL path names, relative to the folder, or undefined for a path that may not be served. */
export function assetPath(urlPath: string): string | undefined {
  let decoded: string
  try { decoded = decodeURIComponent(urlPath) } catch { return undefined }
  if (decoded.includes('\0') || decoded.includes('\\') || !decoded.startsWith('/')) return undefined
  const parts = decoded.split('/').slice(1)
  // A path ending in a slash names a folder, which is never listed: only the root has a page.
  if (parts[parts.length - 1] === '' && parts.length > 1) return undefined
  const name = parts.join('/') || 'index.html'
  for (const p of name.split('/')) if (p === '' || p === '.' || p === '..' || p.startsWith('.')) return undefined
  return name
}

export function staticAssets(root: string): (path: string) => Promise<Asset | undefined> {
  const base = resolve(root)
  let realBase: Promise<string | undefined> | undefined
  const real = () => (realBase ??= realpath(base).catch(() => undefined))
  return async (urlPath) => {
    const name = assetPath(urlPath)
    if (!name) return undefined
    const type = TYPES[extOf(name)]
    if (!type) return undefined
    const file = resolve(join(base, name))
    if (!file.startsWith(base + sep)) return undefined
    try {
      const [rb, rf] = await Promise.all([real(), realpath(file)])
      if (!rb || !rf.startsWith(rb + sep)) return undefined
      if (!(await stat(rf)).isFile()) return undefined
      return { type, body: await readFile(rf) }
    } catch {
      return undefined
    }
  }
}
