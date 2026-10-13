import type { Approval } from '@shared/types'
import { PartChip } from '../Transcript'

/**
 * The user's answer to an approval, as the bubble a sent message has (`UserMessage`). It is drawn from the approval, not from a
 * sent message, so it has no Edit or Retry and no checkpoint or rail entry. A line break in `text` is a line in the bubble.
 * `images` are the ones attached to a plan's Request changes, drawn as the chips a user message has.
 */
export function AnswerBubble({ text, images }: { text: string; images?: Approval['images'] }) {
  return (
    <div className="msg msg-user">
      <div className="bubble">
        {text}
        {images?.map((p, i) => <PartChip key={i} part={p} />)}
      </div>
    </div>
  )
}
