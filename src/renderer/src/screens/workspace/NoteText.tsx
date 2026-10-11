import type { NoteRef } from '@shared/types'
import { go } from '../../store'
import { noteSpans } from './noteLink'

/** A note's text, with the workspaces it names, such as the PRs a held brief waits for, as buttons that open them. */
export function NoteText({ text, refs }: { text: string; refs?: NoteRef[] }) {
  if (!refs?.length) return <>{text}</>
  return <>{noteSpans(text, refs).map((s, i) => typeof s === 'string' ? s : <button key={i} type="button" className="note-ref" onClick={() => go({ name: 'workspace', workspaceId: s.workspaceId })}>{s.text}</button>)}</>
}
