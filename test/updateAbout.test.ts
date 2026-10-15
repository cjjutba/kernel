import { describe, expect, it } from 'vitest'
import type { AppUpdate } from '@shared/types'
import { state } from '../src/renderer/src/screens/settings/pages/About'
import { downloadPercent, updateFailed, updateReason } from '../src/renderer/src/components/footer/updateModel'

const u = (o: Partial<AppUpdate>): AppUpdate => ({ status: 'idle', current: '0.1.0', ...o })

describe('the update words follow each pushed state (KERNEL-864)', () => {
  it('moves from a percentage to ready or to the reason it failed', () => {
    expect(state(u({ status: 'downloading', version: '0.2.0', progress: 42 }))).toBe('Downloading version 0.2.0, 42%')
    expect(state(u({ status: 'downloading', version: '0.2.0', progress: 80 }))).toBe('Downloading version 0.2.0, 80%')
    expect(state(u({ status: 'ready', version: '0.2.0' }))).toBe('Version 0.2.0 is ready')
    expect(state(u({ error: 'net::ERR_INTERNET_DISCONNECTED' }))).toBe('No internet connection')
  })

  it('counts an idle state with an error as failed, and a download or ready update as not', () => {
    expect(updateFailed(u({ error: 'boom' }))).toBe(true)
    expect(updateFailed(u({ status: 'downloading', error: 'boom' }))).toBe(false)
    expect(updateFailed(u({ status: 'ready' }))).toBe(false)
    expect(downloadPercent(u({ progress: 140 }))).toBe(100)
    expect(updateReason('x', false)).toBe('No internet connection')
    expect(updateReason('x')).toBe('Could not check for updates')
  })
})
