import { useEffect } from 'react'
import type { AgentDef, AppSettings } from '@shared/types'
import { call } from '../../../api'
import { actions, go, loadRoom, useStore } from '../../../store'
import { Button, SegmentedControl, Toggle, useBusy } from '../../../ui'
import { NoRoom, Page, Row, Section } from '../kit'
import { patchSettings, useProjectRoom } from '../useSettings'

const NO_AGENTS: AgentDef[] = []

/** Settings > Agents (SettingsTeam.png): the room's agent files, with Edit opening the profile, and the team a new room starts with. */
export function Team({ s }: { s: AppSettings }) {
  const room = useProjectRoom()
  const agents = useStore((x) => (room ? x.agents[room.id] ?? NO_AGENTS : NO_AGENTS))
  const [busy, run] = useBusy()
  useEffect(() => { if (room) void loadRoom(room.id) }, [room?.id])
  if (!room) return <NoRoom />
  const team = agents.filter((a) => !a.retired)
  const seed = () => run('seed', async () => {
    try {
      const list = await call('agents.seed', { roomId: room.id, template: { kind: s.team.defaultTemplate } })
      actions.agents.set(room.id, list)
    } catch (e) { actions.ui.toast({ title: 'Could not add the team', sub: (e as Error).message }) }
  })
  return (
    <Page title="Agents" intro="Every agent is a Claude Code subagent file in .claude/agents. Add a file, or ask Rowan to write one, and it joins the team.">
      <Section title="In this room">
        {team.length === 0 && (
          <Row label="No agents yet" desc={`Add the ${s.team.defaultTemplate === 'pair' ? 'pair' : 'starter team'} from Default team below, or add a file to .claude/agents`}>
            <Button busy={!!busy} busyLabel="Adding" onClick={() => void seed()}>Add the team</Button>
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
        <Row label="Show names instead of roles"><Toggle label="Show names instead of roles" checked={s.team.showNames} onChange={(v) => void patchSettings({ team: { showNames: v } })} /></Row>
      </Section>
      <Section title="New rooms">
        <Row label="Default team for new rooms" desc="What an empty room starts with">
          <SegmentedControl label="Default team for new rooms" value={s.team.defaultTemplate} onChange={(v) => void patchSettings({ team: { defaultTemplate: v as AppSettings['team']['defaultTemplate'] } })} options={[{ value: 'starter', label: 'Starter team' }, { value: 'pair', label: 'Pair' }]} />
        </Row>
      </Section>
    </Page>
  )
}
