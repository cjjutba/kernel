import { useRef, type ComponentProps, type JSXElementConstructor, type ReactNode } from 'react'
import type { Provider } from '@shared/types'
import { Button, Icon, IconButton, ProviderMark, Spinner } from '../../../ui'
import { ModeButton } from './ModeMenu'
import { ModelPicker } from './ModelPicker'
import { effortLabel } from './modelPrefs'
import { PlusMenu } from './PlusMenu'

type Anchored<C extends JSXElementConstructor<any>> = Omit<ComponentProps<C>, 'anchorRef'>

/**
 * The send button's state: ready to send or busy. In a chat that is running, Stop comes before it, and alone while the box is empty. With `onSteer`, a running chat
 * with something typed offers two buttons in its place: Queue (`onSend`) and Steer, which puts the message into the running turn.
 */
export interface SendState { label: string; ready: boolean; disabled?: boolean; busy?: boolean; busyLabel?: string; stop?: boolean; stopping?: boolean; onSend: () => void; onStop?: () => void; onSteer?: () => void }

/**
 * The toolbar of the message box, for a chat's composer and New chat's (KERNEL-805): a teammate's name when the chat is a teammate's,
 * then one group of run settings split by a hairline (the model with its effort beside it, and the permission mode), a spacer, the context meter, +, attach and send.
 * Both render this, so a change to it shows in both. Each menu opens upward from its own button.
 */
export function ComposerToolbar({ agent, model, mode, context, plus, send, disabled, compact }: {
  /** A teammate's name and role. A chat with Kernel passes none. */
  agent?: ReactNode
  model: { label: string; provider: Provider; open: boolean; onOpen: (open: boolean) => void; picker: Anchored<typeof ModelPicker> }
  mode: ComponentProps<typeof ModeButton>
  context?: ReactNode
  plus: Anchored<typeof PlusMenu>
  send: SendState
  disabled?: boolean
  /** The one-line box on a viewer tab: + and Stop only (KERNEL-934). */
  compact?: boolean
}) {
  const modelAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  return (
    <>
      {!compact && agent}
      {!compact && <div className="cmp-run">
        <span ref={modelAnchor} style={{ position: 'relative' }}>
          <Button variant="ghost" className="cmp-model cmp-model-name" disabled={disabled} aria-label={`Model: ${model.label}, effort: ${effortLabel(model.picker.effort)}`} aria-haspopup="dialog" aria-expanded={model.open} onClick={() => model.onOpen(!model.open)}><ProviderMark provider={model.provider} size={14} /><span>{model.label}</span><span className="cmp-effort-text">{effortLabel(model.picker.effort)}</span><Icon name="chevron" size={12} /></Button>
          {model.open && <ModelPicker anchorRef={modelAnchor} {...model.picker} />}
        </span>
        <span className="cmp-sep" aria-hidden="true" />
        <ModeButton {...mode} />
      </div>}
      {!compact && <span className="grow" />}
      {!compact && context}
      <span ref={plusAnchor} className="cmp-plus">
        <PlusMenu anchorRef={plusAnchor} {...plus} />
      </span>
      {send.stop && (send.stopping
        ? <span className="stop-pill" role="status" aria-label="Stopping"><Spinner label={null} pattern="ripple" />Stopping</span>
        : <button type="button" className="icon-btn send stop" aria-label="Stop" onClick={send.onStop}><span /></button>)}
      {!compact && send.stop && send.onSteer && (send.ready || send.busy) && <QueueOrSteer send={send} />}
      {!compact && (!send.stop || send.ready || send.busy) && !(send.stop && send.onSteer) && <IconButton className="send" icon="up" size={13} label={send.label} busy={send.busy} busyPattern="ripple" busyLabel={send.busyLabel} disabled={send.disabled} data-ready={send.ready} onClick={send.onSend} />}
    </>
  )
}

/** What a running chat offers in place of the round send button once something is typed: Queue sends it after the turn, Steer puts it into the turn. */
export function QueueOrSteer({ send }: { send: SendState }) {
  return (
    <span className="cmp-steer-pair">
      <Button variant="ghost" className="cmp-queue" disabled={send.disabled || send.busy} data-tip="Send after this turn ends" data-tip-kbd="↵" onClick={send.onSend}>Queue</Button>
      <Button variant="primary" className="cmp-steer" disabled={send.disabled || send.busy} data-tip="Add this to the running turn" data-tip-kbd="⌘⇧↵" onClick={send.onSteer}>Steer</Button>
    </span>
  )
}
