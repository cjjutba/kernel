import type { ChatPart } from '@shared/types'
import { exec } from '../services/exec'

// Constants and helpers more than one feature uses (KERNEL-325). A helper only one feature uses stays in that feature.

/**
 * The name a chat opened from the tab row starts with. It gives way to Claude Code's title for the session, or to the one
 * Kernel picks at the end of a turn, and comes back after /clear (`nameChat`, KERNEL-202).
 */
export const NEW_CHAT = 'New chat'
/** The Lead's first tab before anyone writes in it. Like "New chat", it gives way to a real name. */
export const LEAD_CHAT = 'Lead'
/** A Lead tab opened after the first, which belongs to a Lead chat that holds several (KERNEL-337). Named like "New chat". */
export const NEW_TAB = 'New tab'

/** A composer message: `parts` in order when they carry text (chips sit inline), else `text` first and the parts after it. */
export const messageOf = (text: string, parts: ChatPart[] = []): ChatPart[] =>
  parts.some((p) => p.type === 'text') ? parts : [...(text ? [{ type: 'text' as const, text }] : []), ...parts]

export async function head(path: string) {
  const r = await exec('git', ['-C', path, 'rev-parse', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() : undefined
}

/**
 * What a terminal can be handed as text: the words, and a file that carries its own text (an issue the tracker read). A file
 * that is only a path, or an image, can't be pasted into a prompt, so a hand-off that has one runs in Kernel (KERNEL-1004).
 */
export function pastable(parts: ChatPart[] | undefined): boolean {
  return (parts ?? []).every((p) => p.type === 'text' || (p.type === 'file' && !p.dir && p.text !== undefined))
}
