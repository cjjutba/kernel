import { useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { ChangedFile, CompareTarget, Workspace } from '@shared/types'
import { call, cleanError } from '../../api'
import { FileIcon } from '../../components/FileIcon'
import { useRemembered } from '../../remember'
import { Button, EmptyList, IconButton } from '../../ui'
import { spotKey, useKeptScroll } from '../../ui/keptScroll'
import { addToComposer } from './composer/bus'
import { OpenImage } from './composer/Chip'
import { compareTitle, targetKey, useCompared } from './compare'
import { parseDiff, type DiffLine } from './diff'
import { languageOf } from './fileLang'
import { useLineFocus } from './fileLinks'
import { gitDecoration } from './gitStatus'

const split = (path: string) => { const i = path.lastIndexOf('/'); return { dir: path.slice(0, i + 1), name: path.slice(i + 1) } }

/**
 * What a file's header says (Pen 9.3, 9.4, 9.6): its icon, its name and the folder it is in, fainter, then `children` for what is true of it (the diff's counts), and `trailing` at the right.
 * It is the same in a tab and in the right panel.
 */
export function ViewHead({ path, children, trailing }: { path: string; children?: ReactNode; trailing?: ReactNode }) {
  const { dir, name } = split(path)
  return (
    <div className="view-head">
      <FileIcon path={path} />
      <span className="vh-name ellipsis">{name}</span>
      {dir && <span className="vh-dir ellipsis">{dir.replace(/\/$/, '')}</span>}
      {children}
      <span className="grow" />
      {trailing}
    </div>
  )
}

/** A file in the scratchpad has an absolute path, a file in the worktree one relative to it. */
function OpenInEditor({ ws, path }: { ws: Workspace; path: string }) {
  return <IconButton icon="ext" size={14} box="sm" label="Open in editor" onClick={() => void call('system.openInEditor', { path: path.startsWith('/') ? path : `${ws.path}/${path}` })} />
}

/** What sits at the right of a file's header: its language, Open in a tab when it is in the panel, and Open in editor. */
function FileTrail({ ws, path, onTab }: { ws: Workspace; path: string; onTab?: () => void }) {
  const language = languageOf(path)
  return (
    <>
      {language && <span className="vh-lang">{language}</span>}
      {onTab && <IconButton icon="maximize" size={14} box="sm" label="Open in a tab" onClick={onTab} />}
      <OpenInEditor ws={ws} path={path} />
    </>
  )
}

/** A file's name over its diff in All changes: its icon, and its git color as the Changes tab shows it (KERNEL-399). */
function DiffFileName({ path, status }: { path: string; status?: ChangedFile['status'] }) {
  const deco = gitDecoration(status)
  return <span className="row" style={{ minWidth: 0 }}><FileIcon path={path} /><span className="ellipsis" style={deco ? { color: deco.nameColor, textDecoration: deco.struck ? 'line-through' : undefined } : undefined}>{path}</span></span>
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
      {/* An after picture below its before one says so under it (Pen 9.17). */}
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

// ---------- selecting lines

/** Lines a person selected in a file or a diff: the numbers of the first and last, and what they say, for Send to agent. */
export interface PickedLines { start: number; end: number; text: string }

/**
 * The lines of `root` that a selection touches. A line is a `[data-line]` with its code in `.src`. A selection that only reaches the start of the next line, as a triple click does,
 * leaves that line out. The selection clears when it leaves `root`.
 */
export function useLineSelection(root: RefObject<HTMLElement | null>): [PickedLines | null, () => void] {
  const [picked, setPicked] = useState<PickedLines | null>(null)
  useEffect(() => {
    const read = () => {
      const el = root.current
      const sel = document.getSelection()
      if (!el || !sel || sel.isCollapsed || !sel.rangeCount) return setPicked(null)
      const range = sel.getRangeAt(0)
      if (!el.contains(range.commonAncestorContainer)) return setPicked(null)
      let lines = [...el.querySelectorAll<HTMLElement>('[data-line]')].filter((n) => range.intersectsNode(n))
      const last = lines[lines.length - 1]
      if (last && lines.length > 1 && range.endOffset === 0 && last.contains(range.endContainer)) lines = lines.slice(0, -1)
      if (!lines.length) return setPicked(null)
      const numbers = lines.map((n) => Number(n.dataset.line))
      setPicked((was) => {
        const next = { start: Math.min(...numbers), end: Math.max(...numbers), text: lines.map((n) => `${n.dataset.mark ?? ''}${n.querySelector('.src')?.textContent ?? ''}`).join('\n') }
        return was && was.start === next.start && was.end === next.end ? was : next
      })
    }
    document.addEventListener('selectionchange', read)
    return () => document.removeEventListener('selectionchange', read)
  }, [root])
  return [picked, () => { document.getSelection()?.removeAllRanges(); setPicked(null) }]
}

/** The chip a selection becomes in the composer: `file.ts:12-30`, with the lines as its text. */
export function sendLines(path: string, picked: PickedLines) {
  addToComposer({ type: 'file', name: `${split(path).name}:${picked.start}-${picked.end}`, path, lines: picked.end - picked.start + 1, text: `${path}\n${picked.text}` })
}

/** Send to agent, floating over the corner of a code view while lines are selected (Pen 9.22). */
function SendToAgent({ path, picked, clear }: { path: string; picked: PickedLines | null; clear: () => void }) {
  if (!picked) return null
  return (
    <div className="send-lines">
      <Button variant="primary" size="sm" icon="send" onMouseDown={(e) => e.preventDefault()} onClick={() => { sendLines(path, picked); clear() }}>Send to agent</Button>
    </div>
  )
}

// ---------- files

/** A file in the worktree, read only, with line numbers (WorkspaceFile.png). */
export function FileView(props: { ws: Workspace; path: string; editedBy?: string; changed: boolean }) {
  return isImagePath(props.path) ? <ImageFile {...props} /> : <TextFile {...props} />
}

/** The file for the right panel: its header with Open in a tab, then the same body a file tab has (Pen 9.3). */
export function PanelFile({ ws, path, editedBy, changed, onTab }: { ws: Workspace; path: string; editedBy?: string; changed: boolean; onTab: () => void }) {
  return isImagePath(path) ? <ImageFile ws={ws} path={path} editedBy={editedBy} changed={changed} onTab={onTab} /> : <TextFile ws={ws} path={path} editedBy={editedBy} changed={changed} onTab={onTab} />
}

/** A picture in the worktree, from All files or a changed file. */
function ImageFile({ ws, path, editedBy, changed, onTab }: { ws: Workspace; path: string; editedBy?: string; changed: boolean; onTab?: () => void }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  useCodeScroll(scroller, ws.id, `file:${path}`, true)
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <ViewHead path={path} trailing={<FileTrail ws={ws} path={path} onTab={onTab} />}>
        <span className="vh-dir">Read only{changed && editedBy ? ` · edited by ${editedBy}` : ''}{size ? ` · ${sizeText(size)}` : ''}</span>
      </ViewHead>
      <div ref={scroller} className="image-view"><ImagePane wsId={ws.id} path={path} at="worktree" onSize={setSize} /></div>
    </div>
  )
}

/** What the file view says about a file Kernel can't draw: binary, or too big. Open in editor is the way on (Pen 9.22). */
function CantShow({ ws, path, why }: { ws: Workspace; path: string; why: string }) {
  const reason = /binary|large|big|size|utf|bytes/i.test(why) ? "It's binary or too large to show here." : why
  return (
    <EmptyList icon="doc" title="Can't show this file" action={<Button onClick={() => void call('system.openInEditor', { path: path.startsWith('/') ? path : `${ws.path}/${path}` })}>Open in editor</Button>}>
      {reason}
    </EmptyList>
  )
}

function useFileText(wsId: string, path: string) {
  const [state, setState] = useState<{ text: string | null; error: string | null }>({ text: null, error: null })
  useEffect(() => {
    let live = true
    setState({ text: null, error: null })
    call('workspaces.readFile', { workspaceId: wsId, path }).then((t) => { if (live) setState({ text: t, error: null }) }).catch((e: Error) => { if (live) setState({ text: null, error: cleanError(e) }) })
    return () => { live = false }
  }, [wsId, path])
  return state
}

function TextFile({ ws, path, editedBy, changed, onTab }: { ws: Workspace; path: string; editedBy?: string; changed: boolean; onTab?: () => void }) {
  const { text, error } = useFileText(ws.id, path)
  const lines = useMemo(() => (text ?? '').replace(/\n$/, '').split('\n'), [text])
  const scroller = useRef<HTMLDivElement>(null)
  const [picked, clear] = useLineSelection(scroller)
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
      <ViewHead path={path} trailing={<FileTrail ws={ws} path={path} onTab={onTab} />}>
        {changed && editedBy && <span className="vh-dir">edited by {editedBy}</span>}
      </ViewHead>
      {error ? (
        <CantShow ws={ws} path={path} why={error} />
      ) : (
        <div className="code-wrap">
          <div ref={scroller} className="code-view selectable mono" role="region" aria-label={`Contents of ${path}`} tabIndex={0}>
            {text !== null && lines.map((l, i) => <div key={i} className="code-line" data-line={i + 1} data-hit={range && i + 1 >= range.start && i + 1 <= range.end ? '' : undefined}><span className="ln">{i + 1}</span><span className="src">{l || ' '}</span></div>)}
          </div>
          <SendToAgent path={path} picked={picked} clear={clear} />
        </div>
      )}
    </div>
  )
}

