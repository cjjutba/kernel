import { describe, expect, it } from 'vitest'
import type { AppUpdate } from '../src/shared/types'
import { whatsNewView } from '../src/renderer/src/screens/update/whatsNewView'

const running = [{ title: 'Fixed', body: 'Fixed the footer.' }]
const next = [{ title: 'Checkpoints', body: 'Every turn saves the worktree.' }]
const idle: AppUpdate = { status: 'idle', current: '0.1.1', currentNotes: running }

describe('whatsNewView (KERNEL-154)', () => {
  it('offers to restart only when an update has downloaded', () => {
    expect(whatsNewView({ ...idle, status: 'ready', version: '0.2.0', notes: next })).toEqual({ ready: true, title: 'Kernel 0.2 is ready', notes: next })
  })

  it('shows the running version\'s notes with Done when no update is ready', () => {
    for (const status of ['idle', 'checking', 'downloading', 'error'] as const) {
      expect(whatsNewView({ ...idle, status, version: status === 'downloading' ? '0.2.0' : undefined, notes: status === 'downloading' ? next : undefined }))
        .toEqual({ ready: false, title: "What's new in Kernel 0.1", notes: running })
    }
  })

  it('shows the installed version\'s notes once after an update', () => {
    expect(whatsNewView({ status: 'idle', current: '0.2.0', installed: true, version: '0.2.0', notes: next })).toEqual({ ready: false, title: "What's new in Kernel 0.2", notes: next })
  })

  it('still reads when there are no notes or no state yet', () => {
    expect(whatsNewView({ status: 'idle', current: '0.1.1' })).toEqual({ ready: false, title: "What's new in Kernel 0.1", notes: [] })
    expect(whatsNewView(undefined)).toEqual({ ready: false, title: "What's new in Kernel", notes: [] })
  })
})
