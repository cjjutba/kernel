import { describe, expect, it, vi } from 'vitest'
import type { AppUpdate } from '@shared/types'
import { aboutView } from '../src/renderer/src/screens/settings/pages/About'
import { RELEASES_URL, downloadPercent, installFailedToast, updateFailed, updateReason } from '../src/renderer/src/components/footer/updateModel'

const u = (o: Partial<AppUpdate>): AppUpdate => ({ status: 'idle', current: '0.1.0', ...o })

describe('the Version card follows each pushed state (KERNEL-864, Redesign 15)', () => {
  it('moves from a percentage to ready or to the reason it failed', () => {
    expect(aboutView(u({ status: 'downloading', version: '0.2.0', progress: 42 }))).toEqual({ line: 'Downloading Kernel 0.2.0', progress: 42, action: 'none' })
    expect(aboutView(u({ status: 'downloading', version: '0.2.0', progress: 80 })).progress).toBe(80)
    expect(aboutView(u({ status: 'ready', version: '0.2.0' }))).toEqual({ line: 'Kernel 0.2.0 is ready', action: 'restart' })
    expect(aboutView(u({ error: 'net::ERR_INTERNET_DISCONNECTED' }))).toEqual({ line: 'No internet connection', action: 'again' })
    expect(aboutView(u({ status: 'checking' }))).toEqual({ line: 'Checking for updates', tone: 'checking', action: 'check' })
    expect(aboutView(u({}))).toEqual({ line: 'Kernel is up to date', tone: 'ok', action: 'check' })
    expect(aboutView(u({ blocked: 'Move Kernel to Applications to update.' }))).toEqual({ line: 'Move Kernel to Applications to update.', action: 'none' })
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

  it('names the version in the card and the answer for each kind', () => {
    expect(aboutView(failed('signature'))).toEqual({ line: 'Kernel 0.6.0 is available', action: 'download' })
    expect(aboutView(failed('other'))).toEqual({ line: 'Kernel 0.6.0 is available', action: 'install' })
    expect(updateReason(undefined, true, failed('signature').installFailed)).toBe("The download's signature didn't match, so Kernel skips it.")
    expect(updateReason(undefined, true, failed('other').installFailed)).toBe('Kernel will try again later.')
  })

  it('gives way to a newer update that is ready or downloading', () => {
    const f = { installFailed: { version: '0.6.0', reason: 'other' } as const }
    expect(aboutView(u({ ...f, status: 'ready', version: '0.7.0' })).line).toBe('Kernel 0.7.0 is ready')
    expect(aboutView(u({ ...f, status: 'downloading', version: '0.7.0', progress: 10 })).progress).toBe(10)
  })

  it('toasts once per failure, with the way to fix it', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
    expect(installFailedToast(failed('other'))).toEqual({ title: "Couldn't install Kernel 0.6.0", sub: 'Kernel will try again later.', glyph: 'error', action: { label: 'Open About', route: { name: 'settings', page: 'about' }, primary: true } })
    expect(installFailedToast(failed('other'))).toBeNull()
    expect(installFailedToast(failed('signature'))?.action).toEqual({ label: 'Download again', href: RELEASES_URL, primary: true })
    expect(installFailedToast(u({}))).toBeNull()
    vi.unstubAllGlobals()
  })
})
