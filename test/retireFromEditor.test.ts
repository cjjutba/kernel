import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Route } from '../src/shared/types'

// Retiring from the agent editor in Settings returns to the project's Agents list. The dialog does it after main answers, so the page needs no
// effect watching the list.
const calls: string[] = []
vi.mock('../src/renderer/src/api', () => ({
  cleanError: (e: unknown) => String(e),
  onPush: () => () => undefined,
  call: async (channel: string) => { calls.push(channel); return undefined }
}))

const { getState, setState } = await import('../src/renderer/src/store')
const { retireAgent } = await import('../src/renderer/src/screens/agent/retireAgent')

const agent = (id: string) => ({ id, name: id }) as AgentDef
const open = (route: Route) => setState((s) => ({ agents: { r1: [agent('christian'), agent('ana')] }, ui: { ...s.ui, route, modal: { name: 'confirm', kind: 'retire', projectId: 'r1', agentId: 'christian' } } }))

describe('retireAgent', () => {
  beforeEach(() => { calls.length = 0 })

  it('goes back to the project’s Agents list from that agent’s editor', async () => {
    open({ name: 'settings', page: 'project', projectId: 'r1', section: 'agents', agentId: 'christian' })
    await retireAgent('r1', 'christian')
    expect(calls).toEqual(['agents.retire'])
    expect(getState().ui.route).toEqual({ name: 'settings', page: 'project', projectId: 'r1', section: 'agents' })
    expect(getState().agents.r1.map((a) => a.id)).toEqual(['ana'])
    expect(getState().ui.modal).toBeNull()
  })

  it('leaves the route alone when the window is somewhere else or on another agent', async () => {
    const other: Route = { name: 'settings', page: 'project', projectId: 'r1', section: 'agents', agentId: 'ana' }
    open(other)
    await retireAgent('r1', 'christian')
    expect(getState().ui.route).toEqual(other)
    const elsewhere: Route = { name: 'settings', page: 'project', projectId: 'r1', section: 'agents' }
    open(elsewhere)
    await retireAgent('r1', 'christian')
    expect(getState().ui.route).toEqual(elsewhere)
  })
})
