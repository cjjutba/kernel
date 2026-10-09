import type { ChatPart, WorkspaceMode, WorkspaceSource } from '@shared/types'
import { plainText } from '../workspace/composer/draft'

/** What the pickers chose, as plain lines for the Lead. A picked source already wrote its own prompt (pick.ts). */
export function pickedLines({ mode, target, fallback, picked }: { mode: WorkspaceMode; target: string; fallback: string; picked: string }): string[] {
  if (mode === 'current') return ['Work on the current branch, not a new worktree.']
  return target !== fallback && target !== picked ? [`Cut the branch from ${target}.`] : []
}

/** The message the Lead gets: what was typed or attached, a picked issue as a chip, then the lines the pickers add. */
export function briefParts(typed: ChatPart[], source: WorkspaceSource | null, lines: string[]): ChatPart[] {
  const parts = [...typed]
  if (source?.kind === 'issue' && !parts.some((p) => p.type === 'issue' && p.name === source.id)) {
    parts.unshift({ type: 'issue', name: source.id, title: source.title, url: source.url, source: source.id.startsWith('#') ? 'github' : 'linear' })
  }
  if (lines.length) {
    const last = parts[parts.length - 1]
    const text = lines.join('\n')
    if (last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: `${last.text}\n\n${text}` }
    else parts.push({ type: 'text', text })
  }
  return parts
}

/**
 * The `lead.start` request body. The prompt is the typed words only. The engine puts a non-empty prompt in front of
 * parts that carry no text, so a chip-only message sends '' and goes through as its parts, once.
 */
export const leadMessage = (parts: ChatPart[]): { prompt: string; parts: ChatPart[] } => ({ prompt: plainText(parts), parts })
