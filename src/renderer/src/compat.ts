/*
 * Browser APIs the renderer can't assume once it runs outside Electron (remote-web-client). Safari has no requestIdleCallback, and a page
 * a phone opens over plain HTTP on the network isn't a secure context, so crypto.randomUUID is missing there. getRandomValues works in both.
 */

/** Runs `fn` once the page is idle, or after a short delay where the browser can't tell. Returns a cancel function. */
export function whenIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn)
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(fn, 200)
  return () => clearTimeout(id)
}

/** A random version 4 UUID, the same shape crypto.randomUUID gives. */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
