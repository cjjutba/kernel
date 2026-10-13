import { useEffect, useState } from 'react'
import type { Skill } from '@shared/types'
import { call } from '../../../api'
import { Toggle } from '../../../ui'
import { NoRoom, Row, RoomPage, Section, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'
import { RoomMcp } from './RoomMcp'

/** Settings > a room > Skills and MCP (SettingsSkills.png). Sign-ins live in Settings, MCP servers (KERNEL-661). What is off is kept per room in its .kernel settings, so the same skill can be on in one room and off in another. */
export function Skills({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const [skills, setSkills] = useState<Skill[]>([])
  const off = rs?.disabled
  useEffect(() => {
    if (!roomId) return
    void call('skills.list', { roomId }).then(setSkills).catch(() => setSkills([]))
  }, [roomId, off?.skills.join('\n')])
  if (!room || !roomId) return <NoRoom />
  const flip = (kind: 'skills' | 'mcp', name: string, on: boolean) => {
    const list = off?.[kind] ?? []
    void patchRoomSettings(roomId, { disabled: { [kind]: on ? list.filter((n) => n !== name) : [...new Set([...list, name])] } })
  }
  const isOn = (kind: 'skills' | 'mcp', name: string) => !(off?.[kind] ?? []).includes(name)
  return (
    <RoomPage room={room} rs={rs} title="Skills and MCP" intro={`Skills and MCP servers agents can use in ${room.name}.`}>
      <Section title="Skills">
        {skills.length === 0 && <p className="set-empty">No skills found in this repo or your user folders.</p>}
        {skills.map((k) => (
          <Row key={k.name} label={<>/{k.name}</>}>
            <Toggle label={`/${k.name}`} checked={isOn('skills', k.name)} onChange={(v) => flip('skills', k.name, v)} />
          </Row>
        ))}
      </Section>
      <RoomMcp isOn={(name) => isOn('mcp', name)} flip={(name, on) => flip('mcp', name, on)} />
    </RoomPage>
  )
}
