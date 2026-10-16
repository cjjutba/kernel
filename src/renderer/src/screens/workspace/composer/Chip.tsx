import { createContext, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import type { ChatPart, FileKind, Project, ProjectTracker } from '@shared/types'
import { call } from '../../../api'
import { actions } from '../../../store'
import { issueFromPart, issueOpen, issueUrl, type IssueTarget } from '../issueKey'
import { FileIcon } from '../../../components/FileIcon'
import { Icon, Modal, Spinner, type IconName } from '../../../ui'

const KIND_LABELS: Record<FileKind, string> = {
  pdf: 'PDF', doc: 'Document', sheet: 'Spreadsheet', slides: 'Slides', archive: 'Archive', audio: 'Audio', video: 'Video', image: 'Image', text: 'Text', binary: 'File'
}

/** The size of a file as a person reads it: 812 KB, 2.9 MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / 1024 / 1024
  return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** An attached file's type: its short extension in capitals (PDF, ZIP), else what it was found to be, else File. */
function typeLabel(p: Extract<ChatPart, { type: 'file' }>): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(p.name)?.[1]
  return ext ? ext.toUpperCase() : p.kind ? KIND_LABELS[p.kind] : 'File'
}

/** An attached file: it came from disk (`src`) or was copied to the workspace with a size. Pasted text and @ files are not. */
const isAttachment = (p: ChatPart) => p.type === 'file' && (!!p.src || (p.size !== undefined && !p.lines))

const CANT_OPEN = "The agent can't open this file type"
const GONE = 'No longer available. The workspace was archived.'
const NAME_MAX = 20

/** A long name cut in the middle, so the extension and the end of the name stay: Client-contr…2026.pdf. */
export function middleCut(name: string, max = NAME_MAX): string {
  if (name.length <= max) return name
  const ext = /\.[a-z0-9]{1,5}$/i.exec(name)?.[0] ?? ''
  const tail = name.slice(-(ext.length + 4))
  return `${name.slice(0, max - 1 - tail.length)}…${tail}`
}

/**
 * What an attached file's chip shows and says. The chip itself carries the size, dimmed when the agent can't open the file and
 * struck through when it is gone. Everything else, the full name, the type, a PDF's pages and the status, is in the tooltip.
 */
export function fileView(p: ChatPart, gone?: boolean): { label: string; size: string; tip: string; hint: string; state?: 'unreadable' | 'gone' } | undefined {
  if (p.type !== 'file' || !isAttachment(p)) return undefined
  const state = gone ? 'gone' : p.readable === false ? 'unreadable' : undefined
  const details = [typeLabel(p), ...(p.pages ? [`${p.pages} ${p.pages === 1 ? 'page' : 'pages'}`] : []), ...(p.size !== undefined ? [fileSize(p.size)] : [])].join(' · ')
  return {
    label: middleCut(p.name), size: p.size !== undefined ? fileSize(p.size) : '', tip: p.name, state,
    hint: state ? `${state === 'gone' ? GONE : CANT_OPEN}\n${details}` : details
  }
}

/** A short label after a chip's name: lines of a pasted text, the type and size of an attached file, the size of an image, or a linked issue's or pull request's title. */
function chipMeta(p: ChatPart): string {
  if (p.type === 'file' && isAttachment(p)) return [typeLabel(p), ...(p.pages ? [`${p.pages} ${p.pages === 1 ? 'page' : 'pages'}`] : []), ...(p.size !== undefined ? [fileSize(p.size)] : [])].join(' · ')
  if (p.type === 'file' && p.lines && !p.path) return `${p.lines} lines`
  if (p.type === 'image' && p.width && p.height) return `${p.width}×${p.height}`
  if (p.type === 'issue' || p.type === 'pr') return p.title
  return ''
}

/** The icon for a chip's kind: an image, a linked issue or workspace, else a file. */
export const chipIcon = (p: ChatPart): IconName => (p.type === 'image' ? 'image' : p.type === 'issue' ? 'link' : p.type === 'pr' ? 'pr' : p.type === 'workspace' ? 'branch' : p.type === 'agent' ? 'user' : 'doc')

