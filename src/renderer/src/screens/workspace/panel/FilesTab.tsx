import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, FileEntry, Workspace } from '@shared/types'
import { call } from '../../../api'
import { useStore } from '../../../store'
import { oneOf, useRemembered } from '../../../remember'
import { EmptyList, Skeleton, SegmentedControl } from '../../../ui'
import { spotKey, useKeptScroll } from '../../../ui/keptScroll'
import { useFolderFocus } from '../fileLinks'
import { FileTree } from '../FileTree'
import { PanelFile } from '../FileView'
import { filterEntries } from '../panelFilter'
import { FilterButton, FilterField, ToolButton, usePanelFilter } from '../PanelTools'
import { changesToEntries, openByDefault } from '../tree'
import { TwoPane, useWidth } from './TwoPane'
import { usePick } from './picks'

const TREES_KEPT = 10
const lastTrees = new Map<string, FileEntry[]>()
function rememberTree(id: string, tree: FileEntry[]) {
  lastTrees.delete(id)
  lastTrees.set(id, tree)
  if (lastTrees.size > TREES_KEPT) lastTrees.delete(lastTrees.keys().next().value as string)
}

/** Rows of faint squares and bars while the tree loads (Pen 9.16, WorkspaceFilesLoading). The deeper ones step in. */
export function TreeSkeleton() {
  return (
    <div className="panel-scroll tree-skel" aria-busy="true" aria-label="Loading files">
      {[70, 50, 60, 40, 55, 45, 65, 50].map((w, i) => (
        <div key={i} className="tree-row" style={{ paddingLeft: i % 3 === 1 ? 20 : 0 }}><Skeleton width={14} height={14} /><Skeleton width={`${w}%`} height={10} /></div>
      ))}
    </div>
  )
}

const SCOPES = [{ value: 'changed', label: 'Changed' }, { value: 'all', label: 'All files' }]

/**
 * The Files tab (Pen 9.3): the worktree's tree on the left, with Material icons, folders that open in place and a git letter on each changed file, and the picked file on the right. Search,
 * Reveal the open file and Collapse all are in the tree's header. With the search open the header says whether to look in the changed files or all of them (Pen 9.21).
 * In a panel too narrow for both panes, a pick opens in a tab of its own.
 */
export function FilesTab({ ws, changes, onOpenFile, filePath }: { ws: Workspace; changes: ChangedFile[]; onOpenFile: (path: string) => void; filePath?: string }) {
  const [tree, setTree] = useState<FileEntry[] | null>(() => lastTrees.get(ws.id) ?? null)
  const [open, setOpen] = useState<Set<string> | null>(null)
  const [failed, setFailed] = useState(false)
  const [scope, setScope] = useRemembered('kernel.filesScope', oneOf(['all', 'changed'] as const, 'all'))
  const filter = usePanelFilter()
  const scroller = useRef<HTMLDivElement>(null)
  const box = useWidth<HTMLDivElement>()
  const [picked, pick] = usePick(ws.id, 'file')
  const agent = useStore((s) => s.agents[ws.projectId]?.find((a) => a.id === ws.agentId)?.name)
  useKeptScroll(scroller, { key: spotKey.panel(ws.id, 'files'), ready: tree !== null })
  useEffect(() => {
    let live = true
    call('workspaces.tree', { workspaceId: ws.id }).then((t) => { rememberTree(ws.id, t); if (live) { setTree(t); setFailed(false) } }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [ws.id, changes])
  // Changed shows the changed files as a tree and All files the worktree.
  const source = useMemo(() => (scope === 'changed' ? changesToEntries(changes) : tree ?? []), [scope, changes, tree])
  const initial = useMemo(() => (scope === 'changed' ? new Set(source.filter((e) => e.dir).map((e) => e.path)) : openByDefault(tree ?? [])), [scope, source, tree])
  // A link in chat to a folder opens its parents and the folder itself, and scrolls to it.
  const asked = useFolderFocus(ws.id)
  useEffect(() => {
    if (!asked || !tree) return
    const parts = asked.path.split('/')
    const chain = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
    setOpen((o) => new Set([...(o ?? initial), ...chain]))
    const frame = requestAnimationFrame(() => [...(scroller.current?.querySelectorAll<HTMLElement>('[data-keep-id]') ?? [])].find((el) => el.dataset.keepId === asked.path)?.scrollIntoView({ block: 'center' }))
    return () => cancelAnimationFrame(frame)
  }, [asked, tree])
  // Filtering draws every folder with a match open, but the ones the reader closed since.
  const found = useMemo(() => (filter.filtering ? filterEntries(source, filter.query) : null), [source, filter.filtering, filter.query])
  const expanded = useMemo(() => (found ? new Set([...found.dirs].filter((d) => !filter.shut.has(d))) : open ?? initial), [found, filter.shut, open, initial])
  const toggle = (path: string) => {
    if (found) return filter.fold(path)
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path); else next.add(path)
    setOpen(next)
  }
  const collapseAll = () => (found ? filter.foldAll(found.dirs) : setOpen(new Set()))
  const wide = box.wide
  const active = wide ? picked ?? changes[0]?.path : filePath
  // With nothing picked the pane shows the first changed file, so opening Files shows what the agent has been working on.
  const shown = wide ? picked ?? changes[0]?.path : undefined
  // Reveal: the open file's folders open and it scrolls into view.
  const reveal = () => {
    const at = active ?? filePath
    if (!at) return
    const parts = at.split('/')
    setOpen(new Set([...expanded, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))]))
    requestAnimationFrame(() => [...(scroller.current?.querySelectorAll<HTMLElement>('[data-keep-id]') ?? [])].find((el) => el.dataset.keepId === at)?.scrollIntoView({ block: 'center' }))
  }
  const pickFile = (path: string) => (wide ? pick(path) : onOpenFile(path))

  const list = (
    <>
      <div className="two-head">
        <span className="two-title ellipsis">{ws.name}</span>
        <span className="grow" />
        <span className="two-tools">
          <FilterButton filter={filter} label="Filter files" />
          <ToolButton icon="locate" label="Reveal the open file" disabled={!active} onClick={reveal} />
          <ToolButton icon="collapse" label="Collapse all folders" onClick={collapseAll} />
        </span>
      </div>
      {filter.open && (
        <div className="two-find">
          <FilterField filter={filter} label="Filter files" placeholder="Filter files" />
          <SegmentedControl label="Look in" value={scope} onChange={(v) => setScope(v as typeof scope)} options={SCOPES} />
        </div>
      )}
      {failed && !tree
        ? <EmptyList icon="warning" title="Could not list files">Try again in a moment.</EmptyList>
        : !tree
          ? <TreeSkeleton />
          : found && !found.entries.length
            ? <EmptyList icon="search" title="No files match">Try another name or folder.</EmptyList>
            : scope === 'changed' && !source.length
              ? <EmptyList icon="doc" title="No changed files">Nothing differs from the base yet.</EmptyList>
              : (
                <div ref={scroller} className="panel-scroll tree-scroll">
                  <FileTree label="All files" entries={found ? found.entries : source} expanded={expanded} onToggle={toggle} onOpen={pickFile} activePath={active} />
                </div>
              )}
    </>
  )
  const view = shown
    ? <PanelFile key={shown} ws={ws} path={shown} editedBy={agent} changed={changes.some((c) => c.path === shown)} onTab={() => onOpenFile(shown)} />
    : <EmptyList icon="doc" title="Pick a file">Its contents show here.</EmptyList>
  return <TwoPane boxRef={box.ref} wide={wide} list={list} view={view} />
}
