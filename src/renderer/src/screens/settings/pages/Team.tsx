import { useEffect } from 'react'
import type { AgentDef, AppSettings } from '@shared/types'
import { call } from '../../../api'
import { SEATS } from '../../../floor/layout'
import { actions, go, loadRoom, useStore } from '../../../store'
import { Button, SegmentedControl, Toggle, useBusy } from '../../../ui'
import { NoRoom, Page, Row, Section } from '../kit'
import { patchSettings, useProjectRoom } from '../useSettings'

const NO_AGENTS: AgentDef[] = []

/** Settings > Agents (SettingsTeam.png): the room's agent files, with Edit opening the profile, and how new files and new rooms are seated. */
export function Team({ s }: { s: AppSettings }) {
  const room = useProjectRoom()
  const agents = useStore((x) => (room ? x.agents[room.id] ?? NO_AGENTS : NO_AGENTS))
  const [busy, run] = useBusy()
  useEffect(() => { if (room) void loadRoom(room.id) }, [room?.id])
  if (!room) return <NoRoom />
  const team = agents.filter((a) => !a.retired)
  const seated = Math.min(team.length, room.desks ? room.desks.length : SEATS.length, SEATS.length)
  const seed = () => run('seed', async () => {
    try {
      const list = await call('agents.seed', { roomId: room.id, template: { kind: s.team.defaultTemplate } })
      actions.agents.set(room.id, list)
    } catch (e) { actions.ui.toast({ title: 'Could not seat the team', sub: (e as Error).message }) }
  })
  return (
    <Page title="Agents" intro="Every agent is a Claude Code subagent file in .claude/agents. Add a file, or ask Rowan to write one, and it takes a desk on the floor.">
      <Section title="In this room">
        {team.length === 0 && (
          <Row label="No agents yet" desc={`Seat the ${s.team.defaultTemplate === 'pair' ? 'pair' : 'starter team'} from Default team below, or add a file to .claude/agents`}>
            <Button busy={!!busy} busyLabel="Seating" onClick={() => void seed()}>Seat the team</Button>
          </Row>
        )}
        {team.map((a) => (
          <Row key={a.id} label={`${a.name} · ${a.role}`} desc={`.claude/agents/${a.id}.md${a.description ? ` · ${a.description}` : ''}`}>
            <Button aria-label={`Edit ${a.name}`} onClick={() => go({ name: 'agent', roomId: room.id, agentId: a.id })}>Edit</Button>
          </Row>
        ))}
      </Section>
      <Section title="Sync">
        <Row label="Agents folder"><span className="set-value">.claude/agents</span></Row>
        <Row label="Add new agent files to the floor" desc="New files in the folder get a desk automatically"><Toggle label="Add new agent files to the floor" checked={s.team.addNewAgents} onChange={(v) => void patchSettings({ team: { addNewAgents: v } })} /></Row>
        <Row label="Show names instead of roles"><Toggle label="Show names instead of roles" checked={s.team.showNames} onChange={(v) => void patchSettings({ team: { showNames: v } })} /></Row>
      </Section>
      <Section title="Desks">
        <Row label="Desks in this room" desc="Anyone past the last desk waits in the strip on the floor"><span className="set-value">{seated} of {SEATS.length} taken</span></Row>
        <Row label="Default team for new rooms" desc="What an empty room is seated with">
          <SegmentedControl label="Default team for new rooms" value={s.team.defaultTemplate} onChange={(v) => void patchSettings({ team: { defaultTemplate: v as AppSettings['team']['defaultTemplate'] } })} options={[{ value: 'starter', label: 'Starter team' }, { value: 'pair', label: 'Pair' }]} />
        </Row>
      </Section>
    </Page>
  )
}
