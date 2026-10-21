import { useContext, useEffect, useId, useRef, useState } from 'react'
import type { ChatItem } from '@shared/types'
import { toolView } from '@shared/toolView'
import { actions, useStore } from '../../store'
import { AgentAvatar, Button, Icon, useBusy } from '../../ui'
import { TranscriptChat, useRowOpen } from './chatPlace'
import { sendMessage } from './composer/sendMessage'

const textOf = (item: Extract<ChatItem, { kind: 'user' }>) => item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ').trim()

/** A message's first sentence, for the line Kernel's note takes. The whole message is one click away. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat)
  return m ? m[1] : flat
}

/** Copy with its word, for the text a note opens to. It says Copied for a moment, and a clipboard that isn't there raises the usual toast. */
function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = () => void navigator.clipboard.writeText(text).then(
    () => { setDone(true); clearTimeout(timer.current); timer.current = setTimeout(() => setDone(false), 1500) },
    () => actions.ui.toast({ title: 'Could not copy', sub: 'The clipboard is not available.' })
  )
  return <button type="button" className="knote-copy" aria-label="Copy note" onClick={copy}><Icon name={done ? 'check' : 'copy'} size={12} />{done ? 'Copied' : 'Copy'}</button>
}

/**
 * Kernel's own message in a chat, such as its restart and limit nudges (KERNEL-120, KERNEL-1094): one line with Kernel's avatar and what happened, and a "Note to <agent>"
 * toggle that opens the text Kernel gave the agent, with Copy. `lead` is the line when the message follows a quit note and folds into it, so a relaunch is one line.
 */
export function KernelNote({ item, agentName = 'the agent', lead }: { item: Extract<ChatItem, { kind: 'user' }>; agentName?: string; lead?: string }) {
  const [open, setOpen] = useRowOpen(useContext(TranscriptChat), item.id, false)
  const body = useId()
  const text = textOf(item)
  return (
    <div className="msg msg-kernel" data-open={open || undefined}>
      <div className="kline">
        <AgentAvatar name="Kernel" size={16} />
        <span className="kline-text">{lead ?? firstSentence(text)}</span>
        <button type="button" className="knote" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
          Note to {agentName}<span className="knote-chev" data-open={open}><Icon name="chevron" size={12} /></span>
        </button>
      </div>
      {open && (
        <div id={body} className="knote-body">
          <p className="selectable">{text}</p>
          <CopyText text={text} />
        </div>
      )}
    </div>
  )
}

/**
 * The note a quit or a crash leaves in a chat whose turn it cut off, before the agent has picked up again: it says what the agent was doing, and offers Continue on the
 * last line of a chat that isn't running. Once Kernel's message follows it, the two are one line (`KernelNote` with a lead).
 */
export function QuitNote({ item, chatId, agentName }: { item: Extract<ChatItem, { kind: 'note' }>; chatId: string; agentName: string }) {
  // What the agent was doing: the last step before the note, in the tense of the work, and not a step from an earlier turn.
  const doing = useStore((s) => {
    const items = s.items[chatId] ?? []
    for (let n = items.findIndex((i) => i.id === item.id) - 1; n >= 0; n--) {
      const i = items[n]
      if (i.kind === 'user') return undefined
      if (i.kind === 'tool') { const v = toolView({ ...i, status: 'running' }); return v.hidden ? undefined : `${v.verb.charAt(0).toLowerCase()}${v.verb.slice(1)}` }
    }
    return undefined
  })
  const last = useStore((s) => !s.running[chatId] && s.items[chatId]?.[s.items[chatId].length - 1]?.id === item.id)
  const [busy, run] = useBusy()
  return (
    <div className="msg msg-kernel">
      <div className="kline">
        <AgentAvatar name="Kernel" size={16} />
        <span className="kline-text">Kernel quit while {agentName} was {doing ?? 'working'}.</span>
        {last && <Button busy={!!busy} busyLabel="Continuing" onClick={() => void run('go', () => sendMessage(chatId, [{ type: 'text', text: 'Continue where you left off.' }]))}>Continue</Button>}
      </div>
    </div>
  )
}
