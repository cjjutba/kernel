/** What `next` adds to `prev` when the store keeps only the tail of a long buffer. */
export function appended(prev: string, next: string): string {
  if (next.startsWith(prev)) return next.slice(prev.length)
  const tail = prev.slice(-64)
  const at = tail ? next.lastIndexOf(tail) : -1
  return at >= 0 ? next.slice(at + tail.length) : next
}
