import { describe, expect, it, vi } from 'vitest'
import type { AppUpdate } from '@shared/types'
import { state } from '../src/renderer/src/screens/settings/pages/About'
import { downloadPercent, installFailedToast, updateFailed, updateReason } from '../src/renderer/src/components/footer/updateModel'

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

describe('an update that could not install (KERNEL-1021)', () => {
  const failed = (reason: 'signature' | 'other') => u({ installFailed: { version: '0.6.0', reason } })

  it('names the version in the header and the reason for each kind', () => {
    expect(state(failed('signature'))).toBe("Version 0.6.0 couldn't install")
    expect(state(failed('other'))).toBe("Version 0.6.0 couldn't install")
    expect(updateReason(undefined, true, failed('signature').installFailed)).toBe("This copy of Kernel can't install updates. Download the latest version from GitHub.")
    expect(updateReason(undefined, true, failed('other').installFailed)).toBe('Kernel will try again later')
  })

  it('gives way to a newer update that is ready or downloading', () => {
    const f = { installFailed: { version: '0.6.0', reason: 'other' } as const }
    expect(state(u({ ...f, status: 'ready', version: '0.7.0' }))).toBe('Version 0.7.0 is ready')
    expect(state(u({ ...f, status: 'downloading', version: '0.7.0', progress: 10 }))).toBe('Downloading version 0.7.0, 10%')
  })

  it('toasts once per failure', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
    expect(installFailedToast(failed('other'))).toEqual({ title: "Version 0.6.0 couldn't install", sub: 'Kernel will try again later' })
    expect(installFailedToast(failed('other'))).toBeNull()
    expect(installFailedToast(u({}))).toBeNull()
    vi.unstubAllGlobals()
  })
})
