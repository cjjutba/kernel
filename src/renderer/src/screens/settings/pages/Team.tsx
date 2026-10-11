import { useEffect } from 'react'
import type { AgentDef, AppSettings, TeamPatch } from '@shared/types'
import { KERNEL_LEAD, KERNEL_REVIEWER, NO_REVIEWER } from '@shared/team'
import { call, cleanError } from '../../../api'
import { actions, go, loadRoom, useStore } from '../../../store'
import { Button, Select, Toggle, useBusy } from '../../../ui'
import { NoRoom, Row, RoomPage, Section, sourceLine, useRoomPage } from '../kit'

const NO_AGENTS: AgentDef[] = []

/**
 * Settings > a room > Agents (SettingsTeam.png): who leads and who reviews, who takes tasks, and the room's agent files,
 * with Edit opening the profile (KERNEL-397). A change goes to `[team]` in the shared settings.toml. The team a new room
 * starts with is on General.
 */
export function Team({ roomId, s }: { roomId?: string; s: AppSettings }) {
  const { room, rs } = useRoomPage(roomId)
  const agents = useStore((x) => (roomId ? x.agents[roomId] ?? NO_AGENTS : NO_AGENTS))
  const [busy, run] = useBusy()
  useEffect(() => { if (roomId) void loadRoom(roomId) }, [roomId])
  if (!room || !roomId) return <NoRoom />
  const team = agents.filter((a) => !a.retired)
  const files = team.filter((a) => !a.builtIn)
  const lead = team.find((a) => a.lead)
  const reviewer = team.find((a) => a.reviewer)
  const preset = s.team.defaultTemplate === 'pair' ? 'pair' : 'starter team'
  const seed = () => run('seed', async () => {
    try {
      const list = await call('agents.seed', { roomId, template: { kind: s.team.defaultTemplate } })
      actions.agents.set(roomId, list)
    } catch (e) { actions.ui.toast({ title: 'Could not add the team', sub: cleanError(e) }) }
  })
  const setTeam = (key: string, patch: TeamPatch) => run(key, async () => {
    try {
      actions.agents.set(roomId, await call('agents.setTeam', { roomId, team: patch, from: 'settings' }))
      actions.settings.setRoom(roomId, await call('settings.room', { roomId }))
    } catch (e) { actions.ui.toast({ title: 'Could not change the team', sub: cleanError(e) }) }
  })
  // The switches list every agent that takes tasks. Main keeps only the ones that differ from what their tools say.
  const takesTasks = (a: AgentDef, on: boolean) => {
    const others = files.filter((x) => !x.lead && x.id !== a.id)
    const members = [...others.filter((x) => x.member).map((x) => x.id), ...(on ? [a.id] : [])]
    return setTeam(a.id, { members, helpers: [...others.filter((x) => !x.member).map((x) => x.id), ...(on ? [] : [a.id])] })
  }
  const leadOptions = [...files.map((a) => ({ value: a.id, label: a.name })), { value: KERNEL_LEAD, label: 'Kernel’s Rowan' }]
  const reviewerOptions = [...files.filter((a) => !a.lead).map((a) => ({ value: a.id, label: a.name })), { value: KERNEL_REVIEWER, label: 'Kernel’s Theo' }, { value: NO_REVIEWER, label: 'No reviewer' }]
  return (
    <RoomPage room={room} rs={rs} title="Agents" intro="Every agent is a Claude Code subagent file in .claude/agents. Add a file, or ask Rowan to write one, and it joins the team.">
      {!!files.length && (
        <Section title="Who leads and reviews" note="A change is saved in settings.toml, so everyone on the repo gets it.">
          <Row label="Lead" source={sourceLine(rs, 'team.lead')} desc="Plans with you and hands out every task">
            <Select label="Lead" value={lead?.id ?? KERNEL_LEAD} disabled={busy !== null} options={leadOptions} onChange={(e) => void setTeam('lead', { lead: e.target.value })} />
          </Row>
          <Row label="Reviewer" source={sourceLine(rs, 'team.reviewer')} desc="Reviews each pull request before it merges">
            <Select label="Reviewer" value={reviewer?.id ?? NO_REVIEWER} disabled={busy !== null} options={reviewerOptions} onChange={(e) => void setTeam('reviewer', { reviewer: e.target.value })} />
          </Row>
        </Section>
      )}
      {files.some((a) => !a.lead) && (
        <Section title="Who takes tasks" note={`${lead?.name ?? 'The Lead'} hands tasks only to these agents. One whose tools can’t edit files and run git starts off.`}>
          {files.filter((a) => !a.lead).map((a) => (
            <Row key={a.id} label={`${a.name} · ${a.role}`}>
              <Toggle label={`${a.name} takes tasks`} checked={!!a.member} disabled={busy !== null} onChange={(on) => void takesTasks(a, on)} />
            </Row>
          ))}
        </Section>
      )}
      <Section title="In this room">
        {files.length === 0 && (
          <Row label="No agents yet" desc={`Add the ${preset} (the default team in Settings, General), or add a file to .claude/agents`}>
            <Button busy={busy === 'seed'} busyLabel="Adding" disabled={busy !== null} onClick={() => void seed()}>Add the team</Button>
          </Row>
        )}
        {team.map((a) => (
          <Row key={a.id} label={`${a.name} · ${a.role}`} desc={`${a.builtIn ? 'Built into Kernel' : `.claude/agents/${a.id}.md`}${a.description ? ` · ${a.description}` : ''}`}>
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
