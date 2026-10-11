import { useMemo, useRef, useState } from 'react'
import type { SharedFile, SharedVersion } from '@shared/types'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, Icon, Menu, SegmentedControl, useBusy, type MenuEntry } from '../../../ui'
import { Markdown } from '../markdown'
import { attempt } from '../MessageActions'
import { CommentLayer } from './CommentLayer'
import { imageSurface, markdownSurface } from './commentSurfaces'
import { PreviewSurface, type PreviewWidth } from './PreviewSurface'
import { clock, useRead, useSharer, versionOf } from './shared'
import './shared.css'

const WIDTHS: { value: PreviewWidth; label: string }[] = [{ value: 'desktop', label: 'Desktop' }, { value: 'tablet', label: 'Tablet' }, { value: 'phone', label: 'Phone' }]

/**
 * A shared file in its `shared:<id>` tab: its title and who shared it, the version picker, Desktop, Tablet and Phone widths for a page, Reload
 * for a page, Open in Preview for a PDF and Show in Finder, then the file (WorkspaceSharedHtml.png and the others). The tab follows the latest
 * version until an older one is picked. A page and a PDF go in `PreviewSurface`; an image and Markdown are drawn here. A PDF has no live view
 * and so nothing to reload (KERNEL-306): Open in Preview takes the place of Reload on the canvas. Comment, for everything but a PDF, turns on comment
 * mode: `CommentLayer` over the file (KERNEL-311).
 */
export function SharedView({ workspaceId, sharedId }: { workspaceId: string; sharedId: string }) {
  const file = useStore((s) => s.shared[sharedId])
  const picked = useStore((s) => s.ui.tabs[workspaceId]?.sharedVersion?.[sharedId])
  if (!file) {
    return <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>This file isn't available</span><span>Kernel has no copy of it.</span></div>
  }
  return <Loaded key={file.id} workspaceId={workspaceId} file={file} version={versionOf(file, picked)} />
}

function Loaded({ workspaceId, file, version }: { workspaceId: string; file: SharedFile; version: SharedVersion }) {
  const by = useSharer(file)
  const [width, setWidth] = useState<PreviewWidth>('desktop')
  const [again, setAgain] = useState(0)
  const [versions, setVersions] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const [busy, run] = useBusy<'open'>()
  const page = file.kind === 'html'
  const pdf = file.kind === 'pdf'
  const read = useRead(file, file.kind === 'image' || file.kind === 'markdown' ? version : undefined)
  // Comment mode. The workspace that shared the file may be archived by now, and then a comment has nowhere to go.
  const [commenting, setCommenting] = useState(false)
  const archived = useStore((s) => s.workspaces.find((w) => w.id === file.workspaceId)?.status === 'archived')
  const toggle = useRef<HTMLButtonElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const doc = useRef<HTMLDivElement>(null)
  const imageAt = useMemo(() => imageSurface(() => layer.current, () => img.current), [])
  const markdownAt = useMemo(() => markdownSurface(() => layer.current, () => doc.current?.querySelector<HTMLElement>('.shared-md') ?? null), [])
  const ready = page || (file.kind === 'image' && !!read.dataUrl) || (file.kind === 'markdown' && read.text !== undefined)
  const stop = () => { setCommenting(false); toggle.current?.focus() }

  const entries: MenuEntry[] = [...file.versions].sort((a, b) => b.n - a.n).map((v) => ({
    id: `v${v.n}`, leading: <span className="shared-menu-ver">v{v.n}</span>, label: v.note ? `${clock(v)} · ${v.note}` : clock(v), checked: v.n === version.n,
    onSelect: () => actions.ui.openShared(workspaceId, file.id, v.n)
  }))
  const openInPreview = () => run('open', () => attempt('Could not open it in Preview', () => call('shared.open', { sharedId: file.id, version: version.n })))
  const reveal = () => void attempt('Could not show it in Finder', () => call('shared.reveal', { sharedId: file.id, version: version.n }))

  return (
    <div className="shared-view">
      <div className="shared-title"><h2 className="ellipsis">{file.title}</h2><span className="shared-by">Shared by {by} · {clock(version)}</span></div>
      <div className="shared-tools">
        <span ref={anchor} style={{ position: 'relative' }}>
          <button type="button" className="shared-ver" aria-label="Versions" aria-haspopup="menu" aria-expanded={versions} onClick={() => setVersions(!versions)}>
            v{version.n}<Icon name="chevron" size={12} stroke={1.4} />
          </button>
          {versions && <Menu label="Versions" anchorRef={anchor} onClose={() => setVersions(false)} style={{ left: 0, top: 'calc(100% + 6px)', width: 380 }} items={entries} />}
        </span>
        {page && <span className="shared-width"><SegmentedControl label="Preview width" value={width} onChange={(w) => setWidth(w as PreviewWidth)} options={WIDTHS} /></span>}
        <span className="grow" />
        {!pdf && (
          <button ref={toggle} type="button" className="shared-comment" aria-pressed={commenting} disabled={!ready} onClick={() => setCommenting(!commenting)}>
            <Icon name="comment" size={13} stroke={1.4} />Comment
          </button>
        )}
        {page && <Button className="small" icon="refresh" onClick={() => setAgain(again + 1)}>Reload</Button>}
        {pdf && <Button className="small" icon="ext" busy={busy === 'open'} busyLabel="Opening" onClick={() => void openInPreview()}>Open in Preview</Button>}
        <Button className="small" icon="folder" onClick={reveal}>Show in Finder</Button>
      </div>
      <div className="shared-body">
        <div className="shared-area" data-kind={file.kind}>
          {(page || pdf) && <PreviewSurface workspaceId={workspaceId} file={file} version={version} width={width} again={again} comment={page ? { on: commenting, by, archived, onExit: stop } : undefined} />}
          {file.kind === 'image' && read.dataUrl && <img ref={img} src={read.dataUrl} alt={file.title} />}
          {file.kind === 'image' && read.dataUrl && commenting && <CommentLayer layerRef={layer} kind="image" file={file} version={version} by={by} archived={archived} surface={imageAt} onExit={stop} />}
          {file.kind === 'markdown' && read.text !== undefined && (
            <div ref={doc} className="shared-doc">
              <Markdown className="md-doc shared-md selectable" text={read.text} />
              {commenting && <CommentLayer layerRef={layer} kind="markdown" file={file} version={version} by={by} archived={archived} surface={markdownAt} onExit={stop} />}
            </div>
          )}
          {(file.kind === 'image' || file.kind === 'markdown') && read.failed && <p className="shared-none">Can't show this file</p>}
        </div>
        {commenting && <p className="cm-banner" role="status">{page ? 'Click an element to comment' : file.kind === 'image' ? 'Click a spot to comment' : 'Click a block to comment'}</p>}
      </div>
      {page && (version.outside ?? 0) > 0 && <p className="shared-outside">Parts of this page load from outside the file and won't show.</p>}
    </div>
  )
}
