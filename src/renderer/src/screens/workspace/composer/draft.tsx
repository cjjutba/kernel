import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type TextareaHTMLAttributes } from 'react'
import type { ChatPart } from '@shared/types'
import { attachFiles, clipboardImages, dropFiles, pastedText } from './attach'
import { ComposerChip } from './Chip'
import { loadDraft, saveDraft } from './draftStore'

/** What a composer holds: typed text and chips in the order they were added, then the live text box and its caret. */
export interface Draft { segs: ChatPart[]; draft: string; caret: number }

const text = (t: string): ChatPart => ({ type: 'text', text: t })

/** No two text parts in a row, and text right before the box moves into it, so Backspace keeps deleting characters. */
function tidy(d: Draft): Draft {
  const segs: ChatPart[] = []
  for (const p of d.segs) {
    const prev = segs[segs.length - 1]
    if (p.type === 'text' && prev?.type === 'text') segs[segs.length - 1] = text(prev.text + p.text)
    else segs.push(p)
  }
  const last = segs[segs.length - 1]
  if (last?.type !== 'text') return { ...d, segs }
  return { segs: segs.slice(0, -1), draft: last.text + d.draft, caret: last.text.length + d.caret }
}

/** The message to send: leading blank text dropped, trailing space trimmed. Empty when there is nothing to send. */
export function messageOf(d: Draft): ChatPart[] {
  const parts = [...d.segs, ...(d.draft ? [text(d.draft)] : [])]
  const first = parts.findIndex((p) => p.type !== 'text' || p.text.trim())
  if (first < 0) return []
  const out = parts.slice(first)
  const last = out[out.length - 1]
  if (last.type === 'text') out[out.length - 1] = text(last.text.trimEnd())
  return out
}

/** The typed words only, without the chips: what names a workspace. */
export const plainText = (d: Draft) => [...d.segs, text(d.draft)].map((p) => (p.type === 'text' ? p.text : ' ')).join('').replace(/[ \t]+/g, ' ').trim()

/**
 * A composer's draft. Every chip lands where the caret is, as in Conductor: a pasted screenshot or long text, a dropped
 * or picked file, an @ file, a / skill. `insert` and `attach` run in order, so two images pasted at once both land.
 * With a `key` (a chat id) the draft is kept per key outside the component: it comes back after a tab switch or a remount,
 * and a key change swaps in that key's own draft. Without a key nothing is kept.
 */
