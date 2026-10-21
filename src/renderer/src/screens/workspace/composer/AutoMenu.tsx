import { Fragment } from 'react'
import type { FileEntry } from '@shared/types'
import { FileIcon } from '../../../components/FileIcon'
import { AgentAvatar, Icon, Kbd } from '../../../ui'
import { baseName, dirName, type MentionRow, type SlashRow } from './autocomplete'
import { tildePath } from './Chip'

export type Menu = { kind: 'mention'; groups: { label: string; rows: MentionRow[] }[] } | { kind: 'slash'; groups: { label: string; rows: SlashRow[] }[] }

/** Where the menu sits in the box: its left edge and the gap from the box's bottom edge, both measured from the word being typed (`wordPlace`). */
export interface MenuPlace { left: number; bottom: number }

/**
 * The menu over the word being typed (KERNEL-1095): it opens 8px above the @ or / word, 10px before it, and may cover the box. Files and folders show their icon, their name in mono and where they
 * are. A folder ends in a chevron, and → opens it. Skills and commands take two lines. The foot names what Tab does with the row under the cursor.
 */
export function AutoMenu({ menu, at, place, noTeam, label, onAt, onPick }: {
  menu: Menu; at: number; place: MenuPlace | null; /** The Lead's chat has no teammate to offer yet. */ noTeam?: boolean; label: string
  onAt: (i: number) => void; onPick: (i: number) => void
}) {
  const rows = menu.groups.flatMap((g) => g.rows as (MentionRow | SlashRow)[])
  const current = rows[at]
  const dir = !!current && 'kind' in current && current.kind === 'file' && !!current.entry.dir
  const showFoot = menu.kind === 'mention' && rows.some((r) => 'kind' in r && r.kind === 'file') && !rows.some((r) => 'kind' in r && r.kind === 'file' && r.entry.reference)
  return (
    <div role="listbox" aria-label={label} className="cmp-ac" style={place ? { left: place.left, bottom: place.bottom } : undefined}>
      {noTeam && <><p className="cmp-ac-head">Teammates</p><p className="cmp-ac-none">No teammates yet in this project. Hire one from Project, Agents.</p></>}
      {menu.groups.map((g, gi) => (
        <Fragment key={g.label}>
          {gi > 0 && <div className="cmp-ac-sep" role="presentation" />}
          <p className="cmp-ac-head">{g.label}</p>
          {(g.rows as (MentionRow | SlashRow)[]).map((r) => {
            const i = rows.indexOf(r)
            const common = { role: 'option', 'aria-selected': i === at, className: 'cmp-ac-row', tabIndex: -1, onMouseDown: (e: React.MouseEvent) => e.preventDefault(), onMouseEnter: () => onAt(i), onClick: () => onPick(i) } as const
            if ('kind' in r) {
              return r.kind === 'agent'
                ? <button key={`agent:${r.agent.id}`} type="button" {...common} aria-label={`${r.agent.name}, ${r.agent.role}`}><AgentAvatar name={r.agent.name} size={16} /><span className="cmp-ac-name">{r.agent.name}</span><span className="sub ellipsis">{r.agent.role}</span></button>
                : <FileRow key={r.entry.path} entry={r.entry} {...common} />
            }
            return (
              <button key={r.name} type="button" {...common} data-two="">
                <span className="cmp-ac-skill" aria-hidden="true"><Icon name="squarePen" size={14} /></span>
                <span className="cmp-ac-tx"><span className="mono">/{r.name}</span><span className="sub">{r.description}</span></span>
              </button>
            )
          })}
        </Fragment>
      ))}
      {showFoot && <div className="cmp-ac-foot"><Kbd>Tab</Kbd><span>{dir ? 'adds the folder, → opens it' : 'adds the file'}</span></div>}
    </div>
  )
}

function FileRow({ entry, ...rest }: { entry: FileEntry } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const folder = !!entry.dir
  // A reference folder shows where it is on the Mac, and a file in one the folder's name. A folder in the project is its whole path.
  const name = folder ? (entry.reference ? `${baseName(entry.path)}/` : `${entry.path}/`) : baseName(entry.path)
  const where = folder ? (entry.reference ? tildePath(entry.path) : '') : (entry.reference ?? (dirName(entry.path) ? `${dirName(entry.path)}/` : ''))
  return (
    <button type="button" {...rest}>
      <FileIcon path={entry.path} dir={folder} size={16} />
      <span className="mono cmp-ac-file">{name}</span>
      {where && <span className="sub ellipsis">{where}</span>}
      {folder && <span className="cmp-ac-go" aria-hidden="true"><Icon name="right" size={12} /></span>}
    </button>
  )
}

/** The gap the menu keeps above the word, and how far before it the menu starts. */
const ABOVE_WORD = 8
const BEFORE_WORD = 10

/**
 * Where the menu goes for the word of `length` characters that ends at the caret: its left edge 10px before the word and its bottom 8px above the word's top, measured in
 * the box (`.cmp-box`) the menu is drawn in. Null when the caret is not in text the box can measure.
 */
export function wordPlace(input: HTMLElement | null, length: number): MenuPlace | null {
  const box = input?.closest<HTMLElement>('.cmp-box')
  if (!input || !box) return null
  // The caret's own place, or the end of the draft when the box doesn't hold the caret (a draft drawn before it was focused).
  const sel = getSelection()
  const r = sel?.rangeCount ? sel.getRangeAt(0) : null
  let node: Node | null = r && input.contains(r.startContainer) ? r.startContainer : null
  let offset = r && node ? r.startOffset : 0
  if (!node) {
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) node = n
    offset = node ? (node as Text).data.length : 0
  }
  if (!node) return null
  const word = document.createRange()
  if (node.nodeType === Node.TEXT_NODE) { word.setStart(node, Math.max(0, offset - length)); word.setEnd(node, offset) }
  else word.setStart(node, offset)
  const rect = Array.from(word.getClientRects()).find((x) => x.height > 0) ?? input.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  return { left: Math.round(rect.left - b.left - BEFORE_WORD), bottom: Math.round(b.bottom - rect.top + ABOVE_WORD) }
}
