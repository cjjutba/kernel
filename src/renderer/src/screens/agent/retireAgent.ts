import { call } from '../../api'
import { actions, getState } from '../../store'

/**
 * Retires an agent and drops it from the project's list. When the window is on that agent's editor in Settings, it goes back to the project's
 * Agents list, where the agent now sits under Retired. The dialog does this, not the editor, because the editor can't tell a retire from
 * any other change to the list.
 */
export async function retireAgent(projectId: string, agentId: string): Promise<void> {
  await call('agents.retire', { projectId, agentId })
  actions.agents.set(projectId, (getState().agents[projectId] ?? []).filter((a) => a.id !== agentId))
  const { route } = getState().ui
  if (route.name === 'settings' && route.page === 'project' && route.projectId === projectId && route.section === 'agents' && route.agentId === agentId) {
    actions.ui.go({ name: 'settings', page: 'project', projectId, section: 'agents' })
  }
  actions.ui.closeModal()
}
