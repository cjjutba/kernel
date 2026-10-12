import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageBoxOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { ASKED_FILE, isInstalledCopy, loginItemSettings, offerMove, runsFrom, type CopyInfo } from '../src/main/loginItem'
import { applySettingsPatch, DEFAULT_SETTINGS } from '../src/main/services/settings'

const home = '/Users/you'
const exe = (bundle: string) => `${bundle}/Contents/MacOS/Kernel`

describe('isInstalledCopy', () => {
  it.each([
    ['/Applications', exe('/Applications/Kernel.app'), true, true],
    ['~/Applications', exe('/Users/you/Applications/Kernel.app'), true, true],
    ['a dist/ build', exe('/Users/you/Projects/kernel/dist/mac-arm64/Kernel.app'), false, false],
    ['a translocated copy', exe('/private/var/folders/xy/T/AppTranslocation/3F2A/d/Kernel.app'), false, false],
    ['a prefix trap in /Applications', exe('/Applications/Kernel.app.bak'), true, false],
    ['a prefix trap in ~/Applications', exe('/Users/you/Applications/Kernel.app.bak'), true, false],
    ['another app in /Applications', exe('/Applications/Kernel Beta.app'), true, false],
    ["another user's ~/Applications", exe('/Users/someone/Applications/Kernel.app'), true, false]
  ])('%s', (_name, exePath, inApplicationsFolder, expected) => {
    expect(isInstalledCopy({ packaged: true, inApplicationsFolder, exePath, home })).toBe(expected)
  })

  it('is false for a dev run, wherever it sits', () => {
    expect(isInstalledCopy({ packaged: false, inApplicationsFolder: true, exePath: exe('/Applications/Kernel.app'), home })).toBe(false)
  })

  it('is false when Electron says the copy is not in an Applications folder', () => {
    expect(isInstalledCopy({ packaged: true, inApplicationsFolder: false, exePath: exe('/Applications/Kernel.app'), home })).toBe(false)
  })
})

describe('loginItemSettings', () => {
  const off = DEFAULT_SETTINGS(home)
  const on = applySettingsPatch(off, { general: { openAtLogin: true } })

  it('defaults to off for a new install', () => {
    expect(off.general.openAtLogin).toBe(false)
  })

  it('follows the setting in the installed copy', () => {
    expect(loginItemSettings(true, on)).toEqual({ openAtLogin: true })
    expect(loginItemSettings(true, off)).toEqual({ openAtLogin: false })
  })

  it('leaves the login item alone in any other copy, whatever the setting', () => {
    expect(loginItemSettings(false, on)).toBeNull()
    expect(loginItemSettings(false, off)).toBeNull()
  })
})

describe('runsFrom', () => {
  const copy = (exePath: string, inApplicationsFolder = false): CopyInfo => ({ packaged: true, inApplicationsFolder, exePath, home })

  it.each([
    ['Downloads', exe('/Users/you/Downloads/Kernel.app'), 'Downloads'],
    ['the Desktop', exe('/Users/you/Desktop/Kernel.app'), 'Desktop'],
    ['the home folder', exe('/Users/you/Kernel.app'), 'your home folder'],
    ['a disk image', exe('/Volumes/Kernel 0.4.0-arm64/Kernel.app'), 'a disk image'],
    ['a translocated copy', exe('/private/var/folders/xy/T/AppTranslocation/3F2A/d/Kernel.app'), 'a temporary copy macOS made']
  ])('names %s', (_name, exePath, place) => {
    expect(runsFrom(copy(exePath))).toBe(place)
  })

  it('is undefined in Applications, under any name, and for a dev run', () => {
    expect(runsFrom(copy(exe('/Applications/Kernel.app'), true))).toBeUndefined()
    expect(runsFrom(copy(exe('/Users/you/Applications/Kernel.app'), true))).toBeUndefined()
    expect(runsFrom(copy(exe('/Applications/Kernel Beta.app'), true))).toBeUndefined()
    expect(runsFrom({ ...copy(exe('/Users/you/Projects/kernel/node_modules/electron/dist/Electron.app')), packaged: false })).toBeUndefined()
  })
})

// KERNEL-443: a copy outside Applications asks once to move there, and moves only on a yes.
describe('offerMove', () => {
  const downloads: CopyInfo = { packaged: true, inApplicationsFolder: false, exePath: exe('/Users/you/Downloads/Kernel.app'), home }
  /** Answers each dialog with the next response, and records what it showed. */
  const setup = async (answers: number[], move: () => boolean = () => true) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-move-'))
    const shown: MessageBoxOptions[] = []
    const show = vi.fn(async (box: MessageBoxOptions) => { shown.push(box); return answers.shift() ?? 1 })
    const moves = vi.fn(move)
    const offer = (o: Partial<{ copy: CopyInfo; headless: boolean }> = {}) => offerMove({ copy: downloads, headless: false, dataDir, show, move: moves, ...o })
    return { dataDir, shown, show, moves, offer, asked: () => existsSync(join(dataDir, ASKED_FILE)) }
  }

  it('moves after a yes, and leaves the relaunched copy to decide', async () => {
    const t = await setup([0])
    expect(await t.offer()).toBe('moved')
    expect(t.shown).toHaveLength(1)
    expect(t.shown[0]).toMatchObject({ message: 'Move Kernel to Applications so it can update itself?', buttons: ['Move to Applications', "Don't move"], cancelId: 1 })
    expect(t.shown[0].detail).toContain('Kernel is running from Downloads')
    expect(t.moves).toHaveBeenCalledOnce()
    expect(t.asked()).toBe(false)
  })

  it('never moves after a no, and never asks again', async () => {
    const t = await setup([1])
    expect(await t.offer()).toBe('kept')
    expect(t.moves).not.toHaveBeenCalled()
    expect(t.asked()).toBe(true)
    expect(await t.offer()).toBe('skipped')
    expect(t.show).toHaveBeenCalledOnce()
  })

  it('keeps running when the move is cancelled, as when the user refuses to replace the copy in Applications', async () => {
    const t = await setup([0], () => false)
    expect(await t.offer()).toBe('kept')
    expect(t.moves).toHaveBeenCalledOnce()
    expect(t.asked()).toBe(true)
  })

  it('says why a move failed, keeps running and does not ask again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const t = await setup([0, 0], () => { throw new Error('Permission denied') })
    expect(await t.offer()).toBe('kept')
    expect(t.shown[1]).toMatchObject({ type: 'error', message: 'Kernel could not move to Applications' })
    expect(t.shown[1].detail).toContain('Permission denied')
    expect(t.asked()).toBe(true)
    error.mockRestore()
  })

  it('shows nothing in a dev run, a headless run, an installed copy or one that asked before', async () => {
    const t = await setup([0])
    expect(await t.offer({ copy: { ...downloads, packaged: false } })).toBe('skipped')
    expect(await t.offer({ headless: true })).toBe('skipped')
    expect(await t.offer({ copy: { ...downloads, inApplicationsFolder: true, exePath: exe('/Applications/Kernel.app') } })).toBe('skipped')
    await writeFile(join(t.dataDir, ASKED_FILE), '2026-10-12T00:00:00.000Z')
    expect(await t.offer()).toBe('skipped')
    expect(t.show).not.toHaveBeenCalled()
    expect(t.moves).not.toHaveBeenCalled()
  })
})
