import { useState } from 'react'
import { call, cleanError } from '../../api'
import { actions, getState, useStore } from '../../store'
import { Checkbox, ConfirmDialog, Icon, useBusy } from '../../ui'
import { afterProjectLeaves } from './afterProjectLeaves'
import { tilde } from './draft'
import './projects.css'

/** ConfirmRemoveProject.png. Archives the project's workspaces, then removes Kernel's record of the project. The repo, its folder and .claude/agents stay. */
export function ConfirmRemoveProject({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects.find((r) => r.id === projectId))
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
  // Where its worktrees live: the project's own folder under the worktree root, as the engine names it.
  const dir = project.worktreeDir ?? (project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace')
  const where = `${tilde(root ?? '~/kernel/worktrees')}/${dir}`

  return (
    <ConfirmDialog
      title={`Remove ${project.name} from Kernel?`} danger busy={!!busy} busyPattern="ripple" busyLabel="Removing" confirmLabel="Remove project" onConfirm={() => void remove()} onCancel={cancel}
      body="Kernel forgets the project, its chats and its settings. The repository and its folder on your Mac stay as they are."
    >
      {workspaces > 0 && <div className="rm-box"><Icon name="branch" size={14} /><span>{workspaces} {workspaces === 1 ? 'workspace is' : 'workspaces are'} open. Kernel archives {workspaces === 1 ? 'it' : 'them'} first.</span></div>}
      <Checkbox checked={worktrees} onChange={setWorktrees}>Also delete its worktrees in {where}</Checkbox>
      {error && <p role="alert" className="del">{error}</p>}
    </ConfirmDialog>
  )
}
