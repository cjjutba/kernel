import { useState } from 'react'
import { call, cleanError } from '../../api'
import { actions, getState, useStore } from '../../store'
import { Checkbox, ConfirmDialog, useBusy } from '../../ui'
import { afterProjectLeaves } from './afterProjectLeaves'
import { tilde } from './draft'
import { teamOf } from './projectInfo'
import './projects.css'

/** ConfirmRemoveProject.png. Archives the project's workspaces, then removes Kernel's record of the project. The folder on disk and .claude/agents stay. */
export function ConfirmRemoveProject({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects.find((r) => r.id === projectId))
  const agents = useStore((s) => teamOf(s.agents[projectId]).length)
  const workspaces = useStore((s) => s.workspaces.filter((w) => w.projectId === projectId && w.status !== 'archived' && !w.lead).length)
  const root = useStore((s) => s.settings?.worktreeRoot)
  const [worktrees, setWorktrees] = useState(false)
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  const cancel = actions.ui.closeModal
  if (!project) return null

  const remove = () => run('remove', async () => {
    setError(null)
    try {
      await call('projects.remove', { projectId, deleteWorktrees: worktrees })
      const route = getState().ui.route
      const here = ('projectId' in route && route.projectId === projectId) || (route.name === 'workspace' && getState().workspaces.find((w) => w.id === route.workspaceId)?.projectId === projectId)
      const next = afterProjectLeaves(getState().projects, projectId)
      actions.projects.remove(projectId)
      if (here) actions.ui.go(next)
      actions.ui.closeModal()
    } catch (e) { setError(cleanError(e)) }
  })
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`

  return (
    <ConfirmDialog
      title={`Remove ${project.name}?`} danger busy={!!busy} busyPattern="ripple" busyLabel="Removing" confirmLabel="Remove project" onConfirm={() => void remove()} onCancel={cancel}
      body={`Kernel stops ${n(agents, 'agent')} and archives ${n(workspaces, 'workspace')}. Your repo on disk and .claude/agents are not touched.`}
    >
      <div className="rm-box mono"><span>{tilde(project.path)}</span><span className="muted">{n(workspaces, 'workspace')} · {n(agents, 'agent')}</span></div>
      <Checkbox checked={worktrees} onChange={setWorktrees}>Also delete the worktrees in {root ? tilde(root) : '~/kernel/worktrees'}</Checkbox>
      {error && <p role="alert" className="del">{error}</p>}
    </ConfirmDialog>
  )
}
