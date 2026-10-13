import { useEffect, useRef, useState } from 'react'
import type { AgentDef, AppSettings, TeamPatch } from '@shared/types'
import { KERNEL_LEAD, KERNEL_REVIEWER, NO_REVIEWER, reviewerChoice } from '@shared/team'
import { call, cleanError } from '../../../api'
import { actions, go, loadRoom, useStore } from '../../../store'
import { Button, Icon, Menu, Select, Toggle, useBusy } from '../../../ui'
import { shortFile, warningText } from '../../agent/model'
import { STARTER_TEAMMATES } from '../../rooms/draft'
import { NoRoom, Row, RoomPage, Section, sourceLine, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'
import { AGENT_GROUPS, agentGroup, agentLabel, agentSource, cleanDescription } from './agentRows'

const NO_AGENTS: AgentDef[] = []
const SAME_AS_APP = ''

/** The open-workspace choices: the app's number first, then 1 to 8, a saved number outside them, and No limit (KERNEL-493). */
function openWorkspaceOptions(saved: number | undefined, appLimit: number) {
  const counts = [...new Set([1, 2, 3, 4, 5, 6, 7, 8, ...(saved ? [saved] : [])])].sort((a, b) => a - b)
  return [
    { value: SAME_AS_APP, label: `Same as agents working at once (${appLimit > 0 ? appLimit : 'No limit'})` },
    ...counts.map((n) => ({ value: String(n), label: String(n) })),
    { value: '0', label: 'No limit' }
  ]
}

/** An agent's description, then what Kernel noticed in its file (KERNEL-397), one line each. */
function rowDesc(a: AgentDef) {
  if (!a.description && !a.warnings?.length) return undefined
  return (
    <>
      {a.description && <span className="set-clamp">{cleanDescription(a.description)}</span>}
      {a.warnings?.map((w, i) => <span key={i} className="set-warn"><Icon name="warning" size={12} />{warningText(w)}</span>)}
    </>
  )
}

/**
 * Settings > a room > Agents (SettingsTeam.png): who leads and who reviews, who takes tasks, and the room's agent files,
 * with Edit opening the agent's editor in Settings (KERNEL-397, KERNEL-641). It is the one place for agents (KERNEL-642): New agent, Add a
 * starter agent, warnings on a file Kernel can't read, and Retired with Restore are here too. A change goes to `[team]` in the shared settings.toml. The team a new room
 * starts with is on General. The Open workspaces row, under the switches, saves the room's own cap to its personal file (KERNEL-493).
 */
export function Team({ roomId, s }: { roomId?: string; s: AppSettings }) {
  const { room, rs } = useRoomPage(roomId)
  const agents = useStore((x) => (roomId ? x.agents[roomId] ?? NO_AGENTS : NO_AGENTS))
  const [busy, run] = useBusy()
  const [retired, setRetired] = useState<AgentDef[]>(NO_AGENTS)
  const [adding, setAdding] = useState(false)
  const [copying, setCopying] = useState(false)
  const starterAnchor = useRef<HTMLSpanElement>(null)
  const copyAnchor = useRef<HTMLSpanElement>(null)
  // Other rooms that are not archived and have an agent that is not retired: the ones this room can copy from.
  const sources = useStore((x) => x.rooms.filter((r) => r.id !== roomId && !r.archived && (x.agents[r.id] ?? NO_AGENTS).some((a) => !a.retired)))
  useEffect(() => { if (roomId) void loadRoom(roomId) }, [roomId])
  // Retired agents sit in .claude/retired-agents (D-003). The list is read again when the team changes, so a retire shows here at once.
  useEffect(() => {
    if (roomId) void call('agents.list', { roomId, retired: true }).then(setRetired).catch(() => setRetired(NO_AGENTS))
  }, [roomId, agents])
  if (!room || !roomId) return <NoRoom />
  const team = agents.filter((a) => !a.retired)
  const files = team.filter((a) => !a.builtIn)
  const lead = team.find((a) => a.lead)
  const preset = s.team.defaultTemplate === 'pair' ? 'pair' : 'starter team'
  const seed = () => run('seed', async () => {
    try {
      const list = await call('agents.seed', { roomId, template: { kind: s.team.defaultTemplate } })
      actions.agents.set(roomId, list)
    } catch (e) { actions.ui.toast({ title: 'Could not add the team', sub: cleanError(e) }) }
  })
  const copyFrom = (fromRoomId: string) => run('copy', async () => {
    try {
      await call('agents.seed', { roomId, template: { kind: 'copy', fromRoomId } })
      await loadRoom(roomId)
    } catch (e) { actions.ui.toast({ title: 'Could not copy the team', sub: cleanError(e) }) }
  })
  const hire = () => actions.ui.openModal({ name: 'newAgent', roomId, step: 'describe' })
  const starters = STARTER_TEAMMATES.filter((m) => !team.some((a) => a.id === m.id))
  const addStarter = (id: string) => run('starter', async () => {
    try { await call('agents.addStarter', { roomId, id }) } catch (e) { actions.ui.toast({ title: 'Could not add the agent', sub: cleanError(e) }) }
  })
  const restore = (a: AgentDef) => run(a.id, async () => {
    try {
      const def = await call('agents.restore', { roomId, agentId: a.id })
      actions.agents.set(roomId, [...team.filter((x) => x.id !== def.id), def])
      setRetired((r) => r.filter((x) => x.id !== a.id))
    } catch (e) { actions.ui.toast({ title: 'Could not restore', sub: cleanError(e) }) }
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
  const reviewerPick = reviewerChoice(team, rs?.team)
  const reviewerOptions = [...files.filter((a) => !a.lead).map((a) => ({ value: a.id, label: a.name })), { value: KERNEL_REVIEWER, label: 'Kernel’s code review' }, { value: NO_REVIEWER, label: 'No reviewer' }]
  return (
    <RoomPage room={room} rs={rs} title="Agents" intro="Every agent is a Claude Code subagent file in .claude/agents. Add a file, or ask Rowan to write one, and it joins the team.">
      {!!files.length && (
        <Section title="Who leads and reviews" note="A change is saved in settings.toml, so everyone on the repo gets it.">
          <Row label="Lead" source={sourceLine(rs, 'team.lead')} desc="Plans with you and hands out every task">
            <Select label="Lead" value={lead?.id ?? KERNEL_LEAD} disabled={busy !== null} options={leadOptions} onChange={(e) => void setTeam('lead', { lead: e.target.value })} />
          </Row>
          <Row label="Reviewer" source={sourceLine(rs, 'team.reviewer')} desc="Reviews each pull request before it merges">
            <Select label="Reviewer" value={reviewerPick} disabled={busy !== null} options={reviewerOptions} onChange={(e) => void setTeam('reviewer', { reviewer: e.target.value })} />
          </Row>
        </Section>
      )}
      {files.some((a) => !a.lead) && (
        <Section title="Who takes tasks" note={`${lead?.name ?? 'The Lead'} hands tasks only to these agents. One whose tools can’t edit files and run git starts off. These switches don’t change who reviews pull requests.`}>
          {files.filter((a) => !a.lead).map((a) => (
            <Row key={a.id} label={agentLabel(a)} desc={a.id === reviewerPick ? 'Reviews pull requests either way. Change that under Reviewer.' : undefined}>
              <Toggle label={`${a.name} takes tasks`} checked={!!a.member} disabled={busy !== null} onChange={(on) => void takesTasks(a, on)} />
            </Row>
          ))}
          <Row label="Open workspaces" source={sourceLine(rs, 'agents.openWorkspaces')} desc={`How many workspaces ${lead?.name ?? 'the Lead'} keeps open in this room at once. Reviews don’t count, workspaces you open yourself do.`}>
            <Select label="Open workspaces" value={rs?.agents?.openWorkspaces === undefined ? SAME_AS_APP : String(rs.agents.openWorkspaces)} disabled={busy !== null} options={openWorkspaceOptions(rs?.agents?.openWorkspaces, s.models.agentLimit)} onChange={(e) => void patchRoomSettings(roomId, { agents: { openWorkspaces: e.target.value === SAME_AS_APP ? null : Number(e.target.value) } })} />
          </Row>
        </Section>
      )}
      {files.length === 0 && (
        <Section title="In this room">
          <Row label="No agents yet" desc={`Add the ${preset} (the default team in Settings, General), or add a file to .claude/agents`}>
            <span className="set-actions">
              <Button busy={busy === 'seed'} busyLabel="Adding" disabled={busy !== null} onClick={() => void seed()}>Add the team</Button>
              {!!sources.length && (
                <span className="set-starters" ref={copyAnchor}>
                  <Button aria-haspopup="menu" aria-expanded={copying} busy={busy === 'copy'} busyLabel="Copying" disabled={busy !== null} onClick={() => setCopying((o) => !o)}>Copy from another room<Icon name="chevron" size={12} /></Button>
                  {copying && <Menu label="Copy from another room" anchorRef={copyAnchor} onClose={() => setCopying(false)} style={{ right: 0, top: 34, width: 220 }} items={sources.map((r) => ({ id: r.id, label: r.name, onSelect: () => { setCopying(false); void copyFrom(r.id) } }))} />}
                </span>
              )}
              <Button variant="primary" icon="plus" disabled={busy !== null} onClick={hire}>New agent</Button>
            </span>
          </Row>
        </Section>
      )}
      {AGENT_GROUPS.map(({ key, title }) => {
        const group = team.filter((a) => agentGroup(a) === key)
        if (!group.length) return null
        const repoActions = key === 'repo' && (
          <span className="set-actions">
            {!!files.length && !!starters.length && (
              <span className="set-starters" ref={starterAnchor}>
                <Button aria-haspopup="menu" aria-expanded={adding} busy={busy === 'starter'} busyLabel="Adding" disabled={busy !== null} onClick={() => setAdding((o) => !o)}>Add a starter agent<Icon name="chevron" size={12} /></Button>
                {adding && <Menu label="Starter agents" anchorRef={starterAnchor} onClose={() => setAdding(false)} style={{ right: 0, top: 34, width: 220 }} items={starters.map((m) => ({ id: m.id, label: `${m.name} · ${m.role}`, onSelect: () => { setAdding(false); void addStarter(m.id) } }))} />}
              </span>
            )}
            <Button variant="primary" icon="plus" disabled={busy !== null} onClick={hire}>New agent</Button>
          </span>
        )
        return (
          <Section key={key} title={title} action={repoActions || undefined}>
            {group.map((a) => (
              <Row key={a.id} label={agentLabel(a)} source={agentSource(a)} desc={rowDesc(a)}>
                <Button aria-label={`${key === 'plugin' ? 'View' : 'Edit'} ${a.name}`} onClick={() => go({ name: 'settings', page: 'room', roomId, section: 'agents', agentId: a.id })}>{key === 'plugin' ? 'View' : 'Edit'}</Button>
              </Row>
            ))}
          </Section>
        )
      })}
      {!!retired.length && (
        <Section title="Retired" note="A retired agent’s file sits in .claude/retired-agents. Restore brings it back.">
          {retired.map((a) => (
            <Row key={a.id} label={agentLabel(a)} source={shortFile(a.file)}>
              <Button aria-label={`Restore ${a.name}`} busy={busy === a.id} busyLabel="Restoring" disabled={busy !== null} onClick={() => void restore(a)}>Restore</Button>
            </Row>
          ))}
        </Section>
      )}
      <Section title="Sync">
        <Row label="Agents folder"><span className="set-value">.claude/agents</span></Row>
      </Section>
    </RoomPage>
  )
}
