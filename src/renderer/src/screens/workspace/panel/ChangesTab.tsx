import { useMemo, useRef, useState } from 'react'
import type { ChangedFile, Workspace } from '@shared/types'
import { onSharedFolder } from '@shared/leadWorkspace'
import { actions, useStore } from '../../../store'
import { FileIcon } from '../../../components/FileIcon'
import { EmptyList, Icon, IconButton, LoadingRow } from '../../../ui'
import { spotKey, useKeptScroll } from '../../../ui/keptScroll'
import { compareEmpty, useCompared } from '../compare'
import { CompareButton } from '../CompareMenu'
import { FileTree } from '../FileTree'
import { PanelDiff } from '../FileView'
import { gitDecoration } from '../gitStatus'
import { filterEntries, matchRanges, matchesPath } from '../panelFilter'
import { FilterButton, FilterField, Marked, usePanelFilter } from '../PanelTools'
import { useLocalMerge } from '../pr/useLocalMerge'
import { changesToEntries } from '../tree'
import { TwoPane, useWidth } from './TwoPane'
import { usePick } from './picks'

const split = (path: string) => { const i = path.lastIndexOf('/'); return { dir: i < 0 ? '' : path.slice(0, i), name: path.slice(i + 1) } }

/** A chat on the shared main folder has no changes, setup or run of its own until it switches to Build here (KERNEL-1052). */
export const SHARED_NOTHING = 'Nothing of its own yet'
export const sharedWhy = (ws: Workspace) => ws.leadMode === 'build'
  ? 'This chat gets a working copy of its own when you send your next message.'
  : 'This chat reads the project’s main folder. Switch to Build here and it gets a working copy of its own.'

/** One changed file the way Pen 9.5 lists it: icon, its name (green when it is new, red when it is gone), the folder after it, then its git letter. A file a local merge would conflict in reads C. */
function ChangeRow({ f, active, conflicted, ranges, onOpen }: { f: ChangedFile; active: boolean; conflicted?: boolean; ranges: [number, number][]; onOpen: () => void }) {
  const { dir, name } = split(f.path)
  const deco = conflicted ? { letter: 'C', label: 'Conflict', color: 'var(--del)', nameColor: 'var(--del)', struck: false } : gitDecoration(f.status)
  return (
    <button type="button" data-keep-id={f.path} className="tree-row change-row" aria-current={active || undefined} data-tip={f.from ? `Renamed from ${f.from}` : undefined} onClick={onOpen}>
      <FileIcon path={f.path} />
      <span className="tree-name ellipsis">
        <span data-struck={deco?.struck || undefined} style={deco ? { color: deco.nameColor } : undefined}><Marked text={name} from={dir ? dir.length + 1 : 0} ranges={ranges} /></span>
        {dir && <span className="change-dir"><Marked text={dir} from={0} ranges={ranges} /></span>}
      </span>
      {deco && <span className="tree-letter" style={{ color: deco.color }} aria-label={deco.label}>{deco.letter}</span>}
      {f.from && <span className="sr-only">, renamed from {f.from}</span>}
    </button>
  )
}

const NO_FILES: ChangedFile[] = []

/** The list and tree buttons, one pressed (Pen 9.5). */
function ViewSwitch({ view }: { view: 'list' | 'tree' }) {
  return (
    <span className="seg-icons" role="group" aria-label="View as">
      <IconButton icon="doc" size={14} box="sm" label="View as list" aria-pressed={view === 'list'} onClick={() => actions.ui.setChangesView('list')} />
      <IconButton icon="listTree" size={14} box="sm" label="View as tree" aria-pressed={view === 'tree'} onClick={() => actions.ui.setChangesView('tree')} />
    </span>
  )
}

/**
 * The Changes tab (Pen 9.5): what the agent changed against the target branch, as a list or a tree on the left and the file's diff on the right. `base` is the workspace's changed
 * files. The list shows them, or the files of what the compare menu picks instead (KERNEL-517), which the diff tabs it opens share (compare.ts). In a panel too narrow for both panes
 * a pick opens its diff in a tab.
 */
