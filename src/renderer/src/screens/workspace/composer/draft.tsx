import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type HTMLAttributes, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ChatPart } from '@shared/types'
import { attachFiles, clipboardImages, pastedText } from './attach'
import { ComposerChip } from './Chip'
import { getState, subscribe } from '../../../store'
import { liveChatIds, loadDraft, pruneDrafts, saveDraft } from './draftStore'

const text = (t: string): ChatPart => ({ type: 'text', text: t })

// A draft lasts as long as its chat. Checking the live chat list on every change of it covers a closed tab, an archived
// workspace (from the sidebar or the Lead's archive_workspace) and a removed room, wherever the app is looking.
let seen: { chats: unknown; workspaces: unknown } | null = null
subscribe(() => {
  const s = getState()
  if (seen && seen.chats === s.chats && seen.workspaces === s.workspaces) return
  seen = { chats: s.chats, workspaces: s.workspaces }
  pruneDrafts(liveChatIds(s))
})

/** The message to send: leading blank text dropped, trailing space trimmed. Empty when there is nothing to send. */
export function messageOf(parts: ChatPart[]): ChatPart[] {
  const first = parts.findIndex((p) => p.type !== 'text' || p.text.trim())
  if (first < 0) return []
  const out = parts.slice(first)
  const last = out[out.length - 1]
  if (last.type === 'text') out[out.length - 1] = text(last.text.trimEnd())
  return out
}

/** The typed words only, without the chips: what names a workspace. */
export const plainText = (parts: ChatPart[]) => parts.map((p) => (p.type === 'text' ? p.text : ' ')).join('').replace(/[ \t]+/g, ' ').trim()

// The box is a contenteditable with white-space: pre-wrap. Text is plain text nodes, where "\n" breaks the line. A chip is
// a <span contenteditable="false" data-chip="id"> that React fills through a portal, so the browser types around it,
// deletes it with one Backspace and brings it back with Cmd+Z, all as one piece.

const BLOCKS = new Set(['DIV', 'P'])
const PARTS_MIME = 'application/x-kernel-parts'
let chipCount = 0
const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** A chip's slot holds its name until React draws the chip in it. Chromium puts a line break after an empty one. */
const slotHtml = (id: string, p: ChatPart) => `<span class="cmp-slot" contenteditable="false" data-chip="${id}">${escapeHtml(p.type === 'text' ? '' : p.name)}</span>`
const chipOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>('[data-chip]') ?? null

/** Whether a <br> has nothing after it on its line: Chromium's placeholder that keeps an empty last line open. */
function trailingBreak(br: Node, root: Node): boolean {
  for (let n = br; ;) {
    for (let s = n.nextSibling; s; s = s.nextSibling) if (s.nodeType !== Node.TEXT_NODE || (s as Text).data) return false
    const up = n.parentNode
    if (!up || up === root || BLOCKS.has((up as Element).tagName)) return true
    n = up
  }
}

/**
 * The parts in a box, or in a piece of one cut out at the caret. `end` is false for a piece that stops at the caret, where
 * a last line break is real. Chips the box doesn't know are left out, and so is any styling a browser edit left behind.
 */
function readParts(root: Node, chips: Map<string, ChatPart>, end = true): ChatPart[] {
  const out: ChatPart[] = []
  let buf = ''
  let open = false // the line has something on it
  let soft = false // a block just ended, so whatever comes next starts a new line
  let lastNewline = false // the last thing read was a text node ending in "\n"
  const put = (s: string, fromText = false) => {
    if (soft) { buf += '\n'; soft = false }
    buf += s
    open = !s.endsWith('\n')
    lastNewline = fromText && s.endsWith('\n')
  }
  const walk = (node: Node) => {
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) { if ((c as Text).data) put((c as Text).data, true); continue }
      if (!(c instanceof HTMLElement)) continue
      const id = c.dataset.chip
      if (id !== undefined) {
        const p = chips.get(id)
        if (!p) continue
        if (soft) { buf += '\n'; soft = false }
        if (buf) out.push(text(buf))
        buf = ''
        out.push(p)
        open = true
        lastNewline = false
        continue
      }
      if (c.tagName === 'BR') { if (!end || !trailingBreak(c, root)) put('\n'); else lastNewline = false; continue }
      const block = BLOCKS.has(c.tagName)
      if (block && open) put('\n')
      walk(c)
      if (block) { soft = true; open = false }
    }
  }
  walk(root)
  // A newline at the very end draws no line of its own, so Chromium types "\n\n" to open one. The second is that placeholder.
  if (end && lastNewline) buf = buf.slice(0, -1)
  if (buf) out.push(text(buf))
  return out
}

