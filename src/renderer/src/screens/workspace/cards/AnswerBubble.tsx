/**
 * The user's answer to an approval, as the bubble a sent message has (`UserMessage`). It is drawn from the approval, not from a
 * sent message, so it has no Edit or Retry and no checkpoint or rail entry. A line break in `text` is a line in the bubble.
 */
export function AnswerBubble({ text }: { text: string }) {
  return (
    <div className="msg msg-user">
      <div className="bubble">{text}</div>
    </div>
  )
}
