import { useEffect } from 'react'
import type { AgentDef, AppSettings } from '@shared/types'
import { call } from '../../../api'
import { actions, go, loadRoom, useStore } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { NoRoom, Row, RoomPage, Section, useRoomPage } from '../kit'

const NO_AGENTS: AgentDef[] = []

/** Settings > a room > Agents (SettingsTeam.png): the room's agent files, with Edit opening the profile. The team a new room starts with is on General. */
export function Team({ roomId, s }: { roomId?: string; s: AppSettings }) {
  const { room, rs } = useRoomPage(roomId)
  const agents = useStore((x) => (roomId ? x.agents[roomId] ?? NO_AGENTS : NO_AGENTS))
  const [busy, run] = useBusy()
  useEffect(() => { if (roomId) void loadRoom(roomId) }, [roomId])
  if (!room || !roomId) return <NoRoom />
  const team = agents.filter((a) => !a.retired)
  const preset = s.team.defaultTemplate === 'pair' ? 'pair' : 'starter team'
  const seed = () => run('seed', async () => {
    try {
      const list = await call('agents.seed', { roomId, template: { kind: s.team.defaultTemplate } })
      actions.agents.set(roomId, list)
    } catch (e) { actions.ui.toast({ title: 'Could not add the team', sub: (e as Error).message }) }
  })
  return (
    <RoomPage room={room} rs={rs} title="Agents" intro="Every agent is a Claude Code subagent file in .claude/agents. Add a file, or ask Rowan to write one, and it joins the team.">
      <Section title="In this room">
        {team.length === 0 && (
          <Row label="No agents yet" desc={`Add the ${preset} (the default team in Settings, General), or add a file to .claude/agents`}>
            <Button busy={!!busy} busyLabel="Adding" onClick={() => void seed()}>Add the team</Button>
          </Row>
        )}
        {team.map((a) => (
          <Row key={a.id} label={`${a.name} · ${a.role}`} desc={`.claude/agents/${a.id}.md${a.description ? ` · ${a.description}` : ''}`}>
            <Button aria-label={`Edit ${a.name}`} onClick={() => go({ name: 'agent', roomId, agentId: a.id })}>Edit</Button>
          </Row>
        ))}
      </Section>
      <Section title="Sync">
        <Row label="Agents folder"><span className="set-value">.claude/agents</span></Row>
      </Section>
    </RoomPage>
  )
}
