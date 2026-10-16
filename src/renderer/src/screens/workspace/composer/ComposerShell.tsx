import type { HTMLAttributes, ReactNode } from 'react'
import './composer.css'

/**
 * The frame of the message box, for a chat's composer and New chat's: the wrap and its width, what stacks above the box, the box
 * with its input and its toolbar. Both render this, so the box has one position, width and slot order.
 */
export function ComposerShell({ compact, wrap, above, popup, box, top, input, foot, hidden }: {
  /** One line: the input, + and Stop, with the toolbar and what only an open box needs hidden (KERNEL-934). */
  compact?: boolean
  /** Focus and press handlers for the whole frame, so the box can tell when focus has left it. */
  wrap?: HTMLAttributes<HTMLDivElement>
  /** Banners, queue and cards drawn above the box. They push it up, never down. */
  above?: ReactNode
  /** A menu that opens over the box's top edge, inside the box's own positioning. */
  popup?: ReactNode
  /** Attributes of the box itself: `data-plan`, `data-blocked`, `data-drop` while files are dragged over the pane. */
  box?: HTMLAttributes<HTMLDivElement> & { 'data-plan'?: string; 'data-blocked'?: boolean; 'data-drop'?: boolean }
  top?: ReactNode
  input: ReactNode
  /** The toolbar: model and effort, the permission picker, a spacer, then the context meter, + and send. */
  foot: ReactNode
  /** Elements that draw nothing, such as the file input. */
  hidden?: ReactNode
}) {
  return (
    <div className="composer-wrap" data-compact={compact || undefined} {...wrap}>
      <div className="composer-inner">
        {above}
        <div className="cmp-box">
          {popup}
          <div className="composer cmp" data-compact={compact || undefined} {...box}>
            {top}
            {input}
            <div className="row cmp-foot">{foot}</div>
          </div>
        </div>
        {hidden}
      </div>
    </div>
  )
}
