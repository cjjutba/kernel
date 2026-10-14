import { useRef, type ComponentProps, type JSXElementConstructor, type ReactNode } from 'react'
import { Button, Icon, IconButton } from '../../../ui'
import { LeadModeButton, ModeButton } from './ModeMenu'
import { ModelPicker } from './ModelPicker'
import { PlusMenu } from './PlusMenu'

type Anchored<C extends JSXElementConstructor<any>> = Omit<ComponentProps<C>, 'anchorRef'>

/** The send button's state: ready to send, busy, or, in a chat that is running with nothing typed, Stop. */
export interface SendState { label: string; ready: boolean; disabled?: boolean; busy?: boolean; busyLabel?: string; stop?: boolean; onSend: () => void; onStop?: () => void }

/**
 * The toolbar of the message box, for a chat's composer and New chat's (KERNEL-805): the Hand off or Build here chip when the chat is with Kernel,
 * the model and effort button, the permission mode, a spacer, the context meter, + and send. Both render this, so a change to it shows in both.
 */
export function ComposerToolbar({ lead, agent, model, mode, context, plus, send, disabled }: {
  lead?: ComponentProps<typeof LeadModeButton>
  /** A teammate's name and role, in place of the Lead's chip. */
  agent?: ReactNode
  model: { label: string; effort: string; open: boolean; onOpen: (open: boolean) => void; picker: Anchored<typeof ModelPicker> }
  mode: ComponentProps<typeof ModeButton>
  context?: ReactNode
  plus: Anchored<typeof PlusMenu>
  send: SendState
  disabled?: boolean
}) {
  const modelAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  return (
    <>
      {lead && <LeadModeButton {...lead} />}
      {agent}
      <span ref={modelAnchor} style={{ position: 'relative' }}>
        <Button variant="ghost" className="cmp-model" disabled={disabled} aria-haspopup="dialog" aria-expanded={model.open} onClick={() => model.onOpen(!model.open)}>{model.label}<span className="muted" style={{ fontWeight: 400 }}>{model.effort}</span><Icon name="chevron" size={12} /></Button>
        {model.open && <ModelPicker anchorRef={modelAnchor} {...model.picker} />}
      </span>
      <ModeButton {...mode} />
      <span className="grow" />
      {context}
      <span ref={plusAnchor} style={{ position: 'relative' }}>
        <PlusMenu anchorRef={plusAnchor} {...plus} />
      </span>
      {send.stop
        ? <button type="button" className="icon-btn send stop" aria-label="Stop" onClick={send.onStop}><span /></button>
        : <IconButton className="send" icon="up" size={14} label={send.label} busy={send.busy} busyPattern="arrow-right" busyLabel={send.busyLabel} disabled={send.disabled} data-ready={send.ready} onClick={send.onSend} />}
    </>
  )
}
