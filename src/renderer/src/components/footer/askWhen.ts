/**
 * When a question in Ask Rowan's history was asked, as short as the row allows (KERNEL-589): the time today, Yesterday, the weekday
 * within the week, then the date. `now` is passed in so the words are the same for every row and testable.
 */
export function askWhen(at: number, now: number): string {
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
  const days = Math.round((day(now) - day(at)) / 86_400_000)
  const d = new Date(at)
  if (days <= 0) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
