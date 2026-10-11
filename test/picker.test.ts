import { describe, expect, it } from 'vitest'
import { lastFolder } from '../src/main/picker'

describe('lastFolder', () => {
  it("leaves the first dialog to Electron's default", () => {
    expect(lastFolder().defaultPath).toBeUndefined()
  })

  it('starts the next dialog in the folder the last pick was made from', () => {
    const folder = lastFolder()
    folder.picked(['/Users/you/Projects/kernel'])
    expect(folder.defaultPath).toBe('/Users/you/Projects')
    folder.picked(['/Users/you/Pictures/avatar.png'])
    expect(folder.defaultPath).toBe('/Users/you/Pictures')
  })

  it('keeps the last folder when a dialog is cancelled', () => {
    const folder = lastFolder()
    folder.picked(['/Users/you/Projects/kernel'])
    folder.picked([])
    expect(folder.defaultPath).toBe('/Users/you/Projects')
  })
})
