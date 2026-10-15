import { useRef, type ComponentProps, type JSXElementConstructor, type ReactNode } from 'react'
import type { Effort, Provider } from '@shared/types'
import { Button, Icon, IconButton, ProviderMark } from '../../../ui'
import { EffortButton } from './EffortMenu'
import { LeadModeButton, ModeButton } from './ModeMenu'
import { ModelPicker } from './ModelPicker'
import { PlusMenu } from './PlusMenu'

type Anchored<C extends JSXElementConstructor<any>> = Omit<ComponentProps<C>, 'anchorRef'>

/** The send button's state: ready to send, busy, or, in a chat that is running with nothing typed, Stop. */
export interface SendState { label: string; ready: boolean; disabled?: boolean; busy?: boolean; busyLabel?: string; stop?: boolean; onSend: () => void; onStop?: () => void }

/**
 * The toolbar of the message box, for a chat's composer and New chat's (KERNEL-805): the Hand off or Build here chip when the chat is with Kernel,
 * then one group of run settings split by hairlines (the model, its effort and the permission mode), a spacer, the context meter, +, attach and send.
 * Both render this, so a change to it shows in both. Each menu opens upward from its own button.
 */
export function ComposerToolbar({ lead, agent, model, effort, mode, context, plus, onAttach, send, disabled }: {
  lead?: ComponentProps<typeof LeadModeButton>
  /** A teammate's name and role, in place of the Lead's chip. */
  agent?: ReactNode
  model: { label: string; provider: Provider; open: boolean; onOpen: (open: boolean) => void; picker: Anchored<typeof ModelPicker> }
  effort: { value: Effort; open: boolean; onOpen: (open: boolean) => void; onPick: (effort: Effort) => void }
  mode: ComponentProps<typeof ModeButton>
  context?: ReactNode
  plus: Anchored<typeof PlusMenu>
  onAttach: () => void
  send: SendState
  disabled?: boolean
}) {
  const modelAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  return (
    <>
      {lead && <LeadModeButton {...lead} />}
      {agent}
      <div className="cmp-run">
        <span ref={modelAnchor} style={{ position: 'relative' }}>
          <Button variant="ghost" className="cmp-model cmp-model-name" disabled={disabled} aria-label={`Model: ${model.label}`} aria-haspopup="dialog" aria-expanded={model.open} onClick={() => model.onOpen(!model.open)}><ProviderMark provider={model.provider} size={14} /><span>{model.label}</span><Icon name="chevron" size={12} /></Button>
          {model.open && <ModelPicker anchorRef={modelAnchor} {...model.picker} />}
        </span>
        <span className="cmp-sep" aria-hidden="true" />
        <EffortButton provider={model.provider} model={model.picker.model} effort={effort.value} open={effort.open} onOpen={effort.onOpen} onPick={effort.onPick} disabled={disabled} />
        <span className="cmp-sep" aria-hidden="true" />
        <ModeButton {...mode} />
      </div>
      <span className="grow" />
      {context}
      <span ref={plusAnchor} style={{ position: 'relative' }}>
        <PlusMenu anchorRef={plusAnchor} {...plus} />
      </span>
      <IconButton icon="clip" label="Attach" disabled={disabled} onClick={onAttach} />
      {send.stop
        ? <button type="button" className="icon-btn send stop" aria-label="Stop" onClick={send.onStop}><span /></button>
        : <IconButton className="send" icon="up" size={14} label={send.label} busy={send.busy} busyPattern="arrow-right" busyLabel={send.busyLabel} disabled={send.disabled} data-ready={send.ready} onClick={send.onSend} />}
    </>
  )
}
