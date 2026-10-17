import { useEffect, useRef, useState } from 'react'
import type { AgentDef, AppSettings, LeadMode, TeamPatch, TeammatesRunIn } from '@shared/types'
import { KERNEL_LEAD, reviewerChoice } from '@shared/team'
import { leadModeName, newChatLeadMode } from '@shared/leadMode'
import { call, cleanError } from '../../../api'
import { actions, go, loadProject, useStore } from '../../../store'
import { KernelMark } from '../../../icons'
import { Button, ConfirmDialog, Icon, Menu, Select, Toggle, useBusy } from '../../../ui'
import { ReviewerPicker } from '../../projects/ReviewerPicker'
import './projects.css'
import { shortFile, warningText } from '../../agent/model'
import { STARTER_TEAMMATES } from '../../projects/draft'
import { NoProject, Row, ProjectPage, projectValue, Section, SettingsLink, useProjectPage } from '../kit'
import { patchProjectSettings } from '../useSettings'
import { agentGroup, cleanDescription, shownRole } from './agentRows'
import { RUN_IN_NAMES } from './runIn'
import { TERMINAL_SEATS_IN_APP } from '../../../seats'
import { TeamPermissions } from './TeamPermissions'
import { TeamSkills } from './TeamSkills'

const NO_AGENTS: AgentDef[] = []

