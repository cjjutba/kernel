import { actions } from '../../store'

/** What a failed action says. A channel that no lane has built yet rejects with "Not built yet: ...", which is fine to show as it is. */
export async function attempt(title: string, fn: () => Promise<unknown>) {
  try { await fn() } catch (e) { actions.ui.toast({ title, sub: (e as Error).message }) }
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    actions.ui.toast({ title: 'Copied', sub: 'Message copied to clipboard' })
  } catch {
    actions.ui.toast({ title: 'Could not copy', sub: 'The clipboard is not available.' })
  }
}

/** Copy, retry, edit and fork under a message. Hidden until the message is hovered or something in it has focus (DESIGN.md), but the row keeps its height so nothing shifts. */
export function MessageActions({ items, align = 'start', label }: { items: { label: string; onClick: () => void }[]; align?: 'start' | 'end'; label: string }) {
  return (
    <div className="msg-acts" data-align={align} role="group" aria-label={label}>
      {items.map((a) => <button key={a.label} type="button" onClick={a.onClick}>{a.label}</button>)}
    </div>
  )
}
