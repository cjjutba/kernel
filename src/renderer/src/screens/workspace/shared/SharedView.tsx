import { useRef, useState } from 'react'
import type { SharedFile, SharedVersion } from '@shared/types'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, Icon, Menu, SegmentedControl, type MenuEntry } from '../../../ui'
import { Markdown } from '../markdown'
import { attempt } from '../MessageActions'
import { PreviewSurface, type PreviewWidth } from './PreviewSurface'
import { clock, useRead, useSharer, versionOf } from './shared'
import './shared.css'

const WIDTHS: { value: PreviewWidth; label: string }[] = [{ value: 'desktop', label: 'Desktop' }, { value: 'tablet', label: 'Tablet' }, { value: 'phone', label: 'Phone' }]

/**
 * A shared file in its `shared:<id>` tab: its title and who shared it, the version picker, Desktop, Tablet and Phone widths for a page, Reload
 * for a page or PDF and Show in Finder, then the file (WorkspaceSharedHtml.png and the others). The tab follows the latest version until an older
 * one is picked. A page and a PDF run in `PreviewSurface`; an image and Markdown are drawn here.
 */
export function SharedView({ workspaceId, sharedId }: { workspaceId: string; sharedId: string }) {
  const file = useStore((s) => s.shared[sharedId])
  const picked = useStore((s) => s.ui.tabs[workspaceId]?.sharedVersion?.[sharedId])
  if (!file) {
    return <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>This file isn't available</span><span>Kernel has no copy of it.</span></div>
  }
  return <Loaded workspaceId={workspaceId} file={file} version={versionOf(file, picked)} />
}

function Loaded({ workspaceId, file, version }: { workspaceId: string; file: SharedFile; version: SharedVersion }) {
  const by = useSharer(file)
  const [width, setWidth] = useState<PreviewWidth>('desktop')
  const [again, setAgain] = useState(0)
  const [versions, setVersions] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const page = file.kind === 'html'
  const live = page || file.kind === 'pdf'
  const read = useRead(file, file.kind === 'image' || file.kind === 'markdown' ? version : undefined)

  const entries: MenuEntry[] = [...file.versions].sort((a, b) => b.n - a.n).map((v) => ({
    id: `v${v.n}`, leading: <span className="shared-menu-ver">v{v.n}</span>, label: v.note ? `${clock(v)} · ${v.note}` : clock(v), checked: v.n === version.n,
    onSelect: () => actions.ui.openShared(workspaceId, file.id, v.n)
  }))
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
        {live && <Button className="small" icon="refresh" onClick={() => setAgain(again + 1)}>Reload</Button>}
        <Button className="small" icon="folder" onClick={reveal}>Show in Finder</Button>
      </div>
      <div className="shared-area" data-kind={file.kind}>
        {live && <PreviewSurface file={file} version={version} width={width} again={again} />}
        {file.kind === 'image' && read.dataUrl && <img src={read.dataUrl} alt={file.title} />}
        {file.kind === 'markdown' && read.text !== undefined && <Markdown className="md-doc shared-md selectable" text={read.text} />}
        {(file.kind === 'image' || file.kind === 'markdown') && read.failed && <p className="shared-none">Can't show this file</p>}
      </div>
      {page && (version.outside ?? 0) > 0 && <p className="shared-outside">Parts of this page load from outside the file and won't show.</p>}
    </div>
  )
}
