import { PORT_BLOCK } from './types'

/** Whether `url` is an http or https URL with a host. Kernel opens nothing else in the browser (KERNEL-246). */
export function isWebUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch { return false }
}

/**
 * A room's preview URL with the workspace's port filled in. Takes `$KERNEL_PORT`, `${KERNEL_PORT}`, `$PORT` and
 * `$((KERNEL_PORT + n))` for a port in the workspace's block (n from 0 to 9). Null when a port form is left over,
 * like `$((KERNEL_PORT + 12))`, or the result isn't an http or https URL.
 */
export function resolvePreviewUrl(template: string, port: number): string | null {
  const url = template.trim()
    .replace(/\$\(\(\s*KERNEL_PORT\s*\+\s*(\d+)\s*\)\)/g, (m, n: string) => (Number(n) < PORT_BLOCK ? String(port + Number(n)) : m))
    .replace(/\$\{KERNEL_PORT\}|\$(?:KERNEL_)?PORT(?!\w)/g, String(port))
  if (/\$(?:\(|\{)|\$(?:KERNEL_)?PORT(?!\w)/.test(url)) return null
  return isWebUrl(url) ? url : null
}

/** Colors, cursor moves and terminal titles, which dev servers print even inside a URL. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** A URL on this machine with a port, as a dev server prints it: localhost, 127.0.0.1, 0.0.0.0 or [::1]. */
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?:[/?#][^\s"'<>`]*)?/i

/**
 * The first local URL in a line of run output, or null. `0.0.0.0` becomes `localhost`, since a browser can't open it,
 * and punctuation that ends a sentence is left off.
 */
export function localUrlIn(line: string): string | null {
  const m = LOCAL_URL.exec(line.replace(ANSI, ''))
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 65535) return null
  return m[0].replace(/[.,;:!)\]]+$/, '').replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1localhost')
}
