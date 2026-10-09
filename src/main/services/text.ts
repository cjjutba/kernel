/** The first sentence of a message, short enough for a speech bubble. */
export function firstLine(t: string, max = 90): string {
  const one = t.trim().replace(/\s+/g, ' ')
  const end = one.search(/[.!?](\s|$)/)
  const line = end >= 0 ? one.slice(0, end + 1) : one
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** Longer than any real link. A first "word" past this, such as minified JSON, is cut where it stands. */
const LONGEST_WORD = 2048

/**
 * A reply cut to about `max` characters for the Lead (KERNEL-117). Paragraphs and line breaks stay. A cut lands on
 * whitespace, never inside a word or a link: it backs up to the start of the word it falls in, and keeps a first word
 * that is longer than `max`, such as a long link, whole unless it runs past `LONGEST_WORD`. A cut text ends with "…".
 */
export function capText(text: string, max: number): string {
  const t = text.replace(/\r\n?/g, '\n').trim().replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  if (t.length <= max) return t
  // A cut on whitespace ends a whole word already. Otherwise back up to the start of the word the cut falls in.
  if (/\s/.test(t[max])) return `${t.slice(0, max).trimEnd()}…`
  let start = max
  while (start > 0 && !/\s/.test(t[start - 1])) start--
  let end = max
  while (end < t.length && !/\s/.test(t[end])) end++
  const cut = start > 0 ? start : Math.min(end, Math.max(max, LONGEST_WORD))
  return cut >= t.length ? t : `${t.slice(0, cut).trimEnd()}…`
}
