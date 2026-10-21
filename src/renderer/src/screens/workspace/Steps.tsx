import { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { ChangedFile, ChatItem } from '@shared/types'
import { maskSecrets, SERVICE_NAME, stripAnsi, toolView, type ToolCtx, type ToolView } from '@shared/toolView'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'
import { AgentAvatar, Icon, Menu, Spinner, type IconName } from '../../ui'
import { Markdown } from './markdown'
import { HoverPreview, OpenImage, type ImagePart } from './composer/Chip'
import { TranscriptChat, useRowOpen } from './chatPlace'
import { settle, wantOpen, windowEntries } from './fold'
import { fmtDuration, foldSpan, type Entry, type ThreadBlock } from './thread'

type Tool = Extract<ChatItem, { kind: 'tool' }>
type Group = Extract<ThreadBlock, { kind: 'group' }>

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** The workspace a transcript belongs to, so a Read row on an image can load its file. */
export const TranscriptWorkspace = createContext<string | null>(null)

/** Whether the reader is away from the end of the transcript, which a fold waits on before it closes under them. */
export const TranscriptAway = createContext(false)

/**
 * What a turn's fold header says about the clock: when the turn started, and, while a question or an approval waits on the reader, what it waits on and how long the
 * turn had worked when it asked. The clock stops there, since waiting on you is not work (KERNEL-1094).
 */
export interface TurnClockValue { since: number; waiting?: { what: 'answer' | 'approval'; after: number } }
export const TurnClock = createContext<TurnClockValue>({ since: 0 })

/** A running clock, in the units a turn is counted in. It reads the real time every second and never keeps one of its own. */
export function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/** The working clock: how long the turn has run, counted from its message. */
function Elapsed({ since }: { since: number }) {
  const now = useNow(true)
  return <>{fmtDuration(now - since)}</>
}

/** The fold's header: how the turn is going in one line, with a chevron that opens its steps. It has no count of steps (KERNEL-1094). */
export function FoldHead({ state, since, after, ms, open, onToggle, controls, what }: { state: 'working' | 'waiting' | 'worked'; since?: number; after?: number; ms?: number; open: boolean; onToggle: () => void; controls?: string; what?: 'answer' | 'approval' }) {
  const word = state === 'working' ? 'Working' : state === 'waiting' ? `Waiting on your ${what ?? 'answer'}` : ms !== undefined ? `Worked for ${fmtDuration(ms)}` : 'Worked'
  return (
    <button type="button" className="fold-head" data-state={state} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      {state === 'working' && <span className="fold-glyph"><Spinner label={null} pattern="spiral" /></span>}
      {state === 'waiting' && <span className="fold-glyph fold-wait"><Icon name="hourglass" size={12} /></span>}
      <span className="fold-word">{word}</span>
      {state === 'working' && since !== undefined && <span className="fold-time"><Elapsed since={since} /></span>}
      {state === 'waiting' && after !== undefined && after >= 1000 && <span className="fold-time">{fmtDuration(after)}</span>}
      <span className="fold-chev" data-open={open}><Icon name="chevron" size={12} /></span>
    </button>
  )
}

/** The line at the end of a running turn that has no fold to carry the clock yet: the turn only just started, or it has said nothing but a message. */
export function TurnLine({ since, note }: { since: number; /** What the turn is doing before it has steps to show, such as "Creating the worktree". It takes the clock's place. */ note?: string }) {
  const clock = useContext(TurnClock)
  const waiting = clock.waiting
  return (
    <span className="fold-head fold-line" data-state={waiting ? 'waiting' : 'working'}>
      {waiting ? <span className="fold-glyph fold-wait"><Icon name="hourglass" size={12} /></span> : <span className="fold-glyph"><Spinner label="Working" pattern="spiral" /></span>}
      <span className="fold-word">{waiting ? `Waiting on your ${waiting.what}` : 'Working'}</span>
      {note && !waiting ? <span className="fold-note">{note}</span> : waiting ? (waiting.after >= 1000 && <span className="fold-time">{fmtDuration(waiting.after)}</span>) : <span className="fold-time"><Elapsed since={since} /></span>}
    </span>
  )
}

// ---- step rows ----

/** The tool call as it was made, for whoever wants to replay or report it. Masked like everything the row shows. */
const rawCall = (item: Tool) => maskSecrets(JSON.stringify({ name: item.name, input: item.input, output: item.output }, null, 2))

const copied = (what: string, value: string) => navigator.clipboard.writeText(value).then(() => actions.ui.toast({ title: `${what} copied` }), () => actions.ui.toast({ title: 'Could not copy', sub: 'The clipboard is not available.' }))

/** The output as it is shown: without terminal colors, with secrets masked. */
const cleanOutput = (item: Tool) => (item.output ? maskSecrets(stripAnsi(item.output)) : '')

/** The "..." at the end of a step's row. It shows with the row's hover and focus, and holds what a step can copy. */
function StepMenu({ id, item }: { id: string; item: Tool }) {
  const menu = `step:${id}` as const
  const open = useStore((s) => s.ui.menu === menu)
  const anchor = useRef<HTMLSpanElement>(null)
  const output = cleanOutput(item)
  return (
    <span ref={anchor} className="step-more" data-open={open || undefined}>
      <button type="button" className="icon-btn xs" aria-label="Step actions" aria-haspopup="menu" aria-expanded={open} onClick={() => actions.ui.toggleMenu(menu)}><Icon name="more" size={14} /></button>
      {open && (
        <Menu label="Step actions" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: 0, top: 'calc(100% + var(--menu-gap))', width: 220 }}
          items={[
            { id: 'output', label: 'Copy output', icon: 'copy', disabled: !output, onSelect: () => void copied('Output', output) },
            { id: 'raw', label: 'Copy raw call', icon: 'code', onSelect: () => void copied('Call', rawCall(item)) }
          ]} />
      )}
    </span>
  )
}

