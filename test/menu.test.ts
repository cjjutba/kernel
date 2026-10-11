import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { appMenu } from '../src/main/menu'

// KERNEL-288: the app menu is Electron's default, built from its roles, with Help holding Copy diagnostics.
describe('the app menu', () => {
  it('keeps the standard menus, whose roles bring Cmd+C, Cmd+V and Cmd+Q', () => {
    const roles = appMenu({ copyDiagnostics: () => undefined }).map((m) => m.role)
    expect(roles).toEqual(['appMenu', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help'])
  })

  it('has Copy diagnostics under Help', () => {
    const copy = vi.fn()
    const help = appMenu({ copyDiagnostics: copy }).find((m) => m.role === 'help')!
    const item = (help.submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Copy diagnostics')!
    item.click!({} as never, undefined, {} as never)
    expect(copy).toHaveBeenCalledOnce()
  })
})
