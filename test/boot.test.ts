import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { actions, boot, getState } from '../src/renderer/src/store'
import type { PreflightCheck, Room } from '../src/shared/types'

const room = { id: 'r1', name: 'r1', path: '/r/r1', defaultBranch: 'main', paused: false, createdAt: 1 } as Room
const portTaken: PreflightCheck = { id: 'hooks', ok: false, blocking: true, title: 'Port 7420 is taken', detail: 'Another process is using it.' }

/** Boots against a fake main process. The checks answer when `finishChecks` is called, like a slow Mac. */
async function bootWith(checks: PreflightCheck[]) {
  let finishChecks = () => undefined as void
  const gate = new Promise<void>((resolve) => { finishChecks = resolve })
  const answers: Record<string, unknown> = {
    'rooms.list': [room], 'workspaces.list': [], 'approvals.list': [], 'notifications.list': [], 'activity.recent': [], 'usage.get': [],
    'settings.get': DEFAULT_SETTINGS('/Users/you'), 'system.fixture': null, 'shared.list': [], 'threads.list': [], 'agents.list': [], 'agents.status': {}, 'tasks.list': [],
    'rooms.lastActivity': null, 'rooms.overlaps': [], 'account.get': null, 'hooks.status': null, 'update.get': null
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
  actions.ui.go({ name: 'home' })
  actions.ui.closeModal()
  getState().ui.toasts.forEach((t) => actions.ui.dismissToast(t.id))
})

describe('boot and a blocking check that fails late', () => {
  it('opens the app before the checks answer, then moves to Checks if nothing else is going on', async () => {
    const finishChecks = await bootWith([portTaken])
    expect(getState().system.booted).toBe(true)
    expect(getState().ui.route).toEqual({ name: 'home' })
    finishChecks()
    await settle()
    expect(getState().ui.route).toEqual({ name: 'onboarding', step: 'checks' })
  })

  it('leaves an open modal and the route alone, and says what failed in a toast', async () => {
    const finishChecks = await bootWith([portTaken])
    actions.ui.openModal({ name: 'checkHooks' })
    finishChecks()
    await settle()
    expect(getState().ui.route).toEqual({ name: 'home' })
    expect(getState().ui.modal).toEqual({ name: 'checkHooks' })
    expect(getState().ui.toasts.map((t) => t.title)).toEqual(['Port 7420 is taken'])
  })

  it('leaves the route alone after you moved on, with a toast', async () => {
    const finishChecks = await bootWith([portTaken])
    actions.ui.go({ name: 'inbox' })
    finishChecks()
    await settle()
    expect(getState().ui.route).toEqual({ name: 'inbox' })
    expect(getState().ui.toasts).toHaveLength(1)
  })
})
