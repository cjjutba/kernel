import { createContext, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import type { ChatPart, GithubIssueDetail, LinearIssueDetail, Project, ProjectTracker } from '@shared/types'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { ServiceMark } from '../../../icons'
import { issueFromPart, issueOpen, issueUrl, type IssueTarget } from '../issueKey'
import { detailKey, peekDetail, setDetail } from '../../issues/cache'
import { FileIcon } from '../../../components/FileIcon'
import { AgentAvatar, Icon, Modal, Spinner, type IconName } from '../../../ui'

/** The size of a file as a person reads it: 812 KB, 2.9 MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / 1024 / 1024
  return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** An attached file: it came from disk (`src`) or was copied to the workspace with a size. Pasted text, folders and @ files are not. */
const isAttachment = (p: ChatPart) => p.type === 'file' && !p.dir && (!!p.src || (p.size !== undefined && !p.lines))

const GONE = 'Gone from disk'
const NAME_MAX = 20

/** A long name cut in the middle, so the extension and the end of the name stay: Client-contr…2026.pdf. */
export function middleCut(name: string, max = NAME_MAX): string {
  if (name.length <= max) return name
  const ext = /\.[a-z0-9]{1,5}$/i.exec(name)?.[0] ?? ''
  const tail = name.slice(-(ext.length + 4))
  return `${name.slice(0, max - 1 - tail.length)}…${tail}`
}

/** A path as a person reads it: the home folder is a tilde. */
export const tildePath = (path: string) => path.replace(/^\/Users\/[^/]+\//, '~/')

/**
 * What an attached file's token shows and says: its name and size, and in the tooltip its path. A file that is gone from disk
 * says so in place of its size and keeps its place (a draft that came back after the file went).
 */
export function fileView(p: ChatPart, gone?: boolean): { label: string; size: string; tip: string; state?: 'gone' } | undefined {
  if (p.type !== 'file' || !isAttachment(p)) return undefined
  return { label: middleCut(p.name), size: gone ? GONE : p.size !== undefined ? fileSize(p.size) : '', tip: tildePath(p.src ?? p.path ?? p.name), state: gone ? 'gone' : undefined }
}

/** Pasted text: a `file` part with its text and no path. A file with a path (an @ file, a picked file or a hunk) is not one. */
export type TextPart = Extract<ChatPart, { type: 'file' }> & { text: string }
export const isPastedText = (p: ChatPart): p is TextPart => p.type === 'file' && !p.path && !!p.text

/** An @ file from the repo: it sits in the text as a compact chip, where every other attachment is a token. */
const isRepoFile = (p: ChatPart) => p.type === 'file' && !p.dir && !!p.path && !isAttachment(p) && !isPastedText(p)

/** A skill or an @ file is a compact chip inside its line. Every other attachment is a 24px token. */
export const isToken = (p: ChatPart) => p.type !== 'text' && !['repo', 'skill'].includes(tokenKind(p))

/** What a token's icon follows, for `data-kind`: the part's type, with pasted text, folders, attachments and @ files apart. */
export const tokenKind = (p: ChatPart): string => (p.type === 'file' ? (isPastedText(p) ? 'paste' : p.dir ? 'folder' : isRepoFile(p) ? 'repo' : 'file') : p.type)

/**
 * A token's inside: the icon, then the name and its meta (DESIGN.md, Attaching files). An image is its mini thumbnail, an attached file or folder its Material icon,
 * pasted text a document glyph, an issue or a pull request its mark with the key in mono and the title, a workspace its branch, an agent its avatar.
 * `pending` is a file still being read, which shows the loader in the icon's place and "Attaching" for its meta. `gone` is a file that left the disk.
 */
export function TokenBody({ part, gone, pending }: { part: ChatPart; gone?: boolean; pending?: boolean }) {
  if (part.type === 'text') return null
  if (part.type === 'image') {
    const meta = gone ? GONE : pending ? 'Attaching' : part.width && part.height ? `${part.width}×${part.height}` : ''
    return (
      <>
        <span className="tok-mini" data-gone={gone || undefined} aria-hidden="true">
          {pending ? <Spinner label={null} pattern="arrow-down" /> : gone ? <Icon name="fileX" size={13} /> : part.dataUrl ? <img src={part.dataUrl} alt="" /> : <FileIcon path={part.name} size={14} />}
        </span>
        <span className="chip-name ellipsis">{part.name}</span>
        {meta && <span className="chip-meta">{meta}</span>}
      </>
    )
  }
  if (part.type === 'issue' || part.type === 'pr') {
    return <>{part.type === 'issue' ? <ServiceMark name={part.source} size={12} /> : <Icon name="pr" size={12} />}<span className="chip-key">{part.name}</span><span className="chip-name ellipsis">{part.title}</span></>
  }
  if (part.type === 'skill') return <><span aria-hidden="true" className="muted">/</span><span className="chip-name">{part.name}</span></>
  if (part.type === 'agent') return <><AgentAvatar name={part.name} size={14} /><span className="chip-name">{part.name}</span></>
  if (part.type === 'workspace') return <><Icon name="branch" size={12} /><span className="chip-name ellipsis">{part.name}</span></>
  if (isPastedText(part)) return <><Icon name="doc" size={13} /><span className="chip-name">Pasted text</span>{part.lines ? <span className="chip-meta">{part.lines} lines</span> : null}</>
  if (isRepoFile(part)) return <><FileIcon path={part.path ?? part.name} size={14} /><span className="chip-name">{part.name.split('/').pop()}</span></>
  if (part.type === 'file' && part.dir) return <><FileIcon path={part.path ?? part.name} dir size={16} /><span className="chip-name ellipsis">{part.name}</span></>
  const view = fileView(part, gone)
  if (part.type === 'file') return <><FileIcon path={part.name} size={16} /><span className="chip-name ellipsis">{view?.label ?? part.name}</span>{view?.size ? <span className="chip-meta">{view.size}</span> : null}</>
  return null
}

/** A pull request chip's state for its icon color: merged or closed when a workspace of ours holds that PR, else open. */
export function usePrState(p: ChatPart): 'merged' | 'closed' | undefined {
  const state = useStore((s) => (p.type === 'pr' ? s.workspaces.find((w) => w.prNumber === p.number)?.prState : undefined))
  return state === 'merged' || state === 'closed' ? state : undefined
}

export type ImagePart = Extract<ChatPart, { type: 'image' }> & { dataUrl: string }

/** What clicking an image chip does. The workspace opens the image in a tab; without one it opens in a modal. */
export const OpenImage = createContext<((image: ImagePart) => void) | null>(null)

const PREVIEW_W = 480
const PREVIEW_H = 320
const GAP = 8

/** Above the chip, or below it when there is no space above, kept inside the window. */
function previewPlace(r: DOMRect): React.CSSProperties {
  const left = Math.max(GAP, Math.min(r.left, window.innerWidth - PREVIEW_W - GAP))
  return r.top > PREVIEW_H + GAP * 2 ? { left, bottom: window.innerHeight - r.top + GAP } : { left, top: r.bottom + GAP }
}

/** A hover preview drawn over the page at a chip's place, in the shared `peek-frame` with the kind's class for size and content. Its owner decides when it shows and hides it on scroll. */
export function HoverPreview({ at, className, children }: { at: DOMRect; className: string; children: React.ReactNode }) {
  return createPortal(<div className={`peek-frame ${className}`} style={previewPlace(at)} aria-hidden="true">{children}</div>, document.body)
}

/** What clicking a pasted text chip does. The workspace opens the text in a tab; without one it opens in a modal. */
export const OpenText = createContext<((text: TextPart) => void) | null>(null)

/** How much of a paste the hover preview draws. The box clips the rest. */
const PREVIEW_LINES = 16
const PREVIEW_CHARS = 1200
const head = (text: string) => text.slice(0, PREVIEW_CHARS).split('\n').slice(0, PREVIEW_LINES).join('\n')

/**
 * A token's name and icon as a button: hovering or focusing it shows a preview, clicking opens it. An image's token shows its picture at 16px (KERNEL-1095).
 */
function PreviewButton({ name, preview, previewClass, modal, modalWidth, onOpen, plain, children, ...rest }: {
  name: string; preview: React.ReactNode; previewClass: string; modal?: React.ReactNode; modalWidth?: number; onOpen: ((e: React.MouseEvent) => void) | null
  /** Nothing to open: a focusable span that still previews, not a button. */
  plain?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<DOMRect | null>(null)
  const [big, setBig] = useState(false)
  const show = () => setAt(ref.current?.getBoundingClientRect() ?? null)
  const hide = () => setAt(null)
  // The preview is placed once, so a scroll under it hides it rather than leave it behind.
  useEffect(() => {
    if (!at) return
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [at])
  // Focus shows it from the keyboard only, so a click or a closing modal doesn't bring it back.
  const shared = {
    ref, onMouseEnter: show, onMouseLeave: hide, onBlur: hide,
    onFocus: (e: React.FocusEvent<HTMLElement>) => { if (e.currentTarget.matches(':focus-visible')) show() },
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Escape' && at) { e.stopPropagation(); hide() } }
  }
  return (
    <>
      {plain
        ? <span role="group" tabIndex={0} aria-label={name} {...(rest as React.HTMLAttributes<HTMLSpanElement>)} {...shared} ref={ref as React.RefObject<HTMLSpanElement>}>{children}</span>
        : (
          <button
            type="button" aria-label={`Open ${name}`} {...rest} {...shared}
            onClick={(e) => { hide(); if (onOpen) onOpen(e); else if (modal) setBig(true) }}
          >
            {children}
          </button>
        )}
      {at && <HoverPreview at={at} className={previewClass}>{preview}</HoverPreview>}
      {big && modal && createPortal(<Modal title={name} width={modalWidth ?? 720} onClose={() => setBig(false)}>{modal}</Modal>, document.body)}
    </>
  )
}

/** An image chip as a preview button: hovering shows the image, clicking opens it in a tab or a modal. */
export function ImageButton({ image, children, ...rest }: { image: ImagePart } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const open = useContext(OpenImage)
  return (
    <PreviewButton
      name={image.name} previewClass="img-preview" preview={<><img src={image.dataUrl} alt="" /><div className="img-preview-meta"><span className="mono">{image.name}</span><span>{[image.width && image.height ? `${image.width}×${image.height}` : '', fileSize(Math.round(image.dataUrl.length * 0.75))].filter(Boolean).join(' · ')}</span></div></>}
      modalWidth={960} modal={<div className="img-modal"><img src={image.dataUrl} alt={image.name} /></div>}
      onOpen={open && (() => open(image))} {...rest}
    >
      {children}
    </PreviewButton>
  )
}

/** A pasted text chip as a preview button: hovering shows the first lines, clicking opens all of it in a tab or a modal. */
export function TextButton({ paste, children, ...rest }: { paste: TextPart } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const open = useContext(OpenText)
  return (
    <PreviewButton
      name={paste.name} previewClass="txt-preview" preview={<><pre>{head(paste.text)}</pre>{paste.lines ? <p className="txt-preview-n">{paste.lines} lines</p> : null}</>}
      modalWidth={720} modal={<pre className="txt-modal selectable mono" tabIndex={0}>{paste.text}</pre>}
      onOpen={open && (() => open(paste))} {...rest}
    >
      {children}
    </PreviewButton>
  )
}

export type IssuePart = Extract<ChatPart, { type: 'issue' }>

/** The project a chat belongs to and what its tracker answered, so an issue chip knows whether Issues can show its issue (KERNEL-898). */
export const OpenIssue = createContext<{ project?: Pick<Project, 'id' | 'kind' | 'repo'>; tracker?: ProjectTracker }>({})

/** Does what an issue's click rules picked: opens Issues on it or the browser on its page, and ⌘ always the browser when there is a page. */
export function followIssue(target: IssueTarget, url: string | undefined, e: { metaKey: boolean }, issueId: string) {
  if (e.metaKey && url) void call('system.openExternal', { url })
  else if (target.kind === 'issues') actions.ui.go({ name: 'issues', issueId, projectId: target.projectId })
  else if (target.kind === 'url') void call('system.openExternal', { url: target.url })
}

/** What an issue's preview shows beyond its key and title, read when the preview opens: the state, the first words of the description, who has it and its labels. */
interface IssueFacts { state?: string; text: string; who?: string; labels: string[] }

/** A markdown description as plain words for a two line preview. */
const plainWords = (md: string) => md.replace(/```[\s\S]*?```/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`~-]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Reads the issue's detail from the tracker, once per preview, and keeps what the Issues screen already read. A read that fails leaves the preview with its key and title. */
function useIssueFacts(issue: IssuePart, projectId?: string): IssueFacts | undefined {
  const key = detailKey(issue.source, projectId ?? '', issue.name)
  const read = (v: unknown): IssueFacts => {
    if (issue.source === 'linear') { const d = v as LinearIssueDetail; return { state: d.state.name, text: plainWords(d.description), who: d.assignee?.name, labels: d.labels } }
    const d = v as GithubIssueDetail
    return { text: plainWords(d.body), who: d.assignees[0] ?? d.author, labels: d.labels }
  }
  const [facts, setFacts] = useState<IssueFacts | undefined>(() => { const hit = peekDetail<unknown>(key); return hit ? read(hit.value) : undefined })
  useEffect(() => {
    if (facts || (issue.source === 'github' && !projectId)) return
    let live = true
    const call_ = issue.source === 'linear' ? call('linear.issue', { id: issue.name }) : call('github.issue', { projectId: projectId!, id: issue.name })
    void call_.then((d) => { setDetail(key, d); if (live) setFacts(read(d)) }).catch(() => undefined)
    return () => { live = false }
  }, [])
  return facts
}

/** The card an issue token shows on hover: the tracker's mark and key, its state, the title, the words under it and who has it. */
function IssuePeek({ issue, hint, projectId }: { issue: IssuePart; hint: string; projectId?: string }) {
  const facts = useIssueFacts(issue, projectId)
  return (
    <>
      <div className="issue-preview-head"><ServiceMark name={issue.source} size={12} /><span className="issue-preview-key">{issue.name}</span>{facts?.state && <span className="issue-preview-state">{facts.state}</span>}</div>
      <p className="issue-preview-title">{issue.title}</p>
      {facts?.text && <p className="issue-preview-body">{facts.text}</p>}
      {(facts?.who || facts?.labels.length) ? <div className="issue-preview-meta">{facts.who && <><AgentAvatar name={facts.who} size={14} /><span>{facts.who}</span></>}{facts.labels.length > 0 && <span className="issue-preview-labels">{facts.labels.join(', ')}</span>}</div> : null}
      {hint && !facts && <p className="issue-preview-hint">{hint}</p>}
    </>
  )
}

/** An issue chip as a preview button: hovering shows the issue, clicking opens it in Issues or the browser. With nowhere to open it is a span that still previews. */
export function IssueButton({ issue, children, ...rest }: { issue: IssuePart } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { project, tracker } = useContext(OpenIssue)
  const ref = issueFromPart(issue)
  const target = issueOpen(ref, project, tracker)
  const hint = target.kind === 'issues' ? 'Click to open in Issues' : target.kind === 'url' ? 'Click to open in your browser' : ''
  return (
    <PreviewButton
      name={issue.name} aria-label={`${target.kind === 'none' ? 'Issue' : 'Open issue'} ${issue.name}, ${issue.title}`} previewClass="issue-preview" plain={target.kind === 'none'}
      preview={<IssuePeek issue={issue} hint={hint} projectId={project?.id} />}
      onOpen={target.kind === 'none' ? null : (e) => followIssue(target, issueUrl(ref, project), e, issue.name)} {...rest}
    >
      {children}
    </PreviewButton>
  )
}

/** What a token's styles read: its kind, a pull request's state, and whether its file is gone or still being read. */
export function tokenAttrs(part: ChatPart, o: { gone?: boolean; pending?: boolean; prState?: 'merged' | 'closed' } = {}) {
  return { 'data-kind': tokenKind(part), 'data-pr-state': o.prState, 'data-state': o.gone ? 'gone' : o.pending ? 'pending' : undefined }
}

/** A token's button, when it has something to open: an image its picture, pasted text its words, an issue its page. The rest is the body alone. */
function TokenOpen({ part, className, children }: { part: ChatPart; className: string; children: React.ReactNode }) {
  if (part.type === 'image' && part.dataUrl) return <ImageButton image={{ ...part, dataUrl: part.dataUrl }} className={className}>{children}</ImageButton>
  if (isPastedText(part)) return <TextButton paste={part} className={className}>{children}</TextButton>
  if (part.type === 'issue') return <IssueButton issue={part} className={className}>{children}</IssueButton>
  return <>{children}</>
}

/**
 * One attachment in a composer, a token in the text where the caret was: pasted text, an image, a file or folder, a skill, or a linked issue, pull request or workspace.
 * Every composer draws them the same way, 24px tall with the icon of its kind. Images also show as thumbnails above the text (`Thumbs`).
 */
export function ComposerChip({ part, entering, gone, pending, onRemove }: { part: ChatPart; /** An attached file that no longer exists. */ gone?: boolean; /** A file still being read. */ pending?: boolean; /** A chip that just landed, which fades in. */ entering?: boolean; onRemove: () => void }) {
  const prState = usePrState(part)
  if (part.type === 'text') return null
  const label = part.type === 'skill' ? `/${part.name}` : part.name
  const view = fileView(part, gone)
  return (
    <span className="chip cmp-chip" data-tip={view?.tip} data-tip-side="above" data-tip-mono={view ? '' : undefined} data-entering={entering || undefined} {...tokenAttrs(part, { gone, pending, prState })}>
      <TokenOpen part={part} className="chip-open"><TokenBody part={part} gone={gone} pending={pending} /></TokenOpen>
      <button type="button" className="chip-x" aria-label={`Remove ${label}`} onClick={onRemove}><Icon name="close" size={12} /></button>
    </span>
  )
}

/**
 * The thumbnails across the top of a composer: one 64px square for each image in the message, with a button that takes it out. An image still being read is a dark
 * square with the loader, and one that left the disk a quiet square with its glyph. Clicking one opens it, and hovering shows it larger. The tokens in the text are the same images.
 */
export function Thumbs({ images, onRemove }: { images: { id: string; part: Extract<ChatPart, { type: 'image' }>; pending?: boolean; gone?: boolean }[]; onRemove: (id: string) => void }) {
  if (!images.length) return null
  return (
    <div className="cmp-thumbs" role="list" aria-label="Attached images">
      {images.map(({ id, part, pending, gone }) => (
        <div key={id} className="cmp-thumb" role="listitem" data-state={gone ? 'gone' : pending ? 'pending' : undefined}>
          {part.dataUrl && !gone
            ? <ImageButton image={{ ...part, dataUrl: part.dataUrl }} className="cmp-thumb-open"><img src={part.dataUrl} alt="" /></ImageButton>
            : <span className="cmp-thumb-open" aria-hidden="true">{pending ? <Spinner label={null} pattern="arrow-down" /> : <Icon name="imageOff" size={20} />}</span>}
          <button type="button" className="cmp-thumb-x" aria-label={`Remove ${part.name}`} onClick={() => onRemove(id)}><Icon name="close" size={12} /></button>
        </div>
      ))}
    </div>
  )
}
