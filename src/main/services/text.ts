/** The first sentence of a message, short enough for a speech bubble. */
export function firstLine(t: string, max = 90): string {
  const one = t.trim().replace(/\s+/g, ' ')
  const end = one.search(/[.!?](\s|$)/)
  const line = end >= 0 ? one.slice(0, end + 1) : one
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}