/** A chip's icon. A file from the repo (an @ file, a picked file or a hunk) shows its VS Code icon, the rest the glyph for their kind (KERNEL-399). */
export function ChipIcon({ part }: { part: ChatPart }) {
  if (part.type === 'file' && isAttachment(part)) return <Icon name={part.readable === false ? 'eyeoff' : 'doc'} size={12} />
  return part.type === 'file' && (part.path || part.src) ? <FileIcon path={part.path ?? part.name} dir={part.dir} size={14} /> : <Icon name={chipIcon(part)} size={12} />
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

/** Pasted text: a `file` part with its text and no path. A file with a path (an @ file, a picked file or a hunk) is not one. */
export type TextPart = Extract<ChatPart, { type: 'file' }> & { text: string }
export const isPastedText = (p: ChatPart): p is TextPart => p.type === 'file' && !p.path && !!p.text

/** What clicking a pasted text chip does. The workspace opens the text in a tab; without one it opens in a modal. */
export const OpenText = createContext<((text: TextPart) => void) | null>(null)

/** How much of a paste the hover preview draws. The box clips the rest. */
const PREVIEW_LINES = 16
const PREVIEW_CHARS = 1200
const head = (text: string) => text.slice(0, PREVIEW_CHARS).split('\n').slice(0, PREVIEW_LINES).join('\n')

/**
 * A chip's name and icon as a button: hovering or focusing it shows a preview, clicking opens it.
 * The chip itself still shows an icon, never a thumbnail (D-062).
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
      name={image.name} previewClass="img-preview" preview={<img src={image.dataUrl} alt="" />}
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
      name={paste.name} previewClass="txt-preview" preview={<pre>{head(paste.text)}</pre>}
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

/** An issue chip as a preview button: hovering shows its key and title, clicking opens it in Issues or the browser. With nowhere to open it is a span that still previews. */
export function IssueButton({ issue, children, ...rest }: { issue: IssuePart } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { project, tracker } = useContext(OpenIssue)
  const ref = issueFromPart(issue)
  const target = issueOpen(ref, project, tracker)
  const hint = target.kind === 'issues' ? 'Click to open in Issues' : target.kind === 'url' ? 'Click to open in your browser' : ''
  return (
    <PreviewButton
      name={issue.name} aria-label={`${target.kind === 'none' ? 'Issue' : 'Open issue'} ${issue.name}, ${issue.title}`} previewClass="issue-preview" plain={target.kind === 'none'}
      preview={<>
        <div className="issue-preview-head"><span className="issue-preview-key">{issue.name}</span><span>{issue.source === 'github' ? 'GitHub issue' : 'Linear issue'}</span></div>
        <p className="issue-preview-title">{issue.title}</p>
        {hint && <p className="issue-preview-hint">{hint}</p>}
      </>}
      onOpen={target.kind === 'none' ? null : (e) => followIssue(target, issueUrl(ref, project), e, issue.name)} {...rest}
    >
      {children}
    </PreviewButton>
  )
}

/** One attachment in a composer: pasted text, an image, a file, a skill, or a linked issue or workspace. Every composer draws them the same way, with an icon for the kind. */
export function ComposerChip({ part, pending, entering, gone, onRemove }: { part: ChatPart; /** An attached file that no longer exists. */ gone?: boolean; /** A file still being read: its name with the dot loader where the icon goes. */ pending?: boolean; /** A chip that just landed, which fades in. */ entering?: boolean; onRemove: () => void }) {
  if (part.type === 'text') return null
  if (pending) {
    return (
      <span className="chip cmp-chip" data-kind="pending" aria-busy="true">
        <Spinner label={`Attaching ${part.name}`} pattern="arrow-down" />
        <span className="ellipsis" style={{ maxWidth: 220 }}>{part.name}</span>
        <button type="button" className="chip-x" aria-label={`Cancel ${part.name}`} onClick={onRemove}><Icon name="close" size={12} /></button>
      </span>
    )
  }
  const label = part.type === 'skill' ? `/${part.name}` : part.name
  const view = fileView(part, gone)
  const meta = view ? view.size : chipMeta(part)
  const body = (
    <>
      <ChipIcon part={part} />
      <span className="chip-name ellipsis" style={{ maxWidth: 220 }}>{view ? view.label : label}</span>
      {meta && <span className="chip-meta ellipsis" style={{ maxWidth: 220 }}>{meta}</span>}
    </>
  )
  return (
    <span className="chip cmp-chip" data-tip={view?.tip} data-tip-hint={view?.hint} data-state={view?.state} data-entering={entering || undefined} data-kind={part.type === 'skill' || part.type === 'image' || part.type === 'issue' || part.type === 'pr' || part.type === 'workspace' || part.type === 'agent' ? part.type : 'file'}>
      {part.type === 'image' && part.dataUrl ? <ImageButton image={{ ...part, dataUrl: part.dataUrl }} className="chip-open">{body}</ImageButton>
        : isPastedText(part) ? <TextButton paste={part} className="chip-open">{body}</TextButton>
        : part.type === 'issue' ? <IssueButton issue={part} className="chip-open">{body}</IssueButton> : body}
      <button type="button" className="chip-x" aria-label={`Remove ${label}`} onClick={onRemove}><Icon name="close" size={12} /></button>
    </span>
  )
}