export function ChangesTab({ ws, changes: base, onOpenDiff, diffPath }: { ws: Workspace; changes: ChangedFile[]; onOpenDiff: (path: string) => void; diffPath?: string }) {
  const view = useStore((s) => s.ui.workspace.changesView ?? 'list')
  const agent = useStore((s) => s.agents[ws.projectId]?.find((a) => a.id === ws.agentId)?.name ?? 'the agent')
  const { compare, files, error } = useCompared(ws, base)
  const changes = files ?? NO_FILES
  const entries = useMemo(() => changesToEntries(changes), [changes])
  const local = useLocalMerge(ws)
  const conflicts = useMemo(() => new Set(local?.stand === 'conflict' ? local.info?.conflicts : []), [local])
  const filter = usePanelFilter()
  // Every folder of the tree starts open. This keeps the ones closed by hand.
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  // Filtering narrows the list to the paths that match, and the tree to them and the folders above, all drawn open but the ones the reader closed since.
  const shown = useMemo(() => (filter.filtering ? changes.filter((f) => matchesPath(f.path, filter.query)) : changes), [changes, filter.filtering, filter.query])
  const found = useMemo(() => (filter.filtering ? filterEntries(entries, filter.query) : null), [entries, filter.filtering, filter.query])
  const treeEntries = found ? found.entries : entries
  const expanded = useMemo(() => new Set(treeEntries.filter((e) => e.dir && !(found ? filter.shut : closed).has(e.path)).map((e) => e.path)), [treeEntries, found, filter.shut, closed])
  const toggle = (path: string) => {
    if (found) return filter.fold(path)
    const next = new Set(closed)
    if (next.has(path)) next.delete(path); else next.add(path)
    setClosed(next)
  }
  const added = changes.reduce((n, f) => n + f.added, 0)
  const removed = changes.reduce((n, f) => n + f.removed, 0)
  const empty = compareEmpty(compare)
  const listed = files !== null && !error && changes.length > 0
  const scroller = useRef<HTMLDivElement>(null)
  useKeptScroll(scroller, { key: spotKey.panel(ws.id, 'changes'), ready: listed })
  const box = useWidth<HTMLDivElement>()
  const [picked, pick] = usePick(ws.id, 'diff')
  const wide = box.wide
  // The diff shown is the pick if it is still a changed file, else the first of them.
  const order = shown.map((f) => f.path)
  const at = wide ? (picked && changes.some((c) => c.path === picked) ? picked : changes[0]?.path) : diffPath
  const open = (path: string) => (wide ? pick(path) : onOpenDiff(path))
  const index = at ? order.indexOf(at) : -1

  const body = error
    ? <EmptyList icon="warning" title="Could not compare">{error}</EmptyList>
    : files === null
      ? <LoadingRow what="changes" />
      : onSharedFolder(ws)
        ? <EmptyList icon="branch" title={SHARED_NOTHING}>{sharedWhy(ws)}</EmptyList>
        : !changes.length
          ? <EmptyList icon={compare.only?.kind === 'uncommitted' ? 'check' : 'doc'} title={empty.title}>{empty.sub}</EmptyList>
          : filter.filtering && !shown.length
            ? <EmptyList icon="search" title="No changes match">Try another name or folder.</EmptyList>
            : (
              <div ref={scroller} className="panel-scroll changes-scroll">
                {view === 'tree'
                  ? <FileTree label="Changed files" entries={treeEntries} expanded={expanded} onToggle={toggle} onOpen={open} activePath={at} />
                  : shown.map((f) => <ChangeRow key={f.path} f={f} active={f.path === at} conflicted={conflicts.has(f.path)} ranges={matchRanges(f.path, filter.query)} onOpen={() => open(f.path)} />)}
              </div>
            )

  const list = (
    <>
      <div className="two-head">
        <span className="two-title">{changes.length} {changes.length === 1 ? 'file' : 'files'}</span>
        <span className="grow" />
        <span className="mono two-total">{added ? <span className="add">+{added}</span> : null}{removed ? <span className="del">-{removed}</span> : null}</span>
      </div>
      <div className="two-bar">
        <ViewSwitch view={view} />
        <span className="grow" />
        <FilterButton filter={filter} label="Filter changed files" />
        <CompareButton ws={ws} compare={compare} />
      </div>
      {filter.open && <div className="two-find"><FilterField filter={filter} label="Filter changed files" placeholder="Filter changed files" /></div>}
      {ws.mode === 'current' && !compare.branch && !compare.only && (
        <p className="two-note"><Icon name="eyeoff" size={14} />Changes from before this workspace started are hidden.</p>
      )}
      {body}
    </>
  )
  const stepper = { index: Math.max(0, index), total: order.length, go: (i: number) => { const p = order[i]; if (p !== undefined) open(p) } }
  const view2 = at ? <PanelDiff key={at} ws={ws} path={at} changes={changes} stepper={stepper} agent={agent} /> : <EmptyList icon="doc" title="No changes to show." />
  return <TwoPane boxRef={box.ref} wide={wide} list={list} view={view2} />
}

