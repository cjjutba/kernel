import type { HTMLAttributes, ReactNode } from 'react'
import './composer.css'

/**
 * The frame of the message box, for a chat's composer and New chat's: the wrap and its width, what stacks above the box, the box
 * with its input and its toolbar. Both render this, so the box has one position, width and slot order.
 */
export function ComposerShell({ above, popup, box, top, input, foot, hidden }: {
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
    <div className="composer-wrap">
      <div className="composer-inner">
        {above}
        <div className="cmp-box">
          {popup}
          <div className="composer cmp" {...box}>
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
