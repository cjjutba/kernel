import { useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ChangedFile, CompareTarget, Workspace } from '@shared/types'
import { call, cleanError } from '../../api'
import { FileIcon } from '../../components/FileIcon'
import { actions } from '../../store'
import { LinkButton, Button } from '../../ui'
import { spotKey, useKeptScroll } from '../../ui/keptScroll'
import { addToComposer } from './composer/bus'
import { OpenImage } from './composer/Chip'
import { compareTitle, targetKey, useCompared } from './compare'
import { parseDiff } from './diff'
import { useLineFocus } from './fileLinks'
import { gitDecoration } from './gitStatus'

const split = (path: string) => { const i = path.lastIndexOf('/'); return { dir: path.slice(0, i + 1), name: path.slice(i + 1) } }

function ViewHead({ path, children, trailing }: { path: string; children?: React.ReactNode; trailing: React.ReactNode }) {
  const { dir, name } = split(path)
  return (
    <div className="view-head">
      <span className="row" style={{ minWidth: 0 }}><FileIcon path={path} /><span className="mono ellipsis t-code"><span className="muted">{dir}</span>{name}</span></span>
      {children}
      <span className="grow" />
      {trailing}
    </div>
  )
}

/** A file's name over its diff in All changes: its icon, and its git color as the Changes tab shows it (KERNEL-399). */
function DiffFileName({ path, status }: { path: string; status?: ChangedFile['status'] }) {
  const deco = gitDecoration(status)
  return <span className="row" style={{ minWidth: 0 }}><FileIcon path={path} /><span className="ellipsis" style={deco ? { color: deco.color, textDecoration: deco.struck ? 'line-through' : undefined } : undefined}>{path}</span></span>
}

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg)$/i
export const isImagePath = (path: string) => IMAGE_PATH.test(path)

/** The picture at a path, from the worktree or from the base the diff is against, or the compare `target` the Changes menu picked (KERNEL-517). `undefined` while it loads, `null` when there is none. */
function useImage(wsId: string, path: string, at: 'worktree' | 'base', target?: CompareTarget) {
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  const key = target ? targetKey(target) : ''
  useEffect(() => {
    let live = true
    setUrl(undefined)
    call('workspaces.readImage', { workspaceId: wsId, path, at, ...(target && target.kind !== 'base' && { target }) }).then((r) => { if (live) setUrl(r?.dataUrl ?? null) }).catch(() => { if (live) setUrl(null) })
    return () => { live = false }
  }, [wsId, path, at, key])
  return url
}

const NO_ROWS = '[data-keep-none]'

function useCodeScroll(ref: RefObject<HTMLElement | null>, wsId: string, view: string, ready: boolean) {
  const key = spotKey.panel(wsId, view)
  useKeptScroll(ref, { key, ready, itemSelector: NO_ROWS })
  useKeptScroll(ref, { key: `${key}:x`, ready, itemSelector: NO_ROWS, axis: 'x' })
}

const sizeText = (s: { w: number; h: number } | null) => (s ? `${s.w}×${s.h}` : '')

/** One picture of a file. With a `label` ("Before", "After") it carries a caption with its size, without one the parent shows the size through `onSize`. */
function ImagePane({ wsId, path, at, label, target, onSize }: { wsId: string; path: string; at: 'worktree' | 'base'; label?: string; target?: CompareTarget; onSize?: (s: { w: number; h: number }) => void }) {
  const url = useImage(wsId, path, at, target)
  const [loaded, setLoaded] = useState<{ url: string; w: number; h: number } | null>(null)
  const size = loaded && loaded.url === url ? loaded : null
  const openImage = useContext(OpenImage)
  const alt = label ? `${label}: ${path}` : path
  const picture = url
    ? <img src={url} alt={alt} onLoad={(e) => { const s = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }; setLoaded({ url, ...s }); onSize?.(s) }} />
    : null
  return (
    <figure className="image-pane">
      {label && <figcaption className="muted t-meta">{label}{size ? ` · ${sizeText(size)}` : ''}</figcaption>}
      {url === null
        ? <span className="muted t-meta">Can't show this picture.</span>
        : openImage && url && size
          ? <button type="button" className="image-open" aria-label={`Open ${path}`} onClick={() => openImage({ type: 'image', name: split(path).name, path, dataUrl: url })}>{picture}</button>
          : picture}
    </figure>
  )
}

