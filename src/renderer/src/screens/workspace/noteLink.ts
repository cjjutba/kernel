import type { NoteRef } from '@shared/types'
import { isWebUrl } from '@shared/previewUrl'

/** The room a `kernel://floor/<roomId>` link points at, or null for any other href. */
export function floorRoomId(href: string): string | null {
  return /^kernel:\/\/floor\/(.+)$/.exec(href)?.[1] ?? null
}

/**
 * What a chat note's link does. A floor link opens that room, a web link opens in the browser, and anything else
 * (`file:`, `javascript:`, `mailto:`, junk) shows as plain text. A plain anchor would navigate the app window away (KERNEL-294).
 */
export function noteLinkTarget(href: string): 'room' | 'external' | 'text' {
  if (floorRoomId(href)) return 'room'
  return isWebUrl(href) ? 'external' : 'text'
}

/**
 * A note's text cut around its refs, in order: plain strings, and the refs that open a workspace. A ref whose words
 * aren't found after the previous one stays plain text, so the same label twice links each in turn.
 */
export function noteSpans(text: string, refs: NoteRef[] = []): (string | NoteRef)[] {
  const out: (string | NoteRef)[] = []
  let at = 0
  for (const r of refs) {
    const i = r.text ? text.indexOf(r.text, at) : -1
    if (i < 0) continue
    if (i > at) out.push(text.slice(at, i))
    out.push(r)
    at = i + r.text.length
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}
