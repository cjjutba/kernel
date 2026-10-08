import { describe, expect, it } from 'vitest'
import { isInstalledCopy, loginItemSettings } from '../src/main/loginItem'
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