/** The pictures of a changed image: the worktree's for an added one, the base's for a deleted one, and both for a changed one. */
function ImageChange({ wsId, path, status, target, onSize, inline, keep }: { wsId: string; path: string; status?: ChangedFile['status']; target?: CompareTarget; onSize?: (s: { w: number; h: number }) => void; inline?: boolean; keep?: string }) {
  const both = status === 'M'
  const scroller = useRef<HTMLDivElement>(null)
  useCodeScroll(scroller, wsId, keep ?? '', !!keep)
  return (
    <div ref={scroller} className="image-view" data-inline={inline || undefined}>
      {status === 'D'
        ? <ImagePane wsId={wsId} path={path} at="base" target={target} onSize={onSize} />
        : both
          ? <div className="image-pair"><ImagePane wsId={wsId} path={path} at="base" label="Before" target={target} /><ImagePane wsId={wsId} path={path} at="worktree" label="After" target={target} /></div>
          : <ImagePane wsId={wsId} path={path} at="worktree" target={target} onSize={onSize} />}
    </div>
  )
}

/** A file in the scratchpad has an absolute path, a file in the worktree one relative to it. */
function OpenInEditor({ ws, path }: { ws: Workspace; path: string }) {
  return <LinkButton size="meta" onClick={() => void call('system.openInEditor', { path: path.startsWith('/') ? path : `${ws.path}/${path}` })}>Open in editor</LinkButton>
}

/** A file in the worktree, read only, with line numbers (WorkspaceFile.png). */
export function FileView(props: { ws: Workspace; path: string; editedBy?: string; changed: boolean }) {
  return isImagePath(props.path) ? <ImageFile {...props} /> : <TextFile {...props} />
}

/** A picture in the worktree, from All files or a changed file. */
function ImageFile({ ws, path, editedBy, changed }: { ws: Workspace; path: string; editedBy?: string; changed: boolean }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  useCodeScroll(scroller, ws.id, `file:${path}`, true)
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <ViewHead path={path} trailing={<OpenInEditor ws={ws} path={path} />}>
        <span className="muted t-meta">Read only{changed && editedBy ? ` · edited by ${editedBy}` : ''}{size ? ` · ${sizeText(size)}` : ''}</span>
      </ViewHead>
      <div ref={scroller} className="image-view"><ImagePane wsId={ws.id} path={path} at="worktree" onSize={setSize} /></div>
    </div>
  )
}

function TextFile({ ws, path, editedBy, changed }: { ws: Workspace; path: string; editedBy?: string; changed: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setText(null); setError(null)
    call('workspaces.readFile', { workspaceId: ws.id, path }).then((t) => { if (live) setText(t) }).catch((e: Error) => { if (live) setError(cleanError(e)) })
    return () => { live = false }
  }, [ws.id, path])
  const lines = useMemo(() => (text ?? '').replace(/\n$/, '').split('\n'), [text])
  const scroller = useRef<HTMLDivElement>(null)
  useCodeScroll(scroller, ws.id, `file:${path}`, text !== null)
  // A link in chat to `path:12-30` scrolls to the lines and marks them.
  const range = useLineFocus(ws.id, path)
  useEffect(() => {
    if (!range || text === null) return
    const frame = requestAnimationFrame(() => scroller.current?.querySelector(`[data-line="${range.start}"]`)?.scrollIntoView({ block: 'center' }))
    return () => cancelAnimationFrame(frame)
  }, [range, text])
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <ViewHead path={path} trailing={<OpenInEditor ws={ws} path={path} />}>
        <span className="muted t-meta">Read only{changed && editedBy ? ` · edited by ${editedBy}` : ''}</span>
      </ViewHead>
      {error ? (
        <div className="panel-empty"><span className="ink2 t-medium">Can't show this file</span><span>{error}</span></div>
      ) : (
        <div ref={scroller} className="code-view selectable mono" role="region" aria-label={`Contents of ${path}`} tabIndex={0}>
          {text !== null && lines.map((l, i) => <div key={i} className="code-line" data-line={i + 1} data-hit={range && i + 1 >= range.start && i + 1 <= range.end ? '' : undefined}><span className="ln">{i + 1}</span><span className="src">{l || ' '}</span></div>)}
        </div>
      )}
    </div>
  )
}

/** An attached image opened from its chip, in a tab of its own. */
export function ImageView({ name, src, width, height }: { name: string; src: string; width?: number; height?: number }) {
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <ViewHead path={name} trailing={null}>
        {width && height ? <span className="muted t-meta">{width}×{height}</span> : null}
      </ViewHead>
      <div className="image-view"><img src={src} alt={name} /></div>
    </div>
  )
}

/** Pasted text opened from its chip, in a tab of its own: all of it, read only, with line numbers like a file. */
export function TextView({ name, text }: { name: string; text: string }) {
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text])
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <ViewHead path={name} trailing={null}>
        <span className="muted t-meta">Read only · {lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
      </ViewHead>
      <div className="code-view selectable mono" role="region" aria-label={`Contents of ${name}`} tabIndex={0}>
        {lines.map((l, i) => <div key={i} className="code-line"><span className="ln">{i + 1}</span><span className="src">{l || ' '}</span></div>)}
      </div>
    </div>
  )
}

// ---------- diff