/** An attached image opened from its chip, in a tab of its own. */
export function ImageView({ name, src, width, height }: { name: string; src: string; width?: number; height?: number }) {
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <ViewHead path={name}>
        {width && height ? <span className="vh-dir">{width}×{height}</span> : null}
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
      <ViewHead path={name}>
        <span className="vh-dir">Read only · {lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
      </ViewHead>
      <div className="code-view selectable mono" role="region" aria-label={`Contents of ${name}`} tabIndex={0}>
        {lines.map((l, i) => <div key={i} className="code-line"><span className="ln">{i + 1}</span><span className="src">{l || ' '}</span></div>)}
      </div>
    </div>
  )
}

// ---------- diffs

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

const NO_FILES: ChangedFile[] = []

/** Which files of the diff a person has marked Viewed, kept per workspace. A path never holds a newline, so one line is one file. */
function useViewed(wsId: string, path: string): [boolean, (on: boolean) => void] {
  const [raw, set] = useRemembered(`kernel.viewed:${wsId}`, (v) => v ?? '')
  const list = raw ? raw.split('\n') : []
  return [list.includes(path), (on) => set([...list.filter((p) => p !== path), ...(on ? [path] : [])].join('\n'))]
}

/** "1 of 2" with Previous and Next, which step through the changed files, and Viewed, which marks the file read (Pen 9.5, 9.6). */
function DiffTrail({ ws, path, stepper }: { ws: Workspace; path: string; stepper?: Stepper }) {
  const [viewed, setViewed] = useViewed(ws.id, path)
  return (
    <>
      {stepper && stepper.total > 1 && (
        <>
          <span className="vh-step">{stepper.index + 1} of {stepper.total}</span>
          <IconButton icon="chevron" size={12} box="sm" className="vh-up" label="Previous file" disabled={stepper.index === 0} onClick={() => stepper.go(stepper.index - 1)} />
          <IconButton icon="chevron" size={12} box="sm" label="Next file" disabled={stepper.index >= stepper.total - 1} onClick={() => stepper.go(stepper.index + 1)} />
        </>
      )}
      <button type="button" className="vh-viewed" aria-pressed={viewed} onClick={() => setViewed(!viewed)}>
        <span className="vh-box" aria-hidden="true">{viewed && <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg>}</span>
        Viewed
      </button>
    </>
  )
}

