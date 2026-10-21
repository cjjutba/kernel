import type { ComponentProps } from 'react'
import { Thumbs } from './Chip'
import { DraftInput } from './draft'
import { useSendWith } from './sendKey'
import './composer.css'

/**
 * The message box's input: the thumbnails of its images across the top, then the text with its tokens, and a hint in the corner. While the box is empty the hint is how to
 * focus it, or how to stop the running turn. Once there is a draft it is how to break a line, which the Send messages with setting decides (KERNEL-1095).
 */
export function ComposerInput({ d, disabled, running, ...rest }: ComponentProps<typeof DraftInput> & { /** A turn is running, so an empty box says how to stop it. */ running?: boolean }) {
  const sendWith = useSendWith()
  const hint = disabled ? undefined : d.parts.length ? (sendWith === 'cmdEnter' ? '↵ new line' : '⇧↵ new line') : running ? 'Esc to stop' : '⌘L to focus'
  const images = d.slots.flatMap((s) => (s.part.type === 'image' ? [{ id: s.id, part: s.part, pending: s.pending }] : []))
  return (
    <>
      <Thumbs images={images} onRemove={d.removeChip} />
      <div className="cmp-field" data-hint={hint ? '' : undefined} data-draft={d.parts.length ? '' : undefined} data-tokens={d.tokens || undefined}>
        <DraftInput d={d} disabled={disabled} data-composer-input="" {...rest} />
        {hint && <span className="cmp-hint" aria-hidden="true">{hint}</span>}
      </div>
    </>
  )
}