/** Adds one hunk to the composer as a chip named `file:first-last`, with the hunk's lines as its text. */
function sendHunk(path: string, lines: { mark: string; code: string; hunk?: boolean }[], at: number) {
  const head = /\+(\d+)(?:,(\d+))?/.exec(lines[at].code)
  const start = head ? Number(head[1]) : 1
  const len = head?.[2] === undefined ? 1 : Number(head[2])
  let end = at + 1
  while (end < lines.length && !lines[end].hunk) end++
  const text = [lines[at].code, ...lines.slice(at + 1, end).map((l) => `${l.mark === ' ' ? ' ' : l.mark}${l.code}`)].join('\n')
  addToComposer({ type: 'file', name: `${path.slice(path.lastIndexOf('/') + 1)}:${start}-${start + Math.max(len, 1) - 1}`, path, lines: end - at - 1, text: `${path}\n${text}` })
}

/**
 * The diff of one file, or of every changed file when `path` is empty. It is a tab, so the tab's close button and Cmd+W close it. It follows what the
 * Changes menu compares with (KERNEL-517), so the files, the counts and the diffs are the list's, and `changes` is the workspace's own.
 */
export function DiffView({ ws, path, changes: base }: { ws: Workspace; path: string; changes: ChangedFile[] }) {
  const { compare, target, files, error } = useCompared(ws, base)
  // A pick whose files haven't arrived draws nothing yet, so a picture isn't shown against the wrong status.
  if (files === null && !error) return <div className="col grow" style={{ minHeight: 0 }} />
  const changes = files ?? NO_FILES
  return isImagePath(path) ? <ImageDiff ws={ws} path={path} changes={changes} target={target} /> : <TextDiff ws={ws} path={path} changes={changes} target={target} title={compareTitle(compare)} />
}

const NO_FILES: ChangedFile[] = []

/** The diff tab of one image: git only says the binary files differ, so it shows the pictures. */
function ImageDiff({ ws, path, changes, target }: { ws: Workspace; path: string; changes: ChangedFile[]; target: CompareTarget }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const status = changes.find((c) => c.path === path)?.status
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <ViewHead path={path} trailing={null}>{status !== 'M' && size && <span className="muted t-meta">{sizeText(size)}</span>}</ViewHead>
      <ImageChange wsId={ws.id} path={path} status={status} target={target} onSize={setSize} keep={`diff:${path}`} />
    </div>
  )
}

function TextDiff({ ws, path, changes, target, title }: { ws: Workspace; path: string; changes: ChangedFile[]; target: CompareTarget; title: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = targetKey(target)
  useEffect(() => {
    let live = true
    setText(null); setError(null)
    call('workspaces.diff', { workspaceId: ws.id, file: path || undefined, ...(target.kind !== 'base' && { target }) }).then((t) => { if (live) setText(t) }).catch((e: Error) => { if (live) setError(cleanError(e)) })
    return () => { live = false }
  }, [ws.id, path, key])
  const files = useMemo(() => parseDiff(text ?? ''), [text])
  const stat = path ? changes.find((c) => c.path === path) : undefined
  const scroller = useRef<HTMLDivElement>(null)
  useCodeScroll(scroller, ws.id, `diff:${path}`, text !== null)
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      {path
        ? <ViewHead path={path} trailing={null}>{stat && <span className="mono t-meta"><span className="add">+{stat.added}</span> <span className="del">-{stat.removed}</span></span>}</ViewHead>
        : <div className="view-head"><span className="t-medium">{title}</span><span className="muted t-meta">{changes.length} {changes.length === 1 ? 'file' : 'files'}</span></div>}
      <div ref={scroller} className="code-view code-view-flush selectable mono" role="region" aria-label="Diff" tabIndex={0}>
        {error && <div className="panel-empty"><span>{error}</span></div>}
        {text !== null && !files.length && !error && <div className="panel-empty"><span>No changes to show.</span></div>}
        {files.map((f) => (
          <div key={f.path}>
            {!path && <div className="diff-file"><DiffFileName path={f.path} status={changes.find((c) => c.path === f.path)?.status} />{!isImagePath(f.path) && <span><span className="add">+{f.added}</span> <span className="del">-{f.removed}</span></span>}</div>}
            {isImagePath(f.path) && <ImageChange wsId={ws.id} path={f.path} status={changes.find((c) => c.path === f.path)?.status} target={target} inline />}
            {!isImagePath(f.path) && f.lines.map((l, i) => (
              <div key={i} className="diff-line" data-mark={l.hunk ? 'hunk' : l.mark}>
                <span className="ln">{l.a}</span><span className="ln">{l.b}</span>
                <span className="mark">{l.hunk ? '' : l.mark === ' ' ? '' : l.mark}</span>
                <span className="src">{l.code || ' '}</span>
                {l.hunk && <Button size="sm" className="hunk-send" onClick={() => sendHunk(f.path, f.lines, i)}>Send to agent</Button>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
