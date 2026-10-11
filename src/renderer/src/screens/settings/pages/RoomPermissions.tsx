import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { call } from '../../../api'
import { actions } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { NoRoom, RoomPage, Section, useRoomPage } from '../kit'

/** A rule shows two lines. One that is longer expands on a click, and only then is it a button. */
function Rule({ rule }: { rule: string }) {
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  const ref = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rule, open, long])
  useEffect(() => { setOpen(false) }, [rule])
  if (!long && !open) return <code ref={(el) => { ref.current = el }} className="set-rule">{rule}</code>
  return <button ref={(el) => { ref.current = el }} type="button" className="set-rule" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{rule}</button>
}

/** Settings > a room > Permissions (SettingsRoomPermissions.png): the commands approvals saved with Always allow in this room. */
export function RoomPermissions({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const [busy, run] = useBusy()
  if (!room || !roomId) return <NoRoom />
  const allow = room.allow ?? []
  const remove = (rule: string) => run(rule, async () => {
    try {
      actions.rooms.upsert(await call('rooms.update', { roomId, patch: { allow: allow.filter((r) => r !== rule) } }))
    } catch (e) { actions.ui.toast({ title: 'Could not remove the rule', sub: (e as Error).message }) }
  })
  return (
    <RoomPage room={room} rs={rs} title="Permissions" intro={`Commands agents can run in ${room.name} without asking.`}>
      <Section title="Always allowed in this room">
        {allow.length === 0 && <p className="set-empty">Nothing yet. Choosing Always allow in this room on an approval saves its command here.</p>}
        {allow.map((rule) => (
          <div key={rule} className="set-row">
            <div className="set-text"><Rule rule={rule} /></div>
            <Button aria-label={`Remove ${rule}`} busy={busy === rule} busyLabel="Removing" disabled={busy !== null} onClick={() => void remove(rule)}>Remove</Button>
          </div>
        ))}
      </Section>
    </RoomPage>
  )
}
