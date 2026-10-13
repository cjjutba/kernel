import { call } from '../../api'
import { actions, getState } from '../../store'

/**
 * Retires an agent and drops it from the room's list. When the window is on that agent's editor in Settings, it goes back to the room's
 * Agents list, where the agent now sits under Retired. The dialog does this, not the editor, because the editor can't tell a retire from
 * any other change to the list.
 */
export async function retireAgent(roomId: string, agentId: string): Promise<void> {
  await call('agents.retire', { roomId, agentId })
  actions.agents.set(roomId, (getState().agents[roomId] ?? []).filter((a) => a.id !== agentId))
  const { route } = getState().ui
  if (route.name === 'settings' && route.page === 'room' && route.roomId === roomId && route.section === 'agents' && route.agentId === agentId) {
    actions.ui.go({ name: 'settings', page: 'room', roomId, section: 'agents' })
  }
  actions.ui.closeModal()
}