/** The file the diff shows among the changed ones, and how to move to another. */
export interface Stepper { index: number; total: number; go: (index: number) => void }

/**
 * The diff of one file, or of every changed file when `path` is empty. It is a tab, so the tab's close button and Cmd+W close it. It follows what the
 * Changes menu compares with (KERNEL-517), so the files, the counts and the diffs are the list's, and `changes` is the workspace's own.
 */
export function DiffView({ ws, path, changes: base, stepper, footer }: { ws: Workspace; path: string; changes: ChangedFile[]; stepper?: Stepper; footer?: ReactNode }) {
  const { compare, target, files, error } = useCompared(ws, base)
  // A pick whose files haven't arrived draws nothing yet, so a picture isn't shown against the wrong status.
  if (files === null && !error) return <div className="col grow" style={{ minHeight: 0 }} />
  const changes = files ?? NO_FILES
  return isImagePath(path) ? <ImageDiff ws={ws} path={path} changes={changes} target={target} stepper={stepper} /> : <TextDiff ws={ws} path={path} changes={changes} target={target} title={compareTitle(compare)} stepper={stepper} footer={footer} />
}

/** The diff tab of one image: git only says the binary files differ, so it shows the pictures. */
function ImageDiff({ ws, path, changes, target, stepper }: { ws: Workspace; path: string; changes: ChangedFile[]; target: CompareTarget; stepper?: Stepper }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const status = changes.find((c) => c.path === path)?.status
  const word = status === 'A' || status === '?' ? 'Added' : status === 'D' ? 'Deleted' : 'Changed'
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <ViewHead path={path} trailing={<DiffTrail ws={ws} path={path} stepper={stepper} />}>
        <span className="vh-dir">{word}{size ? ` · ${sizeText(size)}` : ''}</span>
      </ViewHead>
      <ImageChange wsId={ws.id} path={path} status={status} target={target} onSize={setSize} keep={`diff:${path}`} />
    </div>
  )
}