export function useDraft(init?: { parts?: ChatPart[]; draft?: string }, key?: string) {
  const [d, setD] = useState<Draft>(() => {
    const kept = key ? loadDraft(key) : undefined
    return kept ? { ...kept, caret: kept.draft.length } : { segs: init?.parts ?? [], draft: init?.draft ?? '', caret: init?.draft?.length ?? 0 }
  })
  const [owner, setOwner] = useState(key)
  const current = useRef(key)
  current.current = key
  if (owner !== key) {
    // The composer now shows another chat: its own draft, or an empty box.
    setOwner(key)
    const kept = key ? loadDraft(key) : undefined
    setD({ segs: kept?.segs ?? [], draft: kept?.draft ?? '', caret: kept?.draft.length ?? 0 })
  }
  useEffect(() => { if (key) saveDraft(key, d) }, [key, d])
  const input = useRef<HTMLTextAreaElement>(null)
  const caretTo = useRef<number | null>(null)
  /** A change that moves the caret, so the box takes focus with the caret where the change left it. */
  const move = (fn: (d: Draft) => Draft) => setD((cur) => { const next = fn(cur); caretTo.current = next.caret; return next })

  useEffect(() => { const el = input.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }, [d.draft])
  // A draft that comes back has its caret at the end of the box. Set after the browser has laid the box out, which resets it.
  useEffect(() => {
    if (!key) return
    const frame = requestAnimationFrame(() => input.current?.setSelectionRange(d.draft.length, d.draft.length))
    return () => cancelAnimationFrame(frame)
  }, [key])
  useLayoutEffect(() => {
    const el = input.current
    if (!el || caretTo.current === null) return
    el.focus(); el.setSelectionRange(caretTo.current, caretTo.current); caretTo.current = null
  })

  /** A chip where the caret is. `drop` is how much typed text right before the caret it replaces (the @ or / word). */
  const insert = (part: ChatPart, drop = 0) => move((c) => {
    const head = c.draft.slice(0, c.caret - drop)
    return { segs: [...c.segs, ...(head ? [text(head)] : []), part], draft: c.draft.slice(c.caret), caret: 0 }
  })
  const attach = (files: File[]) => void attachFiles(files, (p) => insert(p))
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = clipboardImages(e.clipboardData)
    const part = images.length ? null : pastedText(e.clipboardData.getData('text'))
    if (!images.length && !part) return
    e.preventDefault()
    // A paste over a selection replaces it.
    const { selectionStart: from, selectionEnd: to } = e.currentTarget
    setD((c) => ({ ...c, draft: c.draft.slice(0, from) + c.draft.slice(to), caret: from }))
    if (part) insert(part); else attach(images)
  }
  /** Backspace at the very start of the box removes the chip before it. Returns whether it did. */
  const onBackspace = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    if (e.key !== 'Backspace' || e.nativeEvent.isComposing || el.selectionStart !== 0 || el.selectionEnd !== 0 || !d.segs.length) return false
    e.preventDefault()
    move((c) => tidy({ ...c, caret: 0, segs: c.segs[c.segs.length - 1]?.type === 'text' ? c.segs : c.segs.slice(0, -1) }))
    return true
  }

  return {
    ...d, input, insert, attach, onPaste, onBackspace,
    drop: dropFiles(attach),
    empty: !messageOf(d).length,
    message: () => messageOf(d),
    plain: () => plainText(d),
    remove: (i: number) => move((c) => tidy({ ...c, segs: c.segs.filter((_, j) => j !== i) })),
    setText: (t: string) => move((c) => ({ ...c, draft: t, caret: t.length })),
    type: (t: string, caret: number) => setD((c) => ({ ...c, draft: t, caret })),
    setCaret: (caret: number) => setD((c) => (c.caret === caret ? c : { ...c, caret })),
    /**
     * Replace everything, for a failed send or a queued message brought back to edit. `forKey` is the chat the content
     * belongs to: if the composer has moved on to another chat, it goes back to that chat's stored draft instead.
     */
    reset: (next: { segs?: ChatPart[]; draft?: string } = {}, forKey?: string) => {
      if (forKey !== undefined && forKey !== current.current) {
        if (!loadDraft(forKey)) saveDraft(forKey, { segs: next.segs ?? [], draft: next.draft ?? '' })
        return
      }
      move(() => ({ segs: next.segs ?? [], draft: next.draft ?? '', caret: next.draft?.length ?? 0 }))
    },
    snapshot: () => ({ segs: d.segs, draft: d.draft })
  }
}

export type DraftState = ReturnType<typeof useDraft>

/** Earlier text, one flex item per word so it wraps like a paragraph around the chips. A newline starts a new row. */
function Words({ text }: { text: string }) {
  return text.split('\n').map((line, l) => (
    <Fragment key={l}>
      {l > 0 && <span className="cmp-break" />}
      {line.split(/(?<=\s)/).map((w, j) => <span key={j} className="cmp-text">{w}</span>)}
    </Fragment>
  ))
}

/**
 * The editable part of every composer: what was typed and attached so far, inline in order, then the live text box.
 * The placeholder shows only while nothing is there. `onKeyDown` runs first; Backspace handling runs if it didn't take the key.
 */
export function DraftInput({ d, className, placeholder, onKeyDown, onChange, ...rest }: { d: DraftState; className?: string } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onPaste' | 'onSelect' | 'className'>) {
  return (
    <div className={['cmp-input', className].filter(Boolean).join(' ')} onClick={(e) => { if (e.target === e.currentTarget) d.input.current?.focus() }}>
      {d.segs.map((p, i) => (p.type === 'text'
        ? <Words key={i} text={p.text} />
        : <ComposerChip key={i} part={p} onRemove={() => d.remove(i)} />))}
      <textarea
        ref={d.input} rows={1} autoComplete="off" spellCheck {...rest}
        value={d.draft} placeholder={d.segs.length ? undefined : placeholder}
        onChange={(e) => { d.type(e.target.value, e.target.selectionStart); onChange?.(e) }}
        onSelect={(e) => d.setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => { onKeyDown?.(e); if (!e.defaultPrevented) d.onBackspace(e) }}
        onPaste={d.onPaste}
      />
    </div>
  )
}
