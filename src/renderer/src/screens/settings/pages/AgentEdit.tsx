import { useEffect, useState } from 'react'
import type { AgentDef, AgentScope } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, go, loadProject, useStore } from '../../../store'
import { Button, Icon, useBusy } from '../../../ui'
import { AgentFields, editOf, useAgentForm, useSkillNames } from '../../agent/AgentEditor'
import { shortFile } from '../../agent/model'
import { Page, SettingsLink } from '../kit'
import { AgentSaveScope } from './AgentSaveScope'
import { agentSource, pluginOf } from './agentRows'

const NO_AGENTS: AgentDef[] = []

/**
 * Settings > Agents > one agent (KERNEL-641): only the editor, with no status, workspace or recent work. A project's agent saves through
 * `agents.save`, and asks who gets the change when it is a file in the repo. A personal agent opened from the app's list saves through
 * `agents.saveGlobal`. A plugin's agent reads only. Kernel's own Lead and reviewer keep Customize.
 */
export function AgentEdit({ projectId, agentId }: { projectId?: string; agentId: string }) {
  const project = useStore((s) => s.projects.find((r) => r.id === projectId))
  const projectAgents = useStore((s) => (projectId ? s.agents[projectId] : undefined))
  const globals = useStore((s) => s.globalAgents)
  const list = projectId ? projectAgents : globals
  useEffect(() => {
    if (projectId) void loadProject(projectId)
    else void call('agents.listGlobal', {}).then(actions.agents.setGlobal).catch(() => undefined)
  }, [projectId])
  const agent = (list ?? NO_AGENTS).find((a) => a.id === agentId && !a.retired)
  const { form, set, saved, adopt, dirty } = useAgentForm(agent)
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const skillNames = useSkillNames(projectId)
  const listRoute = projectId ? { name: 'settings' as const, page: 'project' as const, projectId, section: 'agents' as const } : { name: 'settings' as const, page: 'agents' as const }
  const back = (
    <button type="button" className="set-agent-back" onClick={() => go(listRoute)}>
      <Icon name="left" size={14} />{project ? `${project.name} / Agents` : 'Agents'}
    </button>
  )
  if (!list) return <Page title={agentId} back={back}>{null}</Page>
  if (!agent || !form) {
    return (
      <Page title={agentId} back={back}>
        <p className="set-note">{projectId ? `${agentId} is not on this team. They may have been retired, or the file was renamed.` : `${agentId} is not in ~/.claude/agents or a plugin. The file may have been renamed or removed.`}</p>
        <div><Button onClick={() => go(listRoute)}>{projectId ? 'Back to the project’s agents' : 'Back to agents'}</Button></div>
      </Page>
    )
  }

  const builtIn = !!agent.builtIn && !agent.file
  const plugin = agent.origin === 'plugin'
  // A file in the repo can go to the team as a pull request. A personal agent's file is the user's own, so it has no such choice.
  const asksScope = !!projectId && !builtIn && !plugin && agent.origin !== 'personal'
  const save = (scope?: AgentScope) => run('save', async () => {
    setError(null)
    try {
      const patch = editOf(form)
      if (!projectId) {
        const def = await call('agents.saveGlobal', { agentId: agent.id, patch })
        actions.agents.setGlobal((globals ?? NO_AGENTS).map((a) => (a.id === def.id ? { ...a, ...def } : a)))
        adopt(def)
      } else {
        const def = await call('agents.save', { projectId, agentId: agent.id, patch, ...(scope ? { scope } : {}) })
        if (def.pr) {
          actions.ui.toast({ title: `Pull request opened for ${agent.name}`, sub: def.pr.error ?? 'Everyone gets the change once it merges.' })
        } else {
          actions.agents.set(projectId, (projectAgents ?? NO_AGENTS).map((a) => (a.id === def.id ? { ...a, ...def } : a)))
          adopt(def)
        }
      }
      setAsking(false)
    } catch (e) { setError(cleanError(e)) }
  })
  const retire = () => actions.ui.openModal({ name: 'confirm', kind: 'retire', projectId: projectId!, agentId: agent.id })
  const customize = () => run('customize', async () => {
    setError(null)
    try {
      const def = await call('agents.customize', { projectId: projectId!, agentId: agent.id })
      actions.ui.toast({ title: `${def.name} is in ${shortFile(def.file)} now`, sub: 'Edit it here like any agent.' })
      go({ name: 'settings', page: 'project', projectId, section: 'agents', agentId: def.id })
    } catch (e) { setError(cleanError(e)) }
  })

  const action = builtIn ? (
    <Button variant="primary" busy={busy === 'customize'} busyLabel="Copying" onClick={() => void customize()}>Customize</Button>
  ) : plugin ? undefined : (
    <div className="set-actions">
      {saved && !dirty && <span role="status" className="ap-save-note">Saved to {shortFile(agent.file)}</span>}
      {projectId && agent.lead && <span className="set-desc">{agent.name} leads this project. Pick another lead in <SettingsLink to={{ page: 'project', projectId, section: 'agents' }}>Settings, {project?.name ?? 'project'}, Agents</SettingsLink> first.</span>}
      {projectId && <Button variant="ghost" disabled={agent.lead || !!busy} onClick={retire}>Retire</Button>}
      <Button variant={dirty ? 'primary' : 'secondary'} busy={!asking && busy === 'save'} busyLabel="Saving" disabled={!dirty || !form.description.trim() || !!busy} onClick={() => (asksScope ? setAsking(true) : void save())}>Save changes</Button>
    </div>
  )
  const source = plugin ? `From the ${pluginOf(agent)} plugin. Kernel doesn’t change a plugin’s files.` : agentSource(agent)
  return (
    <Page title={agent.name} back={back} action={action}>
      <p className="set-desc">{source}</p>
      <form className="ae-form" onSubmit={(e) => { e.preventDefault(); if (dirty && !builtIn && !plugin && form.description.trim() && !busy) { if (asksScope) setAsking(true); else void save() } }}>
        <AgentFields agent={agent} form={form} set={set} skillNames={skillNames} readOnly={plugin} noSkillsHint={projectId ? undefined : 'No skills found.'} />
        {error && !asking && <p role="alert" className="ae-error">{error}</p>}
      </form>
      {asking && <AgentSaveScope agent={agent} form={form} busy={busy === 'save'} error={error} onCancel={() => { setAsking(false); setError(null) }} onSave={(scope) => void save(scope)} />}
    </Page>
  )
}