/** One line of a diff: both line numbers, the mark and the code. A hunk's header carries Send to agent. */
function DiffRow({ path, lines, i }: { path: string; lines: DiffLine[]; i: number }) {
  const l = lines[i]
  return (
    <div className="diff-line" data-mark={l.hunk ? 'hunk' : l.mark} {...(l.hunk ? {} : { 'data-line': l.b || l.a })}>
      <span className="ln">{l.a}</span><span className="ln">{l.b}</span>
      <span className="mark">{l.hunk ? '' : l.mark === ' ' ? '' : l.mark}</span>
      <span className="src">{l.code || ' '}</span>
      {l.hunk && <Button size="sm" className="hunk-send" onClick={() => sendHunk(path, lines, i)}>Send to agent</Button>}
    </div>
  )
}

function TextDiff({ ws, path, changes, target, title, stepper, footer }: { ws: Workspace; path: string; changes: ChangedFile[]; target: CompareTarget; title: string; stepper?: Stepper; footer?: ReactNode }) {
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
  const [picked, clear] = useLineSelection(scroller)
  useCodeScroll(scroller, ws.id, `diff:${path}`, text !== null)
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      {path
        ? <ViewHead path={path} trailing={<DiffTrail ws={ws} path={path} stepper={stepper} />}>{stat && <span className="mono vh-counts">{stat.added ? <span className="add">+{stat.added}</span> : null}{stat.removed ? <span className="del">-{stat.removed}</span> : null}</span>}</ViewHead>
        : <div className="view-head"><span className="t-medium vh-title">{title}</span><span className="vh-dir">{changes.length} {changes.length === 1 ? 'file' : 'files'}</span></div>}
      <div className="code-wrap">
        <div ref={scroller} className="code-view code-view-flush selectable mono" role="region" aria-label="Diff" tabIndex={0}>
          {text !== null && !files.length && !error && <EmptyList icon="doc" title="No changes to show." />}
          {error && <EmptyList icon="warning" title="Can't show this diff">{error}</EmptyList>}
          {files.map((f) => (
            <div key={f.path}>
              {!path && <div className="diff-file"><DiffFileName path={f.path} status={changes.find((c) => c.path === f.path)?.status} />{!isImagePath(f.path) && <span><span className="add">+{f.added}</span> <span className="del">-{f.removed}</span></span>}</div>}
              {isImagePath(f.path) && <ImageChange wsId={ws.id} path={f.path} status={changes.find((c) => c.path === f.path)?.status} target={target} inline />}
              {!isImagePath(f.path) && f.lines.map((_, i) => <DiffRow key={i} path={f.path} lines={f.lines} i={i} />)}
            </div>
          ))}
        </div>
        {!footer && path && <SendToAgent path={path} picked={picked} clear={clear} />}
      </div>
      {footer && path && <DiffAsk path={path} picked={picked} clear={clear}>{footer}</DiffAsk>}
    </div>
  )
}

/** The line under a diff in the right panel (Pen 9.5): what to do, and Ask once lines are selected. `children` is the agent's name. */
function DiffAsk({ path, picked, clear, children }: { path: string; picked: PickedLines | null; clear: () => void; children: ReactNode }) {
  return (
    <div className="diff-ask">
      <span className="diff-ask-hint">{picked ? `${picked.end - picked.start + 1} ${picked.end === picked.start ? 'line' : 'lines'} selected` : <>Select lines to ask {children} about them</>}</span>
      <span className="grow" />
      <button type="button" className="diff-ask-go" disabled={!picked} onMouseDown={(e) => e.preventDefault()} onClick={() => { if (picked) { sendLines(path, picked); clear() } }}>Ask {children}</button>
    </div>
  )
}

/** The diff for the right panel: the same body a diff tab has, with Select lines to ask the agent under it (Pen 9.5). */
export function PanelDiff({ ws, path, changes, stepper, agent }: { ws: Workspace; path: string; changes: ChangedFile[]; stepper: Stepper; agent: string }) {
  return <DiffView ws={ws} path={path} changes={changes} stepper={stepper} footer={agent} />
}
