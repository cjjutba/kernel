import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { actions, boot, getState } from '../src/renderer/src/store'
import type { PreflightCheck, Project } from '../src/shared/types'

const project = { id: 'r1', name: 'r1', path: '/r/r1', defaultBranch: 'main', paused: false, createdAt: 1 } as Project
/** A launch with no saved place opens the project's front door, here its Agents page, since the fake project has no Lead. */
const opened = { name: 'settings', page: 'project', projectId: 'r1', section: 'agents' }
const portTaken: PreflightCheck = { id: 'hooks', ok: false, blocking: true, title: 'Port 7420 is taken', detail: 'Another process is using it.' }

/** Boots against a fake main process. The checks answer when `finishChecks` is called, like a slow Mac. */
async function bootWith(checks: PreflightCheck[]) {
  let finishChecks = () => undefined as void
  const gate = new Promise<void>((resolve) => { finishChecks = resolve })
  const answers: Record<string, unknown> = {
    'projects.list': [project], 'workspaces.list': [], 'approvals.list': [], 'notifications.list': [], 'activity.recent': [], 'usage.get': [],
    'settings.get': DEFAULT_SETTINGS('/Users/you'), 'system.fixture': null, 'shared.list': [], 'threads.list': [], 'agents.list': [], 'agents.status': {}, 'tasks.list': [],
    'projects.lastActivity': null, 'projects.overlaps': [], 'account.get': null, 'hooks.status': null, 'update.get': null
  }
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  vi.stubGlobal('window', {
    kernel: {
      on: () => () => undefined,
      invoke: async (channel: string) => {
        if (channel === 'preflight.run') { await gate; return checks }
        return answers[channel] ?? null
      }
    }
  })
  await boot()
  return finishChecks
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  actions.ui.go({ name: 'inbox' })
  actions.ui.closeModal()
  getState().ui.toasts.forEach((t) => actions.ui.dismissToast(t.id))
})

describe('boot and a blocking check that fails late (KERNEL-942)', () => {
  it('opens the app before the checks answer, and never moves to a checks screen', async () => {
    const finishChecks = await bootWith([portTaken])
    expect(getState().system.booted).toBe(true)
    expect(getState().ui.route).toEqual(opened)
    finishChecks()
    await settle()
    expect(getState().ui.route).toEqual(opened)
    expect(getState().system.preflight).toEqual([portTaken])
    expect(getState().ui.toasts.map((t) => t.title)).toEqual(['Port 7420 is taken'])
  })

  it('leaves an open modal alone', async () => {
    const finishChecks = await bootWith([portTaken])
    actions.ui.openModal({ name: 'checkHooks' })
    finishChecks()
    await settle()
    expect(getState().ui.route).toEqual(opened)
    expect(getState().ui.modal).toEqual({ name: 'checkHooks' })
  })

  it('says nothing in a toast on New chat, where the line above the box shows the check', async () => {
    const finishChecks = await bootWith([portTaken])
    actions.ui.go({ name: 'leadNew', projectId: 'r1' })
    finishChecks()
    await settle()
    expect(getState().ui.toasts).toHaveLength(0)
  })
})