/** What a step shows at the right of its row: the lines it added and took out. */
function Counts({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null
  return <span className="step-n">{added > 0 && <span className="add">+{added}</span>}{removed > 0 && <span className="del">-{removed}</span>}</span>
}

type StepState = 'running' | 'done' | 'failed' | 'denied' | 'stopped'

/**
 * One step of the agent's work: an icon, a verb and what it touched, on one line (KERNEL-1094). A step that has something to show opens in place,
 * its result nested under it. A running step draws the loader in its icon's place. Open state is local, so a tool going from running to done keeps it.
 * `glyph` draws in the icon's place, `peek` is the hover preview of a Read on an image, and `onOpen` runs before the row opens and resolves true when it handled the click.
 */
function StepRow({ icon, glyph, state, title, detail, counts, name, startOpen, menu, onPeek, peek, onOpen, children }: {
  icon: IconName; glyph?: ReactNode; state: StepState; title: string; detail?: ReactNode; counts?: { added: number; removed: number }; name?: string; startOpen?: boolean
  menu?: ReactNode; onPeek?: () => void; peek?: ReactNode; onOpen?: () => Promise<boolean>; children?: ReactNode
}) {
  const [open, setOpen] = useState(!!startOpen)
  const [at, setAt] = useState<DOMRect | null>(null)
  const panel = useId()
  const can = !!children
  useEffect(() => {
    if (!at) return
    const hide = () => setAt(null)
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [at])
  const show = (el: HTMLElement) => { setAt(el.getBoundingClientRect()); onPeek?.() }
  const click = () => {
    setAt(null)
    if (!onOpen) return setOpen(!open)
    void onOpen().then((handled) => { if (!handled) setOpen((o) => !o) })
  }
  return (
    <div className="step" data-state={state} data-open={(open && can) || undefined}>
      <div className="step-line">
        <button
          type="button" className="trow trow-btn" aria-label={name} aria-expanded={can ? open : undefined} aria-controls={can ? panel : undefined} disabled={!can} onClick={click}
          {...(onPeek && {
            onMouseEnter: (e: MouseEvent<HTMLElement>) => show(e.currentTarget), onMouseLeave: () => setAt(null),
            // Focus shows it from the keyboard only, so a click doesn't bring it back.
            onFocus: (e: React.FocusEvent<HTMLElement>) => { if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget) }, onBlur: () => setAt(null),
            onKeyDown: (e: KeyboardEvent<HTMLElement>) => { if (e.key === 'Escape' && at) { e.stopPropagation(); setAt(null) } }
          })}
        >
          <span className="step-ic">{state === 'running' ? <Spinner label={null} pattern="spiral" /> : glyph ?? <Icon name={icon} size={13} />}</span>
          <span className="step-title">{title}</span>
          {detail}
          {can && <span className="step-chev" data-open={open}><Icon name="chevron" size={12} /></span>}
          <span className="grow" />
          {counts && <Counts {...counts} />}
        </button>
        {menu}
      </div>
      {at && peek && <HoverPreview at={at} className="img-preview">{peek}</HoverPreview>}
      {open && can && <div id={panel} className="step-body">{children}</div>}
    </div>
  )
}

// ---- what a step opens to ----

/** The lines an output shows before it is cut to its last ten (or its first ten, for a file). */
const SHOWN = 10
const LONG_AT = 14

/** A tool's output in a box. Past `LONG_AT` lines it shows ten and a row above says how many there are, which opens the rest. A failed step's output is red. */
function OutputBox({ output, failed, from = 'end' }: { output: string; failed?: boolean; from?: 'start' | 'end' }) {
  const lines = useMemo(() => output.replace(/\s+$/, '').split('\n'), [output])
  const [all, setAll] = useState(false)
  const long = lines.length > LONG_AT
  const shown = !long || all ? lines : from === 'end' ? lines.slice(-SHOWN) : lines.slice(0, SHOWN)
  return (
    <>
      {long && (
        <button type="button" className="step-fewer" aria-expanded={all} onClick={() => setAll(!all)}>
          <Icon name="chevron" size={12} />{all ? `Show ${from === 'end' ? 'last' : 'first'} ${SHOWN} lines` : `Show all ${lines.length} lines`}
        </button>
      )}
      <pre className="step-out" data-state={failed ? 'failed' : undefined} tabIndex={0} aria-label="Output">{shown.join('\n')}</pre>
    </>
  )
}

type Row = { k: 'add' | 'del' | 'ctx' | 'hunk'; t: string }

const SIGN: Record<Row['k'], string> = { add: '+', del: '-', ctx: '', hunk: '' }

/** Diff lines in a box, each with its sign, the way an edit shows what it put in and took out. */
function DiffBox({ rows }: { rows: Row[] }) {
  return (
    <div className="step-diff" role="group" aria-label="Changes">
      {rows.map((r, i) => (
        <div key={i} className="step-dl" data-k={r.k}>
          <span className={`sg${r.k === 'add' ? ' add' : r.k === 'del' ? ' del' : ''}`} aria-hidden="true">{SIGN[r.k]}</span>
          <span className="tx">{r.t || ' '}</span>
        </div>
      ))}
    </div>
  )
}

const lines = (t: string) => (t ? t.split('\n') : [])

/** What an Edit took out and put in: its lines, one side then the other. */
const editRows = (pairs: { from: string; to: string }[]): Row[] =>
  pairs.flatMap((p) => [...lines(maskSecrets(p.from)).map((t): Row => ({ k: 'del', t })), ...lines(maskSecrets(p.to)).map((t): Row => ({ k: 'add', t }))])

const pairsOf = (item: Tool): { from: string; to: string }[] => {
  const i = item.input ?? {}
  if (item.name === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') return [{ from: i.old_string, to: i.new_string }]
  if (item.name === 'MultiEdit' && Array.isArray(i.edits)) return i.edits.filter((e): e is { old_string: string; new_string: string } => !!e && typeof e.old_string === 'string' && typeof e.new_string === 'string').map((e) => ({ from: e.old_string, to: e.new_string }))
  return []
}

const looksLikePatch = (t: string) => /^(diff --git |--- |@@ )/m.test(t)

interface PatchFile { path: string; added: number; removed: number; rows: Row[] }

/** A unified diff, as Codex's file changes write it, split into its files: each with its lines, hunk headers apart. */
function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = []
  let cur: PatchFile | undefined
  for (const l of patch.split('\n')) {
    if (l.startsWith('diff --git ')) { cur = { path: l.replace(/^diff --git a\/(.*) b\/.*$/, '$1'), added: 0, removed: 0, rows: [] }; files.push(cur); continue }
    if (l.startsWith('--- ') || l.startsWith('+++ ')) {
      if (!cur) { cur = { path: l.slice(4).replace(/^[ab]\//, ''), added: 0, removed: 0, rows: [] }; files.push(cur) }
      continue
    }
    if (!cur || /^(index |new file|deleted file|similarity|rename |old mode|new mode|\\ )/.test(l)) continue
    if (l.startsWith('@@')) cur.rows.push({ k: 'hunk', t: l })
    else if (l.startsWith('+')) { cur.added++; cur.rows.push({ k: 'add', t: l.slice(1) }) }
    else if (l.startsWith('-')) { cur.removed++; cur.rows.push({ k: 'del', t: l.slice(1) }) }
    else if (l.startsWith(' ')) cur.rows.push({ k: 'ctx', t: l.slice(1) })
  }
  return files
}

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** The patch a file change from Codex carries in its output, as its files. Null for any other call. */
function patchOf(item: Tool): PatchFile[] | null {
  if (!FILE_TOOLS.has(item.name) || !item.output) return null
  const clean = maskSecrets(stripAnsi(item.output))
  if (!looksLikePatch(clean)) return null
  const files = parsePatch(clean)
  return files.length ? files : null
}

/** What a call added and took out, from the call itself: an Edit's two sides, a Write's lines, a patch's plus and minus lines. A call that says none reads the workspace's changed file. */
function countsOf(item: Tool, changes: ChangedFile[]): { added: number; removed: number } | undefined {
  const patch = patchOf(item)
  if (patch) return { added: patch.reduce((n, f) => n + f.added, 0), removed: patch.reduce((n, f) => n + f.removed, 0) }
  const pairs = pairsOf(item)
  if (pairs.length) return { added: pairs.reduce((n, p) => n + lines(p.to).length, 0), removed: pairs.reduce((n, p) => n + lines(p.from).length, 0) }
  if (item.name === 'Write' && typeof item.input?.content === 'string') return { added: lines(item.input.content).length, removed: 0 }
  const file = (item.name === 'Edit' || item.name === 'Write') && changes.find((c) => c.path === item.detail)
  return file ? { added: file.added, removed: file.removed } : undefined
}

const WRITE_SHOWN = 5

/** A Write opens to its first lines, all added, and says how many more there are. The rest open from that line. */
function WriteBox({ content }: { content: string }) {
  const all = useMemo(() => lines(maskSecrets(content)), [content])
  const [more, setMore] = useState(false)
  const shown = more ? all : all.slice(0, WRITE_SHOWN)
  const rest = all.length - WRITE_SHOWN
  return (
    <>
      <DiffBox rows={shown.map((t): Row => ({ k: 'add', t }))} />
      {rest > 0 && <button type="button" className="step-fewer" aria-expanded={more} onClick={() => setMore(!more)}><Icon name="chevron" size={12} />{more ? 'Show fewer lines' : `${rest} more ${rest === 1 ? 'line' : 'lines'}`}</button>}
    </>
  )
}

/** "after 42s": what a command took, to the tenth of a second while it is under ten. */
const took = (ms: number | undefined) => (ms === undefined ? '' : ` after ${ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : fmtDuration(ms)}`)

/** How a Bash call ended: the exit code a failure printed, or 0, since a call that went well exited with it. */
function exitLine(item: Tool, output: string): { line: string; output: string } {
  if (item.status === 'done') return { line: `Exited with 0${took(item.durationMs)}`, output }
  const code = /^Exit code (\d+)\n?/i.exec(output)
  return code ? { line: `Exited with ${code[1]}${took(item.durationMs)}`, output: output.slice(code[0].length) } : { line: `Failed${took(item.durationMs)}`, output }
}

/** Every top-level field of an MCP call's input as a row, the key and then what it was set to. Secrets are masked. */
function fieldsOf(input: Record<string, unknown>): [string, string][] {
  const label = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
  const value = (v: unknown): string => (Array.isArray(v) ? v.map(value).join(', ') : v && typeof v === 'object' ? JSON.stringify(v) : String(v))
  return Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [label(k), maskSecrets(value(v))])
}

const URL_IN = /https?:\/\/[^\s"'<>)]+/

/** A response that parses as JSON is shown indented, the way the request is. Anything else is left as it came. */
function prettyJson(t: string): string {
  const s = t.trim()
  if (!/^[[{]/.test(s)) return t
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return t }
}

/** An MCP call opened: what it was asked, field by field, then what came back. A short answer is one line, with a link when it names one. A long one is the output box. */
function McpBody({ item }: { item: Tool }) {
  const fields = fieldsOf(item.input ?? {})
  const output = prettyJson(cleanOutput(item))
  const first = output.split('\n').find((l) => l.trim())?.trim()
  const short = output.split('\n').length <= 1 && output.length <= 140
  const url = URL_IN.exec(output)?.[0]
  return (
    <>
      {fields.length > 0 && (
        <dl className="step-fields">
          {fields.slice(0, 8).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          {fields.length > 8 && <div><dt /><dd className="muted">{fields.length - 8} more fields</dd></div>}
        </dl>
      )}
      {output && short && (
        <p className="step-result">
          {url ? <button type="button" className="step-link" onClick={() => void call('system.openExternal', { url })}>{first}<Icon name="ext" size={12} /></button> : first}
        </p>
      )}
      {output && !short && <OutputBox output={output} failed={item.status === 'failed'} from="start" />}
    </>
  )
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i

/** The image a Read row opened, by its file's path. Codex's view_image calls are Read rows too, so the provider doesn't matter. */
function readImage(item: Tool): string | undefined {
  if (item.name !== 'Read') return undefined
  const path = text(item.input?.file_path) ?? item.detail
  return path && IMAGE_FILE.test(path) ? path : undefined
}

/** A path a Read row named, made relative to the workspace folder as `workspaces.readImage` takes it. Null when it is absolute and outside the folder. */
function workspaceRelative(path: string, root?: string): string | null {
  const base = root?.replace(/[\\/]+$/, '')
  if (base && (path.startsWith(`${base}/`) || path.startsWith(`${base}\\`))) return path.slice(base.length + 1)
  return /^([\\/]|[a-zA-Z]:[\\/])/.test(path) ? null : path
}

/** "412 KB" from the length of a data URL's payload. */
function kb(dataUrl: string): string {
  const bytes = Math.round(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4)
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`
}

/** The picture a Read on an image opened to: the image itself at the size of a card, what it measures, and a link that opens it in a tab. A file that is gone says so. */
function ImageBody({ image, file, load, loaded, failed, onOpen }: { image: string; file: string; load: () => Promise<ImagePart | null>; loaded: ImagePart | null; failed: boolean; onOpen?: () => void }) {
  const [size, setSize] = useState<string>()
  useEffect(() => { void load() }, [load])
  if (!loaded) {
    if (!failed) return <div className="step-missing"><Spinner label="Loading" pattern="arrow-down" />Loading the image</div>
    return <div className="step-missing"><Icon name="image" size={14} />{file} is no longer on disk</div>
  }
  return (
    <>
      <img className="step-img" src={loaded.dataUrl} alt={image} onLoad={(e) => setSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight} · ${kb(loaded.dataUrl)}`)} />
      <p className="step-img-meta">
        {size && <span>{size}</span>}
        {onOpen && <button type="button" className="step-link" onClick={onOpen}>Open in a tab<Icon name="ext" size={12} /></button>}
      </p>
    </>
  )
}

/** The call as a person would have typed it: the pattern, the path, the prompt. Anything else is the request as JSON. */
function requestText(item: Tool): string | undefined {
  const i = item.input
  if (!i || !Object.keys(i).length) return undefined
  const rows = (...r: (string | undefined)[]) => r.filter((x): x is string => x !== undefined).join('\n')
  switch (item.name) {
    case 'Read': return rows(text(i.file_path), typeof i.offset === 'number' ? `offset: ${i.offset}` : undefined, typeof i.limit === 'number' ? `limit: ${i.limit}` : undefined)
    case 'Grep': case 'Glob': return rows(`pattern: ${text(i.pattern) ?? ''}`, text(i.path) && `path: ${text(i.path)}`)
    case 'Agent': case 'Task': return text(i.prompt)
    default: return JSON.stringify(i, null, 2)
  }
}

/** What an opened step shows, by what it is. Null for a step with nothing to open. */
function bodyOf(item: Tool, view: ToolView): ReactNode {
  // A step you denied or that was cut off has nothing to show: it never ran.
  if (view.state === 'denied' || view.state === 'stopped') return null
  const output = cleanOutput(item)
  const failed = view.state === 'failed'
  const i = item.input ?? {}
  const patch = patchOf(item)
  if (patch) {
    return patch.map((f, n) => (
      <div key={n} className="step-patch">
        <p className="step-file"><span className="mono">{f.path}</span><Counts added={f.added} removed={f.removed} /></p>
        <DiffBox rows={f.rows} />
      </div>
    ))
  }
  const pairs = pairsOf(item)
  if (pairs.length) return <DiffBox rows={editRows(pairs)} />
  if (item.name === 'Write' && typeof i.content === 'string') return <WriteBox content={i.content} />
  if (item.name === 'Bash') {
    const command = text(i.command)
    const full = command && (command.includes('\n') || command.length > 90) ? `$ ${maskSecrets(command)}` : undefined
    const exit = item.status === 'running' ? undefined : exitLine(item, output)
    if (!exit && !full && !output) return null
    return (
      <>
        {exit && <p className="step-status">{exit.line}</p>}
        {full && <OutputBox output={full} />}
        {(exit ? exit.output : output) && <OutputBox output={exit ? exit.output : output} failed={failed} />}
      </>
    )
  }
  if (view.service) return item.input && Object.keys(item.input).length || output ? <McpBody item={item} /> : null
  const request = requestText(item)
  if (!request && !output) return null
  return (
    <>
      {request && <OutputBox output={maskSecrets(request)} from="start" />}
      {output && <OutputBox output={output} failed={failed} from="start" />}
    </>
  )
}

// ---- the tool row ----

/** The agent a workspace belongs to, by name, for a message_agent row. */
const agentNamed = (workspaceId: unknown) => (s: ReturnType<typeof getState>) => {
  const ws = typeof workspaceId === 'string' ? s.workspaces.find((w) => w.id === workspaceId) : undefined
  return ws && s.agents[ws.projectId]?.find((a) => a.id === ws.agentId)?.name
}

/** How a step reads: its verb in the tense of how it went, and what it touched. A failed step reads as it would done, in red. A cut-off one says what it was doing, and a denied one says Denied. */
function useToolLook(item: Tool) {
  const workspaceId = useContext(TranscriptWorkspace)
  const root = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.path)
  const target = useStore(agentNamed(item.name.endsWith('__message_agent') ? item.input?.workspace_id : undefined))
  return useMemo(() => {
    const ctx: ToolCtx = { root, agentOf: target ? () => target : undefined }
    const view = toolView(item, ctx)
    const as = (status: Tool['status']) => toolView({ ...item, status }, ctx)
    const title = view.state === 'failed' ? as('done').verb : view.state === 'stopped' ? as('running').verb : view.state === 'denied' ? 'Denied' : view.verb
    // A denied step says what was refused where its verb would have been, and a question still open says it was asked.
    const done = view.state === 'denied' || item.name === 'AskUserQuestion' ? as('done') : view
    return { view, title, done }
  }, [item, root, target])
}

/** The icon of a step: what kind of call it is. A teammate a call names draws its avatar. */
function iconOf(item: Tool, view: ToolView, image: boolean, patch: boolean): IconName {
  if (view.state === 'denied') return 'ban'
  if (image) return 'image'
  if (patch) return 'filePen'
  if (view.service) return view.service === 'linear' && /comment/.test(item.name) ? 'chat' : 'plug'
  switch (item.name) {
    case 'Read': return 'doc'
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'pen'
    case 'Write': return 'filePlus'
    case 'Grep': case 'Glob': return 'search'
    case 'WebFetch': case 'WebSearch': return 'link'
    case 'Skill': return 'sparkle'
    case 'AskUserQuestion': return 'question'
    default: return 'term'
  }
}

/** What follows a step's verb: the thing it touched, in the face a path or command takes, and the service it went to. */
function detailOf(view: ToolView, done: ToolView, patch: PatchFile[] | null): ReactNode {
  if (patch && (patch.length > 1 || !view.object)) return <span className="step-det">{patch.length} {patch.length === 1 ? 'file' : 'files'}</span>
  const source = view.state === 'denied' ? done : view
  const object = source.object ? (source.dir ? `${source.dir}/${source.object}` : source.object) : view.state === 'denied' ? done.verb : undefined
  const at = source.service && source.service !== 'kernel' && source.service !== 'mcp' ? `in ${SERVICE_NAME[source.service]}` : undefined
  if (!object && !at) return null
  const mono = source.mono || !!source.file
  return (
    <span className="step-det" data-mono={mono || undefined}>
      {object && <span className="step-obj ellipsis">{object}</span>}
      {at && <span className="step-svc">{at}</span>}
    </span>
  )
}

export const ToolRow = memo(function ToolRow({ item, changes }: { item: Tool; changes: ChangedFile[] }) {
  const { view, title, done } = useToolLook(item)
  const workspaceId = useContext(TranscriptWorkspace)
  const root = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.path)
  const openImage = useContext(OpenImage)
  const image = readImage(item)
  const [loaded, setLoaded] = useState<ImagePart | null>(null)
  const [gone, setGone] = useState(false)
  const pending = useRef<Promise<ImagePart | null> | null>(null)
  const rel = image ? workspaceRelative(image, root) : null
  const load = useMemo(() => (): Promise<ImagePart | null> => {
    if (!image) return Promise.resolve(null)
    if (loaded) return Promise.resolve(loaded)
    if (!workspaceId || rel === null) { setGone(true); return Promise.resolve(null) }
    const name = image.split(/[\\/]/).pop() ?? image
    pending.current ??= call('workspaces.readImage', { workspaceId, path: rel, at: 'worktree' })
      .then((r): ImagePart | null => (r ? { type: 'image', name, path: rel, dataUrl: r.dataUrl } : null))
      .catch(() => null)
      .then((part) => { if (part) setLoaded(part); else { pending.current = null; setGone(true) } return part })
    return pending.current
  }, [image, loaded, rel, workspaceId])
  if (view.hidden) return null
  const patch = patchOf(item)
  const applied = !!patch && (patch.length > 1 || !view.object)
  const name = image ? image.split(/[\\/]/).pop() ?? image : ''
  const mark = view.agent ? <AgentAvatar name={view.agent} size={13} /> : undefined
  const counts = countsOf(item, changes)
  const body = image
    ? <ImageBody image={name} file={name} load={load} loaded={loaded} failed={gone} onOpen={openImage && loaded ? () => openImage(loaded) : undefined} />
    : bodyOf(item, view)
  // A question the agent asked is waiting on you, not working: its row reads as done, and the fold's hourglass says what it waits on.
  const asked = item.name === 'AskUserQuestion' && view.state === 'running'
  const state = asked ? 'done' : view.state
  return (
    <StepRow
      icon={iconOf(item, view, !!image, applied)} glyph={mark} state={state} title={applied ? 'Applied a patch' : asked ? done.verb : title}
      detail={image ? <span className="step-det" data-mono><span className="step-obj ellipsis">{image}</span></span> : detailOf(view, done, patch)}
      counts={counts} name={view.sentence} menu={<StepMenu id={item.id} item={item} />}
      onPeek={image && openImage ? () => void load() : undefined} peek={image && loaded ? <img src={loaded.dataUrl} alt="" /> : undefined}
    >
      {body}
    </StepRow>
  )
})

/** The agent thinking, as a line in its own right: a bulb, then what it thought in italics. A long thought shows its first lines, and the line opens it. */
export const ThoughtLine = memo(function ThoughtLine({ item }: { item: Extract<ChatItem, { kind: 'thinking' }> }) {
  const [open, setOpen] = useState(false)
  const long = item.text.length > 220 || item.text.split('\n').length > 3
  const body = <span className="think-text" data-clamped={long && !open ? '' : undefined}>{item.text.trim()}</span>
  return (
    <div className="think">
      <span className="step-ic"><Icon name="bulb" size={13} /></span>
      {long ? <button type="button" className="think-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{body}</button> : body}
    </div>
  )
})

/** An in-between message: what the agent said between two steps, in the fold, under the steps' icons. */
const SaidLine = memo(function SaidLine({ item }: { item: Extract<ChatItem, { kind: 'text' }> }) {
  return <div className="said selectable"><Markdown text={item.text} /></div>
})

/** One row of the fold's list. The newest step of a running turn that is a message streams in full, so it reads as the reply will once the turn ends. */
const GroupItem = memo(function GroupItem({ item, changes }: { item: ChatItem; changes: ChangedFile[] }) {
  if (item.kind === 'tool') return toolView(item).hidden ? null : <ToolRow item={item} changes={changes} />
  if (item.kind === 'thinking') return <ThoughtLine item={item} />
  if (item.kind === 'text') return <SaidLine item={item} />
  return null
})

const GroupEntry = memo(function GroupEntry({ entry, changes }: { entry: Entry; changes: ChangedFile[] }) {
  if (entry.kind === 'run') return <>{entry.run.items.map((i) => <GroupItem key={i.id} item={i} changes={changes} />)}</>
  return <GroupItem item={entry.item} changes={changes} />
}, (a, b) => (a.entry === b.entry || (a.entry.kind === 'item' && b.entry.kind === 'item' && a.entry.item === b.entry.item)) && a.changes === b.changes)

/** Whether the reader has text selected inside `el`. */
const selectingIn = (el: HTMLElement | null) => {
  const sel = getSelection()
  return !!el && !!sel && !sel.isCollapsed && !!sel.anchorNode && el.contains(sel.anchorNode)
}

const reduced = () => document.documentElement.dataset.reduceMotion === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A stretch of steps under one header (KERNEL-1094). While its turn works the header says Working with the loader and the clock, or Waiting on your answer
 * or approval with the amber hourglass; once the turn ends it says Worked for. A fold of one call is that call's row. By default it is open while its turn
 * runs and folds when the turn ends; a fold the reader opened or closed keeps that, and Settings, Appearance, Tool calls picks the other two ways.
 * A fold waits to close until the reader is at the end and holds no selection in it. Closed while it runs, it still shows the step in flight, and one a turn ended on shows its last step.
 */
export function ToolGroup({ block, changes }: { block: Group; changes: ChangedFile[] }) {
  const chatId = useContext(TranscriptChat)
  const mode = useStore((s) => s.ui.workspace.toolCalls ?? 'auto')
  const away = useContext(TranscriptAway)
  const clock = useContext(TurnClock)
  const { turn } = block
  const want = wantOpen(mode, turn.live)
  const [manual, setManual, touched] = useRowOpen(chatId, block.id, want)
  const [shown, setShown] = useState(want)
  const box = useRef<HTMLDivElement>(null)
  const pending = shown && !want && !touched
  useEffect(() => {
    const run = () => setShown((cur) => settle({ shown: cur, want, touched, mode, away, selecting: selectingIn(box.current) }))
    run()
    if (!pending) return
    document.addEventListener('selectionchange', run)
    return () => document.removeEventListener('selectionchange', run)
  }, [want, touched, mode, away, pending])
  const open = touched ? manual : shown
  // The list leaves the page after its fold-up has played. A short turn, and reduced motion, skip it.
  const animates = !turn.short && !(typeof matchMedia === 'function' && reduced())
  const [mounted, setMounted] = useState(open)
  useLayoutEffect(() => {
    if (open || !mounted) { setMounted(open); return }
    if (!animates) { setMounted(false); return }
    const t = setTimeout(() => setMounted(false), 200)
    return () => clearTimeout(t)
  }, [open, animates]) // eslint-disable-line react-hooks/exhaustive-deps
  // The fold moves only while `open` changes on screen. Left on, a later render (a new step) or the end of a chat's opening would start the open motion
  // again, and a reader at the end would watch the chat slide down.
  const [moving, setMoving] = useState(false)
  const was = useRef(open)
  useLayoutEffect(() => {
    if (was.current === open || !animates) { was.current = open; setMoving(false); return }
    was.current = open
    setMoving(true)
    const t = setTimeout(() => setMoving(false), 200)
    return () => clearTimeout(t)
  }, [open, animates])
  const [all, setAll] = useRowOpen(chatId, `${block.id}:earlier`, false)
  const { shown: rows, earlier } = windowEntries(block.entries, turn.live, all)
  const id = `${block.id}-list`
  const state = block.current ? (clock.waiting ? 'waiting' : 'working') : 'worked'
  // The first fold of a turn has the turn's time. A fold after a card or a note has its own steps' time.
  const ms = turn.timer && turn.durationMs !== undefined ? turn.durationMs : foldSpan(block.items)
  // Closed while it works, the fold still shows the step in flight, so a quiet header never hides what is happening. A fold a turn ended on keeps its last step in view.
  const last = block.entries[block.entries.length - 1]
  const lastTool = last?.kind === 'item' && last.item.kind === 'tool' && !toolView(last.item).hidden ? last : undefined
  const flight = !open && lastTool && (state !== 'worked' ? lastTool.item.kind === 'tool' && lastTool.item.status === 'running' : block.ends) ? lastTool : undefined
  return (
    <div className="fold" ref={box}>
      <FoldHead state={state} since={turn.startedAt ?? clock.since} after={clock.waiting?.after} what={clock.waiting?.what} ms={ms} open={open} controls={id} onToggle={() => setManual(!open)} />
      {mounted && (
        <div className="group-collapse" data-open={open} data-animate={moving ? '' : undefined}>
          <div id={id} className="group-list steps">
            {earlier > 0 && <button type="button" className="group-earlier" aria-expanded={false} onClick={() => setAll(true)}>{earlier} earlier {earlier === 1 ? 'step' : 'steps'}</button>}
            {rows.map((e) => <GroupEntry key={e.kind === 'run' ? e.run.id : e.item.id} entry={e} changes={changes} />)}
          </div>
        </div>
      )}
      {flight && <div className="steps"><GroupEntry entry={flight} changes={changes} /></div>}
    </div>
  )
}
