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
