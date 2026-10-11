import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { PushEvent } from '@shared/ipc'
import type { SharedFile, SharedVersion } from '@shared/types'
import { call, onPush } from '../../../api'
import { getState } from '../../../store'
import { Button, Icon, useBusy } from '../../../ui'
import { isCovered, type Rect } from './cover'
import { useThumb } from './shared'

export type PreviewWidth = 'desktop' | 'tablet' | 'phone'
type PreviewState = Extract<PushEvent, { type: 'preview' }>['state']

const quiet = () => undefined

/**
 * Where a shared file runs in its tab. An HTML page runs live in the locked-down native view main draws over `.sv-frame` (KERNEL-303), and
 * shows its still capture under that view. A PDF has no live view: Chromium's viewer doesn't render in the preview partition, so the tab
 * shows the page capture and the toolbar opens Kernel's copy in Preview. `again` counts Reload presses.
 */
export function PreviewSurface({ workspaceId, file, version, width, again }: { workspaceId: string; file: SharedFile; version: SharedVersion; width: PreviewWidth; again: number }) {
  if (file.kind === 'pdf') return <PdfPage file={file} version={version} />
  return <PagePreview workspaceId={workspaceId} file={file} version={version} width={width} again={again} />
}

function PdfPage({ file, version }: { file: SharedFile; version: SharedVersion }) {
  const still = useThumb(file, version)
  if (!still) return <p className="shared-none">No preview yet</p>
  return <img className="shared-page" src={still} alt={`Still capture of ${file.title}, version ${version.n}`} />
}

/** An app shortcut typed in the page, replayed on the window so the handlers in App, ChatTabs and the Composer run as for a typed key. */
function replayKey(e: Extract<PushEvent, { type: 'preview.key' }>) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, code: e.code, metaKey: e.meta, shiftKey: e.shift, altKey: e.alt, ctrlKey: e.ctrl, bubbles: true, cancelable: true }))
}

function PagePreview({ workspaceId, file, version, width, again }: { workspaceId: string; file: SharedFile; version: SharedVersion; width: PreviewWidth; again: number }) {
  // One view per tab, keyed by workspace and file. A fixture run has no live view, so its pushes name this key instead of a view.
  const key = `${workspaceId}:${file.id}`
  const frame = useRef<HTMLDivElement>(null)
  const thumb = useThumb(file, version)
  const [view, setView] = useState<{ id: string | null }>()
  const [still, setStill] = useState<string | null>(null)
  const [dead, setDead] = useState<PreviewState | null>(null)
  const [busy, run] = useBusy<'reload'>()
  const id = view?.id ?? null
  const watch = id ?? key
  const deadRef = useRef(dead)
  deadRef.current = dead
  // Set while Reload waits for the page to answer: the next ready, crashed or unresponsive push ends it.
  const answered = useRef<(() => void) | null>(null)

  useEffect(() => {
    let live = true
    setDead(null)
    call('system.preview.open', { sharedId: file.id, version: version.n, key })
      .then((r) => { if (live) { setView({ id: r.viewId }); setStill(r.still ?? null) } })
      .catch(() => { if (live) setView({ id: null }) })
    return () => { live = false }
  }, [key, version.n])

  const refresh = () => call('system.preview.still', { viewId: id! }).then((u) => { if (u) setStill(u) }).catch(quiet)

  // Bounds. Every frame, because a sidebar toggle, a banner or a panel drag moves the frame without resizing anything a ResizeObserver
  // watches. The rect goes out only when it changes, and null while something of Kernel's covers the page or the page has crashed.
  useEffect(() => {
    if (!id) return
    let last = ''
    let hidden = false
    let alive = true
    let raf = 0
    const place = (rect: Rect | null) => {
      const k = rect ? `${rect.x}|${rect.y}|${rect.width}|${rect.height}` : ''
      if (k === last) return
      last = k
      void call('system.preview.place', { viewId: id, rect }).catch(quiet)
    }
    const tick = () => {
      const el = frame.current
      if (!alive || !el || document.visibilityState !== 'visible') return
      const b = el.getBoundingClientRect()
      // The page fills the frame inside its border.
      const rect = { x: b.left + el.clientLeft, y: b.top + el.clientTop, width: el.clientWidth, height: el.clientHeight }
      if (deadRef.current || isCovered(rect)) {
        if (hidden) return
        hidden = true
        // Hide first, so the overlay draws over the still, then take a still of the page as it is now.
        place(null)
        if (!deadRef.current) void refresh()
      } else {
        hidden = false
        place(rect)
      }
    }
    const loop = () => { tick(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    // A menu or modal mounts between frames. Looking right after it does, rather than at the next frame, hides the view a frame sooner.
    const mounts = new MutationObserver(tick)
    mounts.observe(document.body, { childList: true, subtree: true })
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      mounts.disconnect()
      void call('system.preview.place', { viewId: id, rect: null }).catch(quiet)
      // Closing the tab closes its view. Switching to another tab keeps it, so coming back is instant.
      if (!getState().ui.tabs[workspaceId]?.shared?.includes(file.id)) void call('system.preview.close', { viewId: id }).catch(quiet)
    }
  }, [id])

  useEffect(() => onPush((e) => {
    if (e.type === 'preview.key') return e.code === 'F6' ? frame.current?.focus() : replayKey(e)
    if (e.type !== 'preview' || e.viewId !== watch) return
    if (e.state === 'crashed' || e.state === 'unresponsive') setDead(e.state)
    else if (e.state === 'ready' || e.state === 'settled') setDead(null)
    if (e.state === 'settled' && id) void refresh()
    if (e.state === 'ready' || e.state === 'crashed' || e.state === 'unresponsive') { answered.current?.(); answered.current = null }
  }), [watch])

  useEffect(() => { if (again > 0 && id) void call('system.preview.reload', { viewId: id }).catch(quiet) }, [again])

  const reload = () => run('reload', async () => {
    if (!id) return
    const settled = new Promise<void>((done) => { answered.current = done })
    await call('system.preview.reload', { viewId: id })
    await settled
  })
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget || !id) return
    e.preventDefault()
    void call('system.preview.focus', { viewId: id }).catch(quiet)
  }

  return (
    <div className="sv-stage">
      <div ref={frame} className="sv-frame" data-width={width} role="group" tabIndex={0} aria-label={`${file.title}. Press Enter to use the page, F6 to come back.`} onKeyDown={onKeyDown}>
        <img className="sv-still" alt="" src={still ?? thumb ?? undefined} />
      </div>
      {dead && (
        <div className="sv-crash" role="alert">
          <span className="sv-crash-icon"><Icon name="warning" size={20} stroke={1.4} /></span>
          <span className="sv-crash-title">This page stopped responding</span>
          <span className="sv-crash-sub">Reload to run it again.</span>
          <Button variant="primary" className="sv-reload" busy={busy === 'reload'} busyLabel="Reloading" onClick={() => void reload()}>Reload</Button>
        </div>
      )}
    </div>
  )
}