/** Where the caret is: the text from the chip before it (or the start) up to the caret, the text after it, and whether a chip comes before it. */
function caretIn(el: HTMLElement, chips: Map<string, ChatPart>) {
  const sel = getSelection()
  if (!sel?.rangeCount) return null
  const r = sel.getRangeAt(0)
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null
  const head = document.createRange()
  head.selectNodeContents(el)
  head.setEnd(r.startContainer, r.startOffset)
  const tail = document.createRange()
  tail.selectNodeContents(el)
  tail.setStart(r.endContainer, r.endOffset)
  const h = readParts(head.cloneContents(), chips, false)
  const t = readParts(tail.cloneContents(), chips)
  const last = h[h.length - 1]
  return { before: last?.type === 'text' ? last.text : '', after: t[0]?.type === 'text' ? t[0].text : '', first: h.every((p) => p.type === 'text') }
}

/** The caret at the end of the box, before Chromium's trailing <br> if there is one. */
function endOf(el: HTMLElement): Range {
  const r = document.createRange()
  const last = el.lastChild
  if (last?.nodeName === 'BR' && trailingBreak(last, el)) r.setStartBefore(last)
  else { r.selectNodeContents(el); r.collapse(false) }
  r.collapse(true)
  return r
}

const caretAfter = (node: Node) => {
  const r = document.createRange()
  r.setStartAfter(node)
  r.collapse(true)
  const sel = getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

/** What a chip reads as outside the box, for a copy. */
const chipText = (p: ChatPart) => (p.type === 'text' ? p.text : p.type === 'skill' ? `/${p.name}` : p.type === 'file' ? p.path ?? p.text ?? p.name : p.name)

interface View { parts: ChatPart[]; before: string; after: string; first: boolean; slots: { id: string; el: HTMLElement; part: ChatPart }[] }

/** The caret at the end of `parts`. */
const atEnd = (parts: ChatPart[]) => {
  const last = parts[parts.length - 1]
  return { before: last?.type === 'text' ? last.text : '', after: '', first: parts.every((p) => p.type === 'text') }
}

/**
 * A composer's draft, as in Conductor: text and chips flow together, the caret goes anywhere, and Backspace takes a chip
 * like a character. Every chip lands where the caret is: a pasted screenshot or long text, a dropped or picked file, an @
 * file, a / skill. `insert` and `attach` run in order, so two images pasted at once both land.
 * With a `key` (a chat id) the draft is kept per key outside the component: it comes back after a tab switch or a remount,
 * and a key change swaps in that key's own draft. Without a key nothing is kept.
 */
export function useDraft(init?: { parts?: ChatPart[]; draft?: string }, key?: string) {
  const input = useRef<HTMLDivElement>(null)
  const chips = useRef(new Map<string, ChatPart>())
  /** The last caret in the box, so a chip added from elsewhere (a diff hunk, the + menu) lands there. */
  const saved = useRef<Range | null>(null)
  /** Slots React draws in. A slot an undo brings back is the same node, so it stays on the list. */
  const drawn = useRef(new WeakSet<HTMLElement>())
  /** The key whose draft the box shows, and where `sync` keeps it. Moves to the new key only after that key's draft is drawn. */
  const shown = useRef(key)
  const [initial] = useState(() => (key ? loadDraft(key) : undefined) ?? [...(init?.parts ?? []), ...(init?.draft ? [text(init.draft)] : [])])
  const [view, setView] = useState<View>(() => ({ parts: initial, ...atEnd(initial), slots: [] }))

  const read = () => (input.current ? readParts(input.current, chips.current) : view.parts)

  /** Reads the box into state after any change. `toEnd` is for a change made while the caret was elsewhere. */
  const sync = (toEnd = false) => {
    const el = input.current
    if (!el) return
    const seen = new Set<string>()
    const slots: View['slots'] = []
    for (const s of el.querySelectorAll<HTMLElement>('[data-chip]')) {
      let id = s.dataset.chip ?? ''
      const part = chips.current.get(id)
      if (!part) continue
      // A browser copy of a chip (a drag, an odd paste) becomes a chip of its own.
      if (seen.has(id)) { id = `c${++chipCount}`; chips.current.set(id, part); s.dataset.chip = id }
      seen.add(id)
      if (!drawn.current.has(s)) { s.replaceChildren(); drawn.current.add(s) }
      slots.push({ id, el: s, part })
    }
    const parts = readParts(el, chips.current)
    if (shown.current) saveDraft(shown.current, parts)
    const caret = caretIn(el, chips.current) ?? (toEnd ? atEnd(parts) : null)
    setView((v) => ({ ...v, ...caret, parts, slots }))
  }

  /** Focuses the box with the caret where it was, or at the end. */
  const focus = () => {
    const el = input.current
    const sel = getSelection()
    if (!el || !sel) return
    const cur = sel.rangeCount ? sel.getRangeAt(0) : null
    if (document.activeElement === el && cur && el.contains(cur.startContainer)) return
    el.focus({ preventScroll: true })
    const s = saved.current
    const r = s && el.contains(s.startContainer) && el.contains(s.endContainer) && !chipOf(s.startContainer) ? s : endOf(el)
    sel.removeAllRanges()
    sel.addRange(r)
  }

  const htmlOf = (parts: ChatPart[]) => parts.map((p) => {
    if (p.type === 'text') return escapeHtml(p.text)
    const id = `c${++chipCount}`
    chips.current.set(id, p)
    return slotHtml(id, p)
  }).join('')

  /** Parts where the caret is, replacing the selection. `drop` is how much typed text before the caret they replace (the @ or / word). */
  const put = (parts: ChatPart[], drop = 0) => {
    const el = input.current
    if (!el || !parts.length) return
    const html = htmlOf(parts)
    // The id htmlOf gave the last part, when that part is a chip.
    const lastChip = parts[parts.length - 1].type === 'text' ? '' : `c${chipCount}`
    if (!el.isContentEditable) {
      // A paused box still takes a chip from elsewhere, at the end.
      const t = document.createElement('template')
      t.innerHTML = html
      el.append(t.content)
      sync(true)
      return
    }
    focus()
    const sel = getSelection()
    for (let i = 0; i < drop; i++) sel?.modify('extend', 'backward', 'character')
    document.execCommand('insertHTML', false, html)
    // Chromium leaves the caret before or inside a chip it just inserted. Put it after.
    const s = lastChip && el.querySelector(`[data-chip="${lastChip}"]`)
    if (s) caretAfter(s)
    sync()
  }

  const insert = (part: ChatPart, drop = 0) => put([part], drop)
  const insertText = (t: string) => put([text(t)])
  const attach = (files: File[]) => void attachFiles(files, (p) => insert(p))

  /**
   * Everything in the box at once, with the caret at the end. `undo` makes it one Cmd+Z step; otherwise old chips are
   * forgotten. `focus` is false only for the first draw.
   */
  const write = (parts: ChatPart[], undo: boolean, focus = true) => {
    const el = input.current
    if (!el) return
    if (undo && el.isContentEditable) {
      el.focus({ preventScroll: true })
      const r = document.createRange()
      r.selectNodeContents(el)
      getSelection()?.removeAllRanges()
      getSelection()?.addRange(r)
      document.execCommand(parts.length ? 'insertHTML' : 'delete', false, htmlOf(parts))
    } else {
      chips.current.clear()
      const t = document.createElement('template')
      t.innerHTML = htmlOf(parts)
      const last = parts[parts.length - 1]
      // Chromium needs a <br> after a last chip or newline to put the caret on that line.
      if (last && (last.type !== 'text' || last.text.endsWith('\n'))) t.content.append(document.createElement('br'))
      el.replaceChildren(t.content)
      if (focus && el.isContentEditable) el.focus({ preventScroll: true })
    }
    if (document.activeElement === el) { getSelection()?.removeAllRanges(); getSelection()?.addRange(endOf(el)) }
    else {
      // The old caret pointed into nodes that are gone, so the next focus goes to the end. A selection that was in the box
      // moves there too; one outside it stays. Chromium hands focus to a box that script selects in, so focus goes back to
      // the element that had it, or arrow keys on the tab that was just clicked would stop working.
      saved.current = endOf(el)
      const anchor = getSelection()?.anchorNode
      if (anchor && el.contains(anchor)) {
        const had = document.activeElement
        getSelection()?.removeAllRanges(); getSelection()?.addRange(endOf(el))
        if (had instanceof HTMLElement && document.activeElement !== had) had.focus({ preventScroll: true })
      }
    }
    sync(true)
  }

  useLayoutEffect(() => { if (initial.length) write(initial, false, false) }, [])
  // The composer now shows another chat: draw its own draft, or an empty box.
  useLayoutEffect(() => {
    if (shown.current === key) return
    shown.current = key
    write((key ? loadDraft(key) : undefined) ?? [], false, false)
  }, [key])

  useEffect(() => {
    const el = input.current
    if (!el) return
    const onSelect = () => {
      const sel = getSelection()
      const r = sel?.rangeCount ? sel.getRangeAt(0) : null
      if (!r || !el.contains(r.startContainer)) return
      // A click on a chip's label puts the caret inside it, where typing does nothing. Move it after the chip.
      const chip = chipOf(r.startContainer)
      if (chip && el.contains(chip) && sel?.isCollapsed && document.activeElement === el) { caretAfter(chip); return }
      saved.current = r.cloneRange()
      const c = caretIn(el, chips.current)
      if (c) setView((v) => (v.before === c.before && v.after === c.after && v.first === c.first ? v : { ...v, ...c }))
    }
    // Enter from anywhere breaks the line instead of opening a <div>, and Cmd+B or Cmd+I don't style the text.
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType === 'insertParagraph') { e.preventDefault(); document.execCommand('insertLineBreak') }
      else if (e.inputType.startsWith('format')) e.preventDefault()
    }
    document.addEventListener('selectionchange', onSelect)
    el.addEventListener('beforeinput', onBeforeInput)
    return () => { document.removeEventListener('selectionchange', onSelect); el.removeEventListener('beforeinput', onBeforeInput) }
  }, [])

  /** Pastes as plain text, so no styling comes in. Images and long text become chips, and chips copied from a box stay chips. */
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const data = e.clipboardData
    const copied = data.getData(PARTS_MIME)
    if (copied) { try { put(JSON.parse(copied) as ChatPart[]); return } catch { /* pasted as text below */ } }
    const images = clipboardImages(data)
    if (images.length) {
      if (!getSelection()?.isCollapsed) document.execCommand('delete')
      attach(images)
      return
    }
    const t = data.getData('text/plain').replace(/\r\n?/g, '\n')
    const part = pastedText(t)
    if (part) insert(part)
    else if (t) insertText(t)
  }

  const copy = (e: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const sel = getSelection()
    if (!sel?.rangeCount || sel.isCollapsed) return
    const parts = readParts(sel.getRangeAt(0).cloneContents(), chips.current, false)
    e.preventDefault()
    e.clipboardData.setData('text/plain', parts.map(chipText).join(''))
    if (parts.some((p) => p.type !== 'text')) e.clipboardData.setData(PARTS_MIME, JSON.stringify(parts))
    if (cut) document.execCommand('delete')
  }

  /** Enter the screen didn't take breaks the line. Cmd+Enter is left for the screen. */
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    document.execCommand('insertLineBreak')
  }

  /** The x on a chip. Undoable like a Backspace. */
  const removeChip = (id: string) => {
    const el = input.current
    const s = el?.querySelector(`[data-chip="${id}"]`)
    if (!el || !s) return
    if (el.isContentEditable) {
      el.focus({ preventScroll: true })
      const r = document.createRange()
      r.selectNode(s)
      getSelection()?.removeAllRanges()
      getSelection()?.addRange(r)
      document.execCommand('delete')
    } else s.remove()
    sync()
  }

  /** Lets a box take dropped files, and text dropped on the box itself. Either lands where it was dropped. */
  const drop = {
    onDragOver: (e: DragEvent) => {
      const types = e.dataTransfer.types
      if (types.includes('Files') || (types.includes('text/plain') && input.current?.contains(e.target as Node))) e.preventDefault()
    },
    onDrop: (e: DragEvent) => {
      const el = input.current
      const files = [...e.dataTransfer.files]
      const t = files.length ? '' : e.dataTransfer.getData('text/plain')
      if (!el || (!files.length && !(t && el.contains(e.target as Node)))) return
      e.preventDefault()
      const at = el.isContentEditable ? document.caretRangeFromPoint(e.clientX, e.clientY) : null
      if (at && el.contains(at.startContainer) && !chipOf(at.startContainer)) {
        el.focus({ preventScroll: true })
        getSelection()?.removeAllRanges()
        getSelection()?.addRange(at)
      }
      if (files.length) attach(files)
      else insertText(t.replace(/\r\n?/g, '\n'))
    }
  }

  /** `forKey` when its draft is not in the box: the composer shows another chat, or it unmounted while an await ran. */
  const elsewhere = (forKey?: string) => (forKey !== undefined && (forKey !== shown.current || !input.current) ? forKey : undefined)

  return {
    input, sync, focus,
    /** Focus that arrives with the caret at the very start (Tab) or none puts it at the end. A click sets its own caret right after. */
    onFocus: () => {
      const el = input.current
      const sel = getSelection()
      const r = sel?.rangeCount ? sel.getRangeAt(0) : null
      if (!el || !sel) return
      if (r && el.contains(r.startContainer)) {
        const head = document.createRange()
        head.selectNodeContents(el)
        head.setEnd(r.startContainer, r.startOffset)
        if (!r.collapsed || head.toString() || head.cloneContents().querySelector('[data-chip]')) return
      }
      sel.removeAllRanges()
      sel.addRange(endOf(el))
    },
    insert, insertText, attach, drop, onPaste, onKey, removeChip,
    onCopy: (e: ClipboardEvent<HTMLDivElement>) => copy(e, false),
    onCut: (e: ClipboardEvent<HTMLDivElement>) => copy(e, true),
    parts: view.parts,
    /** The text from the chip before the caret (or the start) up to the caret: what @ and / read. */
    before: view.before,
    /** The text after the caret, up to the next chip. */
    after: view.after,
    /** No chip comes before the caret, so a / there starts the message. */
    first: view.first,
    slots: view.slots,
    /** All the typed text, without the chips. */
    text: view.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    empty: !messageOf(view.parts).length,
    message: () => messageOf(read()),
    plain: () => plainText(read()),
    /** The chips in the box, in order, then `t`. Undoable. */
    setText: (t: string) => write([...read().filter((p) => p.type !== 'text'), ...(t ? [text(t)] : [])], true),
    /**
     * Replace everything, after a send, for a failed send, or a queued message brought back to edit. `forKey` is the chat
     * the content belongs to. If the box has moved on to another chat, or the composer unmounted while the call ran, the
     * content replaces that chat's stored draft instead, so it never lands in the wrong chat or gets lost.
     */
    reset: (next: ChatPart[] = [], forKey?: string) => {
      const gone = elsewhere(forKey)
      if (gone !== undefined) saveDraft(gone, next)
      else write(next, false)
    },
    /** The parts in the box, or the stored draft of `forKey` when the box has moved on to another chat or is gone. */
    snapshot: (forKey?: string) => {
      const gone = elsewhere(forKey)
      return gone !== undefined ? loadDraft(gone) ?? [] : read()
    }
  }
}

