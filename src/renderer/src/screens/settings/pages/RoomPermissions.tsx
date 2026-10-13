import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PERMISSION_MODES, type PermissionMode, type Room } from '@shared/types'
import { call, cleanError } from '../../../api'
import { MODE_INFO, pickMode, unavailable, useModeAvailability } from '../../../permissionModes'
import { actions, useStore } from '../../../store'
import { Button, Icon, Menu, MENU_SEPARATOR, useBusy, type MenuEntry } from '../../../ui'
import { NoRoom, RoomPage, Row, Section, useRoomPage } from '../kit'

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

/** The room's mode override: Use app default, then the four modes (SettingsRoomPermissionsMode.png). */
function RoomMode({ room }: { room: Room }) {
  const open = useStore((s) => s.ui.menu === 'roomMode')
  const appMode = useStore((s) => s.settings?.permissions.mode)
  const availability = useModeAvailability()
  const anchor = useRef<HTMLDivElement>(null)
  const current = room.permissionMode
  const pick = (mode?: PermissionMode) => void pickMode(mode, room.id)
  const entries = [
    { id: 'default', label: 'Use app default', checked: !current, onSelect: () => pick() },
    MENU_SEPARATOR,
    ...PERMISSION_MODES.map((mode): MenuEntry => ({ id: mode, label: MODE_INFO[mode].label, checked: mode === current, disabled: unavailable(mode, availability).dim && mode !== current, onSelect: () => pick(mode) }))
  ]
  return (
    <Row label="Permission mode" desc={appMode ? `Chats here start in this mode. The app default is ${MODE_INFO[appMode].label}.` : 'Chats here start in this mode.'}>
      <div className="set-menu" ref={anchor}>
        <Button className="set-menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`Permission mode: ${current ? MODE_INFO[current].label : 'Use app default'}`} onClick={() => actions.ui.toggleMenu('roomMode')}>
          {current ? MODE_INFO[current].label : 'Use app default'}<Icon name="chevron" size={12} />
        </Button>
        {open && <Menu label="Permission mode" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: 0, top: 36, width: 236 }} items={entries} />}
      </div>
    </Row>
  )
}

/** Settings > a room > Permissions (SettingsRoomPermissions.png): the room's mode, and the commands and tools approvals saved with Always allow in this room. */
export function RoomPermissions({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const [busy, run] = useBusy()
  if (!room || !roomId) return <NoRoom />
  const allow = room.allow ?? []
  const allowTools = room.allowTools ?? []
  const remove = (key: string, patch: { allow: string[] } | { allowTools: string[] }) => run(key, async () => {
    try {
      actions.rooms.upsert(await call('rooms.update', { roomId, patch }))
    } catch (e) { actions.ui.toast({ title: 'Could not remove the rule', sub: cleanError(e) }) }
  })
  const rules = (list: string[], kind: 'allow' | 'allowTools') => list.map((rule) => {
    const key = `${kind}:${rule}`
    return (
      <div key={key} className="set-row">
        <div className="set-text"><Rule rule={rule} /></div>
        <Button aria-label={`Remove ${rule}`} busy={busy === key} busyLabel="Removing" disabled={busy !== null} onClick={() => void remove(key, { [kind]: list.filter((r) => r !== rule) } as { allow: string[] } | { allowTools: string[] })}>Remove</Button>
      </div>
    )
  })
  return (
    <RoomPage room={room} rs={rs} title="Permissions" intro={`How agents ask in ${room.name}, and what they can already do without asking.`}>
      <Section title="Mode"><RoomMode room={room} /></Section>
      <Section title="Commands always allowed">
        {allow.length === 0 && <p className="set-empty">Nothing yet. Choosing Always allow in this room on an approval saves its command here.</p>}
        {rules(allow, 'allow')}
      </Section>
      <Section title="Tools always allowed" note="Choosing Always allow in this room on a tool’s approval saves it here. It covers MCP tools and web fetches.">
        {allowTools.length === 0 && <p className="set-empty">Nothing yet.</p>}
        {rules(allowTools, 'allowTools')}
      </Section>
    </RoomPage>
  )
}
