import { useEffect, useMemo, useState } from 'react'
import type { ChangedFile, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions } from '../../store'
import { Button } from '../../ui'
import { addToComposer } from './composer/bus'
import { parseDiff } from './diff'

const split = (path: string) => { const i = path.lastIndexOf('/'); return { dir: path.slice(0, i + 1), name: path.slice(i + 1) } }

function ViewHead({ path, children, trailing }: { path: string; children?: React.ReactNode; trailing: React.ReactNode }) {
  const { dir, name } = split(path)
  return (
    <div className="view-head">
      <span className="mono" style={{ fontSize: 12.5 }}><span className="muted">{dir}</span>{name}</span>
      {children}
      <span className="grow" />
      {trailing}
    </div>
  )
}

/** A file in the worktree, read only, with line numbers (WorkspaceFile.png). */
export function FileView({ ws, path, editedBy, changed }: { ws: Workspace; path: string; editedBy?: string; changed: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setText(null); setError(null)
    call('workspaces.readFile', { workspaceId: ws.id, path }).then((t) => { if (live) setText(t) }).catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [ws.id, path])
  const lines = useMemo(() => (text ?? '').replace(/\n$/, '').split('\n'), [text])
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <ViewHead path={path} trailing={<button type="button" className="open-editor" onClick={() => void call('system.openInEditor', { path: `${ws.path}/${path}` })}>Open in editor</button>}>
        <span className="muted" style={{ fontSize: 12 }}>Read only{changed && editedBy ? ` · edited by ${editedBy}` : ''}</span>
      </ViewHead>
      {error ? (
        <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>Can't show this file</span><span>{error}</span></div>
      ) : (
        <div className="code-view selectable mono" role="region" aria-label={`Contents of ${path}`} tabIndex={0}>
          {text !== null && lines.map((l, i) => <div key={i} className="code-line"><span className="ln">{i + 1}</span><span className="src">{l || ' '}</span></div>)}
        </div>
      )}
    </div>
  )
}

/** An attached image opened from its chip, in a tab of its own, as in Conductor. */
export function ImageView({ name, src, width, height }: { name: string; src: string; width?: number; height?: number }) {
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <ViewHead path={name} trailing={null}>
        {width && height ? <span className="muted" style={{ fontSize: 12 }}>{width}×{height}</span> : null}
      </ViewHead>
      <div className="image-view"><img src={src} alt={name} /></div>
    </div>
  )
}

// ---------- diff

/** The diff of one file, or of every changed file when `path` is empty. */
/** Adds one hunk to the composer as a chip named `file:first-last`, with the hunk's lines as its text. */
function sendHunk(path: string, lines: { mark: string; code: string; hunk?: boolean }[], at: number) {
  const head = /\+(\d+)(?:,(\d+))?/.exec(lines[at].code)
  const start = head ? Number(head[1]) : 1
  const len = head?.[2] === undefined ? 1 : Number(head[2])
  let end = at + 1
  while (end < lines.length && !lines[end].hunk) end++
  const text = [lines[at].code, ...lines.slice(at + 1, end).map((l) => `${l.mark === ' ' ? ' ' : l.mark}${l.code}`)].join('\n')
  addToComposer({ type: 'file', name: `${path.slice(path.lastIndexOf('/') + 1)}:${start}-${start + Math.max(len, 1) - 1}`, path, lines: end - at - 1, text: `${path}\n${text}` })
  actions.ui.setWorkspaceView({ diff: undefined })
}

export function DiffView({ ws, path, changes, onClose }: { ws: Workspace; path: string; changes: ChangedFile[]; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setText(null); setError(null)
    call('workspaces.diff', { workspaceId: ws.id, file: path || undefined }).then((t) => { if (live) setText(t) }).catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [ws.id, path])
  const files = useMemo(() => parseDiff(text ?? ''), [text])
  const stat = path ? changes.find((c) => c.path === path) : undefined
  const back = <Button variant="ghost" onClick={onClose}>Back to chat</Button>
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      {path
        ? <ViewHead path={path} trailing={back}>{stat && <span className="mono" style={{ fontSize: 12 }}><span className="add">+{stat.added}</span> <span className="del">-{stat.removed}</span></span>}</ViewHead>
        : <div className="view-head"><span style={{ fontWeight: 500 }}>All changes</span><span className="muted" style={{ fontSize: 12 }}>{changes.length} {changes.length === 1 ? 'file' : 'files'}</span><span className="grow" />{back}</div>}
      <div className="code-view selectable mono" role="region" aria-label="Diff" tabIndex={0} style={{ padding: '8px 0' }}>
        {error && <div className="panel-empty"><span>{error}</span></div>}
        {text !== null && !files.length && !error && <div className="panel-empty"><span>No changes to show.</span></div>}
        {files.map((f) => (
          <div key={f.path}>
            {!path && <div className="diff-file"><span>{f.path}</span><span><span className="add">+{f.added}</span> <span className="del">-{f.removed}</span></span></div>}
            {f.lines.map((l, i) => (
              <div key={i} className="diff-line" data-mark={l.hunk ? 'hunk' : l.mark}>
                <span className="ln">{l.a}</span><span className="ln">{l.b}</span>
                <span className="mark">{l.hunk ? '' : l.mark === ' ' ? '' : l.mark}</span>
                <span className="src">{l.code || ' '}</span>
                {l.hunk && <button type="button" className="hunk-send" onClick={() => sendHunk(f.path, f.lines, i)}>Send to agent</button>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
