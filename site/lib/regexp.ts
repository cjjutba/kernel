/** `text` with every character a regular expression treats as syntax escaped, so it matches literally. */
export function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
