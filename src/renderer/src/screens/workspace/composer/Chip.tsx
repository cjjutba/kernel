import { createContext, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import type { ChatPart } from '@shared/types'
import { Icon, Modal, type IconName } from '../../../ui'

/** A short label under a chip: lines of a pasted text, the size of an image, or a linked issue's title. */
function chipMeta(p: ChatPart): string {
  if (p.type === 'file' && p.lines && !p.path) return `${p.lines} lines`
  if (p.type === 'image' && p.width && p.height) return `${p.width}×${p.height}`
  if (p.type === 'issue') return p.title
  return ''
}

/** The icon for a chip's kind: an image, a linked issue or workspace, else a file. */
export const chipIcon = (p: ChatPart): IconName => (p.type === 'image' ? 'image' : p.type === 'issue' ? 'link' : p.type === 'workspace' ? 'branch' : 'doc')

export type ImagePart = Extract<ChatPart, { type: 'image' }> & { dataUrl: string }

/** What clicking an image chip does. The workspace opens the image in a tab; without one it opens in a modal. */
export const OpenImage = createContext<((image: ImagePart) => void) | null>(null)

const PREVIEW_W = 480
const PREVIEW_H = 320
const GAP = 8

/** Above the chip, or below it when there is no room above, kept inside the window. */
function previewPlace(r: DOMRect): React.CSSProperties {
  const left = Math.max(GAP, Math.min(r.left, window.innerWidth - PREVIEW_W - GAP))
  return r.top > PREVIEW_H + GAP * 2 ? { left, bottom: window.innerHeight - r.top + GAP } : { left, top: r.bottom + GAP }
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
 * A chip's name and icon as a button, as in Conductor: hovering or focusing it shows a preview, clicking opens it.
 * The chip itself still shows an icon, never a thumbnail (D-062).
 */
function PreviewButton({ name, preview, previewClass, modal, modalWidth, onOpen, children, ...rest }: {
  name: string; preview: React.ReactNode; previewClass: string; modal: React.ReactNode; modalWidth: number; onOpen: (() => void) | null
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
  return (
    <>
      <button
        ref={ref} type="button" aria-label={`Open ${name}`} {...rest}
        // Focus shows it from the keyboard only, so a click or a closing modal doesn't bring it back.
        onMouseEnter={show} onMouseLeave={hide} onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) show() }} onBlur={hide}
        onKeyDown={(e) => { if (e.key === 'Escape' && at) { e.stopPropagation(); hide() } }}
        onClick={() => { hide(); if (onOpen) onOpen(); else setBig(true) }}
      >
        {children}
      </button>
      {at && createPortal(<div className={previewClass} style={previewPlace(at)}>{preview}</div>, document.body)}
      {big && createPortal(<Modal title={name} width={modalWidth} onClose={() => setBig(false)}>{modal}</Modal>, document.body)}
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

/** One attachment in a composer: pasted text, an image, a file, a skill, or a linked issue or workspace. Every composer draws them the same way, with an icon for the kind. */
export function ComposerChip({ part, onRemove }: { part: ChatPart; onRemove: () => void }) {
  if (part.type === 'text') return null
  const label = part.type === 'skill' ? `/${part.name}` : part.name
  const meta = chipMeta(part)
  const body = (
    <>
      <Icon name={chipIcon(part)} size={12} />
      <span className="ellipsis" style={{ maxWidth: 220 }}>{label}</span>
      {meta && <span className="chip-meta ellipsis" style={{ maxWidth: 220 }}>{meta}</span>}
    </>
  )
  return (
    <span className="chip cmp-chip" data-kind={part.type === 'skill' || part.type === 'image' || part.type === 'issue' || part.type === 'workspace' ? part.type : 'file'}>
      {part.type === 'image' && part.dataUrl ? <ImageButton image={{ ...part, dataUrl: part.dataUrl }} className="chip-open">{body}</ImageButton>
        : isPastedText(part) ? <TextButton paste={part} className="chip-open">{body}</TextButton> : body}
      <button type="button" className="chip-x" aria-label={`Remove ${label}`} onClick={onRemove}><Icon name="close" size={10} /></button>
    </span>
  )
}