export type DraftState = ReturnType<typeof useDraft>

/**
 * The editable part of every composer: text and chips inline, in order. The placeholder shows only while it is empty.
 * `onKeyDown` runs first; Enter it didn't take breaks the line.
 */
export function DraftInput({ d, className, placeholder, disabled, onKeyDown, onInput, onFocus, ...rest }: { d: DraftState; className?: string; placeholder?: string; disabled?: boolean } & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className' | 'contentEditable' | 'onPaste' | 'onCopy' | 'onCut' | 'placeholder'>) {
  return (
    <>
      <div
        ref={d.input} role="textbox" aria-multiline="true" aria-placeholder={placeholder} aria-disabled={disabled || undefined}
        className={['cmp-input', className].filter(Boolean).join(' ')}
        contentEditable={!disabled} suppressContentEditableWarning spellCheck
        data-empty={d.parts.length ? undefined : ''} data-placeholder={placeholder}
        {...rest}
        onInput={(e) => { d.sync(); onInput?.(e) }}
        onKeyDown={(e) => { if (e.target !== e.currentTarget) return; onKeyDown?.(e); if (!e.defaultPrevented) d.onKey(e) }}
        onFocus={(e) => { d.onFocus(); onFocus?.(e) }}
        onPaste={d.onPaste} onCopy={d.onCopy} onCut={d.onCut}
        onDragStart={(e) => e.preventDefault()}
      />
      {d.slots.map((s) => createPortal(<ComposerChip part={s.part} onRemove={() => d.removeChip(s.id)} />, s.el, s.id))}
    </>
  )
}
