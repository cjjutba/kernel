import { useEffect, useState } from 'react'
import type { McpServer, Skill } from '@shared/types'
import { call } from '../../../api'
import { Toggle } from '../../../ui'
import { NoRoom, Row, RoomPage, Section, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'

/** Settings > a room > Skills and MCP (SettingsSkills.png). What is off is kept per room in its .kernel settings, so the same skill can be on in one room and off in another. */
export function Skills({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const [skills, setSkills] = useState<Skill[]>([])
  const [mcp, setMcp] = useState<McpServer[]>([])
  const off = rs?.disabled
  useEffect(() => {
    if (!roomId) return
    void call('skills.list', { roomId }).then(setSkills).catch(() => setSkills([]))
    void call('mcp.list', { roomId }).then(setMcp).catch(() => setMcp([]))
  }, [roomId, off?.skills.join('\n'), off?.mcp.join('\n')])
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
      <Section title="MCP servers">
        {mcp.length === 0 && <p className="set-empty">No MCP servers configured.</p>}
        {mcp.map((m) => (
          <Row key={m.name} label={m.name}>
            <Toggle label={m.name} checked={isOn('mcp', m.name)} onChange={(v) => flip('mcp', m.name, v)} />
          </Row>
        ))}
      </Section>
    </RoomPage>
  )
}
