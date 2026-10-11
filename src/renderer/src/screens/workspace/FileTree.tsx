import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { FileEntry } from '@shared/types'
import { FileIcon } from '../../components/FileIcon'
import { Icon } from '../../ui'
import { gitDecoration } from './gitStatus'
import { folderStatus, visibleRows } from './tree'

/** Each level steps in 12px, and the guide for a level runs down the middle of its folder's 16px chevron. */
const PAD = 4
const INDENT = 12
const guideX = (level: number) => PAD + level * INDENT + 7

/**
 * A file tree drawn the way VS Code's explorer draws one (KERNEL-399): Material icons, compact folders, indent guides, git colors on
 * changed files and on the folders above them, and the open file selected. It is one tab stop. Up and Down move, Right opens a
 * folder or steps into it, Left closes it or steps out to its folder, Home and End jump, and Enter or Space opens.
 */
export function FileTree({ label, entries, expanded, onToggle, onOpen, activePath, trailing }: {
  label: string; entries: FileEntry[]; expanded: Set<string>; onToggle: (path: string) => void; onOpen: (path: string) => void
  /** The file open in the center, drawn selected. */ activePath?: string
  /** Drawn before a file's status letter, as the Changes tree's +/- counts. */ trailing?: (entry: FileEntry) => ReactNode
}) {
  const rows = useMemo(() => visibleRows(entries, expanded), [entries, expanded])
  const folders = useMemo(() => folderStatus(entries), [entries])
  const [focused, setFocused] = useState<string>()
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const at = (path?: string) => (path === undefined ? -1 : rows.findIndex((r) => r.entry.path === path))
  const stop = [at(focused), at(activePath)].find((i) => i >= 0) ?? 0
  // The guide drawn brighter is the one beside the focused (or open) row, the way VS Code lights the active indent guide.
  const lit = rows[stop]?.ancestors.at(-1)
  const move = (i: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))]
    if (r) { setFocused(r.entry.path); refs.current.get(r.entry.path)?.focus() }
  }
  const onKey = (e: KeyboardEvent, i: number) => {
    const { entry, ancestors } = rows[i]
    const open = entry.dir && expanded.has(entry.path)
    if (e.key === 'ArrowDown') move(i + 1)
    else if (e.key === 'ArrowUp') move(i - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(rows.length - 1)
    else if (e.key === 'ArrowRight') { if (entry.dir && !open) onToggle(entry.path); else if (open && rows[i + 1]?.ancestors.at(-1) === entry.path) move(i + 1) }
    else if (e.key === 'ArrowLeft') { if (open) onToggle(entry.path); else if (ancestors.length) move(at(ancestors.at(-1))) }
    else return
    e.preventDefault()
  }
  return (
    <div className="file-tree" role="tree" aria-label={label}>
      {rows.map(({ entry, depth, name, ancestors }, i) => {
        const open = entry.dir && expanded.has(entry.path)
        const deco = gitDecoration(entry.dir ? folders.get(entry.path) : entry.status)
        return (
          <button
            key={entry.path} ref={(el) => { if (el) refs.current.set(entry.path, el); else refs.current.delete(entry.path) }}
            type="button" role="treeitem" aria-level={depth + 1} aria-expanded={entry.dir ? open : undefined} aria-selected={!entry.dir && entry.path === activePath}
            tabIndex={i === stop ? 0 : -1} className="tree-row" style={{ paddingLeft: PAD + depth * INDENT }}
            onFocus={() => setFocused(entry.path)} onKeyDown={(e) => onKey(e, i)} onClick={() => (entry.dir ? onToggle(entry.path) : onOpen(entry.path))}
          >
            {ancestors.map((a, level) => <span key={a} className="tree-guide" data-lit={a === lit || undefined} style={{ left: guideX(level) }} />)}
            <span className="tree-chev" data-open={open || undefined}>{entry.dir && <Icon name="right" size={12} />}</span>
            <FileIcon path={entry.path} dir={entry.dir} open={open} />
            <span className="tree-name ellipsis" data-struck={(!entry.dir && deco?.struck) || undefined} style={deco ? { color: deco.color } : undefined}>{name}</span>
            {!entry.dir && trailing?.(entry)}
            {!entry.dir && deco && <span className="tree-letter" style={{ color: deco.color }} aria-label={deco.label}>{deco.letter}</span>}
          </button>
        )
      })}
    </div>
  )
}