/** The open-workspace choices: the app's number first, then 1 to 8, a saved number outside them, and No limit (KERNEL-493). */
function openWorkspaceOptions(saved: number | undefined, appLimit: number) {
  const counts = [...new Set([1, 2, 3, 4, 5, 6, 7, 8, ...(saved ? [saved] : []), ...(appLimit > 0 ? [appLimit] : [])])].sort((a, b) => a - b)
  return [
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
 * Settings > a project > Agents (MorePage projectAgents, KERNEL-680): who leads and reviews, the project's agent files with a takes-tasks switch on each,
 * how many workspaces the Lead keeps open, and Retired. Permissions, Skills and MCP servers follow them (KERNEL-914). Edit opens the agent's editor (KERNEL-397, KERNEL-641). A change to roles or switches
 * goes to `[team]` in the shared settings.toml, and the open-workspaces cap to the personal file (KERNEL-493). Your own and plugin agents are
 * listed on Settings, Agents, not here.
 */
export function Team({ projectId, s }: { projectId?: string; s: AppSettings }) {
  const { project, rs } = useProjectPage(projectId)
  const agents = useStore((x) => (projectId ? x.agents[projectId] ?? NO_AGENTS : NO_AGENTS))
  const [busy, run] = useBusy()
  const [retired, setRetired] = useState<AgentDef[]>(NO_AGENTS)
  const [adding, setAdding] = useState(false)
  const [copying, setCopying] = useState(false)
  const [resetting, setResetting] = useState(false)
  const starterAnchor = useRef<HTMLSpanElement>(null)
  const copyAnchor = useRef<HTMLSpanElement>(null)
  // Other projects that are not archived and have an agent that is not retired: the ones this project can copy from.
  const sources = useStore((x) => x.projects.filter((r) => r.id !== projectId && !r.archived && (x.agents[r.id] ?? NO_AGENTS).some((a) => !a.retired)))
  useEffect(() => { if (projectId) void loadProject(projectId) }, [projectId])
  // Retired agents sit in .claude/retired-agents (D-003). The list is read again when the team changes, so a retire shows here at once.
  useEffect(() => {
    if (projectId) void call('agents.list', { projectId, retired: true }).then(setRetired).catch(() => setRetired(NO_AGENTS))
  }, [projectId, agents])
  if (!project || !projectId) return <NoProject />
  const team = agents.filter((a) => !a.retired)
  const files = team.filter((a) => !a.builtIn)
  const lead = team.find((a) => a.lead)
  const preset = s.team.defaultTemplate === 'pair' ? 'pair' : 'starter team'
  const seed = () => run('seed', async () => {
    try {
      const list = await call('agents.seed', { projectId, template: { kind: s.team.defaultTemplate } })
      actions.agents.set(projectId, list)
    } catch (e) { actions.ui.toast({ title: 'Could not add the team', sub: cleanError(e) }) }
  })
  const copyFrom = (fromProjectId: string) => run('copy', async () => {
    try {
      await call('agents.seed', { projectId, template: { kind: 'copy', fromProjectId } })
      await loadProject(projectId)
    } catch (e) { actions.ui.toast({ title: 'Could not copy the team', sub: cleanError(e) }) }
  })
  const hire = () => actions.ui.openModal({ name: 'newAgent', projectId, step: 'describe' })
  const starters = STARTER_TEAMMATES.filter((m) => !team.some((a) => a.id === m.id))
  const addStarter = (id: string) => run('starter', async () => {
    try { await call('agents.addStarter', { projectId, id }) } catch (e) { actions.ui.toast({ title: 'Could not add the agent', sub: cleanError(e) }) }
  })
  const restore = (a: AgentDef) => run(a.id, async () => {
    try {
      const def = await call('agents.restore', { projectId, agentId: a.id })
      actions.agents.set(projectId, [...team.filter((x) => x.id !== def.id), def])
      setRetired((r) => r.filter((x) => x.id !== a.id))
    } catch (e) { actions.ui.toast({ title: 'Could not restore', sub: cleanError(e) }) }
  })
  const setTeam = (key: string, patch: TeamPatch) => run(key, async () => {
    try {
      actions.agents.set(projectId, await call('agents.setTeam', { projectId, team: patch, from: 'settings' }))
      actions.settings.setProject(projectId, await call('settings.project', { projectId }))
    } catch (e) { actions.ui.toast({ title: 'Could not change the team', sub: cleanError(e) }) }
  })
  // The switches list every agent that takes tasks. Main keeps only the ones that differ from what their tools say.
  const takesTasks = (a: AgentDef, on: boolean) => {
    const others = files.filter((x) => !x.lead && x.id !== a.id)
    const members = [...others.filter((x) => x.member).map((x) => x.id), ...(on ? [a.id] : [])]
    return setTeam(a.id, { members, helpers: [...others.filter((x) => !x.member).map((x) => x.id), ...(on ? [] : [a.id])] })
  }
  const customized = !!lead?.file
  const leadFile = lead?.file ? lead.file.split(/[\\/]/).pop() ?? '' : ''
  const elsewhere = !!leadFile && leadFile !== 'kernel.md'
  const customize = () => run('customize', async () => {
    try {
      const def = await call('agents.customize', { projectId, agentId: lead?.id ?? KERNEL_LEAD })
      actions.ui.toast({ title: `Kernel is in ${shortFile(def.file)} now`, sub: 'Edit it like any agent.' })
      await loadProject(projectId)
    } catch (e) { actions.ui.toast({ title: 'Could not customize Kernel', sub: cleanError(e) }) }
  })
  const openFile = () => lead?.file && void call('system.openInEditor', { path: lead.file }).catch((e) => actions.ui.toast({ title: 'Could not open the file', sub: cleanError(e) }))
  const reset = () => run('reset', async () => {
    try {
      actions.agents.set(projectId, await call('agents.resetLead', { projectId }))
      setResetting(false)
    } catch (e) { actions.ui.toast({ title: 'Could not reset Kernel', sub: cleanError(e) }) }
  })
  const move = () => run('move', async () => {
    try {
      actions.agents.set(projectId, await call('agents.moveLead', { projectId }))
      actions.ui.toast({ title: 'Kernel is in kernel.md now' })
    } catch (e) { actions.ui.toast({ title: 'Could not move Kernel’s file', sub: cleanError(e) }) }
  })
  const reviewerPick = reviewerChoice(team, rs?.team)
  const repoAgents = team.filter((a) => agentGroup(a) === 'repo' && a.builtIn !== 'lead')
  const outside = team.filter((a) => a.builtIn !== 'lead').length - repoAgents.length
  const repoActions = (
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
  const edit = (a: AgentDef) => <Button aria-label={`Edit ${a.name}`} onClick={() => go({ name: 'settings', page: 'project', projectId, section: 'agents', agentId: a.id })}>Edit</Button>
  const agentRow = (a: AgentDef) => {
    const reviewsOnly = a.id === reviewerPick && !a.member && !a.lead
    return (
      <Row key={a.id} lead={<span className="rm-avatar" aria-hidden="true">{a.name.charAt(0)}</span>} label={<>{a.name}{shownRole(a) && <span className="rm-role">{shownRole(a)}</span>}</>} desc={rowDesc(a)}>
        {a.lead
          ? <span className="set-desc">Hands out tasks</span>
          : reviewsOnly
            ? <span className="set-desc">Reviews only</span>
            : <Toggle label={`${a.name} takes tasks`} checked={!!a.member} disabled={busy !== null} onChange={(on) => void takesTasks(a, on)} />}
        {edit(a)}
      </Row>
    )
  }
  return (
    <ProjectPage project={project} rs={rs} title="Agents" shared>
      <Section title="Roles">
        <Row id="lead" lead={<span className="rm-avatar" aria-hidden="true"><KernelMark size={14} /></span>} label="Kernel" labelId="rm-lead" className="rm-kernel" desc="Plans with you and hands out tasks.">
        <span className="set-actions">
          <span className="set-desc" role="status">{elsewhere ? `Customized in ${leadFile}` : customized ? 'Customized' : 'Default'}</span>
          {elsewhere
            ? <><Button disabled={busy !== null} onClick={openFile}>Open file</Button><Button busy={busy === 'move'} busyLabel="Moving" disabled={busy !== null} onClick={() => void move()}>Move to kernel.md</Button></>
            : customized
            ? <><Button disabled={busy !== null} onClick={openFile}>Open file</Button><Button disabled={busy !== null} onClick={() => setResetting(true)}>Reset to default</Button></>
            : <Button busy={busy === 'customize'} busyLabel="Copying" disabled={busy !== null} onClick={() => void customize()}>Customize</Button>}
        </span>
        </Row>
        <Row id="lead-mode" setting="agents.leadMode" label="New chats with Kernel" labelId="rm-lead-mode" desc="Overrides Settings, Agents for this project.">
          <Select label="New chats with Kernel" align="right" value={rs?.agents?.leadMode ?? 'app'} disabled={busy !== null} options={[
            { value: 'app', label: `App default (${leadModeName(newChatLeadMode({ team: { leadMode: s.team.leadMode } }, undefined))})` },
            { value: 'handoff', label: leadModeName('handoff') },
            { value: 'build', label: leadModeName('build') }
          ]} onChange={(v) => void patchProjectSettings(projectId, { agents: { leadMode: v === 'app' ? null : (v as LeadMode) } })} />
        </Row>
        {TERMINAL_SEATS_IN_APP && <Row id="teammates-run-in" setting="terminal.teammatesRunIn" label="Teammates run in" labelId="rm-teammates-run-in" desc="Overrides Settings, Big terminal for this project.">
          <Select label="Teammates run in" align="right" value={rs?.terminal?.teammatesRunIn ?? 'app'} disabled={busy !== null} options={[
            { value: 'app', label: `Use app setting (${RUN_IN_NAMES[s.terminal.teammatesRunIn]})` },
            ...(Object.keys(RUN_IN_NAMES) as TeammatesRunIn[]).map((value) => ({ value, label: RUN_IN_NAMES[value] }))
          ]} onChange={(v) => void patchProjectSettings(projectId, { terminal: { teammatesRunIn: v === 'app' ? null : (v as TeammatesRunIn) } })} />
        </Row>}
        {!!files.length && (
          <Row id="reviewer" label="Reviewer" labelId="rm-reviewer" desc="Reviews each pull request.">
            <ReviewerPicker value={reviewerPick} agents={files.filter((a) => !a.lead)} disabled={busy !== null} labelledBy="rm-reviewer" onChange={(id) => void setTeam('reviewer', { reviewer: id })} />
          </Row>
        )}
      </Section>
      {files.length === 0 && (
        <Section title="In this repo">
          <Row label="No agents yet" desc={`Add the ${preset} (the default team in Settings, General), or add a file to .claude/agents.`}>
            <span className="set-actions">
              <Button busy={busy === 'seed'} busyLabel="Adding" disabled={busy !== null} onClick={() => void seed()}>Add the team</Button>
              {!!sources.length && (
                <span className="set-starters" ref={copyAnchor}>
                  <Button aria-haspopup="menu" aria-expanded={copying} busy={busy === 'copy'} busyLabel="Copying" disabled={busy !== null} onClick={() => setCopying((o) => !o)}>Copy from another project<Icon name="chevron" size={12} /></Button>
                  {copying && <Menu label="Copy from another project" anchorRef={copyAnchor} onClose={() => setCopying(false)} style={{ right: 0, top: 34, width: 220 }} items={sources.map((r) => ({ id: r.id, label: r.name, onSelect: () => { setCopying(false); void copyFrom(r.id) } }))} />}
                </span>
              )}
              <Button variant="primary" icon="plus" disabled={busy !== null} onClick={hire}>New agent</Button>
            </span>
          </Row>
        </Section>
      )}
      {repoAgents.length > 0 && (
        <Section
          title="In this repo" count={repoAgents.length} note="Switches pick who takes tasks." action={repoActions}
          footnote={outside > 0 ? <>Your own and plugin agents are on <SettingsLink to={{ page: 'agents' }}>Settings, Agents</SettingsLink>.</> : undefined}
        >
          {repoAgents.map(agentRow)}
        </Section>
      )}
      {!!files.length && (
        <Section label="Limits">
          <Row id="open-workspaces" label="Open workspaces" {...projectValue(rs, 'agents.openWorkspaces', () => void patchProjectSettings(projectId, { agents: { openWorkspaces: null } }), { to: { page: 'models' }, label: 'Settings, Models and effort' })} desc={`Workspaces ${lead?.name ?? 'Kernel'} keeps open here. Reviews don’t count.`}>
            <Select label="Open workspaces" align="right" value={String(rs?.agents?.openWorkspaces ?? s.models.agentLimit)} disabled={busy !== null} options={openWorkspaceOptions(rs?.agents?.openWorkspaces, s.models.agentLimit)} onChange={(v) => void patchProjectSettings(projectId, { agents: { openWorkspaces: Number(v) } })} />
          </Row>
        </Section>
      )}
      <TeamPermissions projectId={projectId} />
      <TeamSkills projectId={projectId} rs={rs} />
      {!!retired.length && (
        <Section title="Retired" count={retired.length} collapsible>
          {retired.map((a) => (
            <Row key={a.id} lead={<span className="rm-avatar" aria-hidden="true">{a.name.charAt(0)}</span>} label={<>{a.name}{a.role.trim() && <span className="rm-role">{a.role}</span>}</>} desc={`Kept in ${shortFile(a.file)}.`}>
              <Button aria-label={`Restore ${a.name}`} busy={busy === a.id} busyPattern="wave-back" busyLabel="Restoring" disabled={busy !== null} onClick={() => void restore(a)}>Restore</Button>
            </Row>
          ))}
        </Section>
      )}
      {resetting && (
        <ConfirmDialog
          title="Reset Kernel to default?" body={<>This deletes <span className="mono">{lead?.file ? shortFile(lead.file) : '.claude/agents/kernel.md'}</span>. Kernel goes back to the instructions it ships with.</>}
          confirmLabel="Reset to default" danger busy={busy === 'reset'} busyPattern="wave-back" busyLabel="Resetting" onConfirm={() => void reset()} onCancel={() => setResetting(false)}
        />
      )}
    </ProjectPage>
  )
}
