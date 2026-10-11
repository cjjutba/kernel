import type { Workspace } from '@shared/types'
import { useStore } from '../../../store'
import { Icon } from '../../../ui'
import { LANDED, localNote, localRow, METHOD_WORD } from './model'
import { useLocalMerge } from './useLocalMerge'
import './pr.css'

/** A path as the Changes rows draw it: its folder faint, then the file name. */
const Path = ({ path }: { path: string }) => {
  const i = path.lastIndexOf('/') + 1
  return <span className="p">{i > 0 && <span className="d">{path.slice(0, i)}</span>}{path.slice(i)}</span>
}

/** Git's status letters in the colors the Changes list uses: added and untracked green, deleted and conflicting red, the rest muted. */
const LETTER_TONE: Record<string, string> = { A: 'add', U: 'add', D: 'del', C: 'del' }

/**
 * What a branch that merges on the Mac says under the panel's band, above the tabs so every tab shows it (KERNEL-478, PrLocal*.png):
 * the merge line with how far the branch is from its base and the room's merge method, then one note for the states that
 * need one (behind, conflicts, a refused merge). Nothing shows for a room on GitHub or a branch with nothing committed.
 */
export function LocalMergeInfo({ ws }: { ws: Workspace }) {
  const local = useLocalMerge(ws)
  const who = useStore((s) => s.agents[ws.roomId]?.find((a) => a.id === ws.agentId)?.name)
  if (!local || local.stand === 'none') return null
  const { stand, base, info } = local
  const git = info?.local
  const note = localNote(stand, base, info, who)
  const merged = stand === 'merged'
  // Once merged the line says where the merge landed, in the verb of the method it used.
  const line = merged
    ? <span>{git ? LANDED[git.method] : 'Merged into'} <span className="mono n">{base}</span>{ws.mergeCommit && <> as <span className="mono n">{ws.mergeCommit.slice(0, 7)}</span></>}</span>
    : git && (
      <>
        <span><span className="mono n">{git.ahead}</span> ahead of <span className="mono n">{base}</span> <span className="sep">·</span> <span className={git.behind > 0 ? 'mono hot' : 'mono n'}>{git.behind}</span><span className={git.behind > 0 ? 'hot' : undefined}> behind</span></span>
        <span className="meth">{METHOD_WORD[git.method]}</span>
      </>
    )
  if (!line && !note) return null
  return (
    <div className="lm">
      <div className="lm-line">{line}</div>
      {note && (
        <section className="lm-note" aria-label={note.title}>
          <h3>{note.title}</h3>
          <p>{note.body.map((part, i) => (typeof part === 'string' ? part : <code key={i} className="mono">{part.code}</code>))}</p>
          {note.files.length > 0 && (
            <ul className="lm-files">
              {note.files.map((f) => (
                <li key={f.path} className="lm-file">
                  <span className="lm-letter" data-tone={LETTER_TONE[f.letter]} aria-hidden="true">{f.letter}</span>
                  <Path path={f.path} />
                  {f.why && <span className="why">{f.why}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

/**
 * The row that ends the transcript for a branch that merges on the Mac, in the same words as the PR rows: ready, behind, conflicts or
 * refused, with the branch glyph in the band's tone. A merged branch has the engine's own note, so it has no row here.
 */
export function LocalMergeRow({ ws }: { ws: Workspace }) {
  const local = useLocalMerge(ws)
  const text = local && localRow(local.stand, local.base, local.info)
  if (!local || !text) return null
  return <div className="note inline" data-local={local.stand}><Icon name="branch" size={14} /><span className="note-text">{text}</span><span className="note-rule" aria-hidden="true" /></div>
}
